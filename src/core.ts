import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  entryWidth,
  formatLine,
  formatSectionHeader,
  formatSummary,
  SOURCE_ORDER,
} from "./format.ts";
import { type Lockfile, parseLockfile } from "./lockfile.ts";
import {
  buildWorkspaceDirectDeps,
  type Override,
  parsePackageJsonOverrides,
  parseWorkspaceOverrides,
  type WorkspaceDirectDeps,
  type WorkspaceFilename,
} from "./manifest.ts";
import {
  type AuditEntry,
  collectNeededRegistryPackages,
  collectPackagesForOverride,
  evaluateOverride,
} from "./pipeline.ts";
import type { PackageMetadata } from "./registry.ts";
import { createNpmRegistryClient } from "./registry-fetch.ts";
import { removeFromPackageJson, removeFromWorkspaceYaml } from "./rewrite.ts";

const WORKSPACE_FILENAMES: readonly WorkspaceFilename[] = [
  "pnpm-workspace.yaml",
  "aube-workspace.yaml",
];

const LOCKFILE_FILENAMES: readonly string[] = [
  "pnpm-lock.yaml",
  "aube-lock.yaml",
];

interface FoundFile {
  readonly path: string;
  readonly content: string;
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function findFirstExisting(
  dir: string,
  filenames: readonly string[],
): Promise<FoundFile | null> {
  for (const filename of filenames) {
    const path = join(dir, filename);
    const content = await readFileIfExists(path);
    if (content !== null) {
      return { path, content };
    }
  }
  return null;
}

async function readWorkspaceDirectDeps(
  lockfileDir: string,
  importerPaths: readonly string[],
): Promise<WorkspaceDirectDeps> {
  const importerContents = new Map<string, string>();
  await Promise.all(
    importerPaths.map(async (importerKey) => {
      const path = join(lockfileDir, importerKey, "package.json");
      const content = await readFileIfExists(path);
      if (content !== null) {
        importerContents.set(importerKey, content);
      }
    }),
  );
  return buildWorkspaceDirectDeps(importerContents);
}

function workspaceFilenameFromPath(path: string): WorkspaceFilename {
  return path.endsWith("aube-workspace.yaml")
    ? "aube-workspace.yaml"
    : "pnpm-workspace.yaml";
}

function emitError(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

async function applyFix(
  packageJsonPath: string,
  packageJsonContent: string,
  workspace: FoundFile | null,
  entries: readonly AuditEntry[],
): Promise<void> {
  const fromPnpmOverrides: string[] = [];
  const fromTopLevelOverrides: string[] = [];
  const byPnpmWorkspace: string[] = [];
  const byAubeWorkspace: string[] = [];
  for (const entry of entries) {
    if (entry.result.status !== "prune") {
      continue;
    }
    switch (entry.override.source) {
      case "package.json:pnpm.overrides":
        fromPnpmOverrides.push(entry.override.key);
        break;
      case "package.json:overrides":
        fromTopLevelOverrides.push(entry.override.key);
        break;
      case "pnpm-workspace.yaml":
        byPnpmWorkspace.push(entry.override.key);
        break;
      case "aube-workspace.yaml":
        byAubeWorkspace.push(entry.override.key);
        break;
    }
  }
  if (fromPnpmOverrides.length > 0 || fromTopLevelOverrides.length > 0) {
    const updated = removeFromPackageJson(packageJsonContent, {
      fromPnpmOverrides,
      fromTopLevelOverrides,
    });
    await writeFile(packageJsonPath, updated);
  }
  if (workspace !== null) {
    const wsName = workspaceFilenameFromPath(workspace.path);
    const keys =
      wsName === "aube-workspace.yaml" ? byAubeWorkspace : byPnpmWorkspace;
    if (keys.length > 0) {
      const updated = removeFromWorkspaceYaml(workspace.content, keys);
      await writeFile(workspace.path, updated);
    }
  }
}

export async function runAudit(
  packageJsonPath: string,
  fix: boolean,
): Promise<number> {
  const packageJsonContent = await readFileIfExists(packageJsonPath);
  if (packageJsonContent === null) {
    emitError(`file not found: ${packageJsonPath}`);
    return 2;
  }
  const dir = dirname(packageJsonPath);
  const workspace = await findFirstExisting(dir, WORKSPACE_FILENAMES);
  const lockResult = await findFirstExisting(dir, LOCKFILE_FILENAMES);
  if (lockResult === null) {
    emitError(
      `no lockfile found in ${dir} (looked for ${LOCKFILE_FILENAMES.join(", ")})`,
    );
    return 2;
  }
  let allOverrides: readonly Override[];
  let lockfile: Lockfile;
  let workspaceDirectDeps: WorkspaceDirectDeps;
  try {
    const fromPackage = parsePackageJsonOverrides(packageJsonContent);
    const fromWorkspace =
      workspace === null
        ? []
        : parseWorkspaceOverrides(
            workspace.content,
            workspaceFilenameFromPath(workspace.path),
          );
    allOverrides = [...fromPackage, ...fromWorkspace];
    lockfile = parseLockfile(lockResult.content);
    workspaceDirectDeps = await readWorkspaceDirectDeps(
      dir,
      lockfile.importerPaths,
    );
  } catch (e) {
    emitError(e instanceof Error ? e.message : "parse error");
    return 2;
  }

  // Pre-fire all registry fetches in parallel; the client caches each
  // promise, so output can stream in entry order and await only the
  // per-entry subset. A failed fetch is reported once here; the entries
  // that needed it are marked [ERROR] as they stream.
  const client = createNpmRegistryClient();
  for (const name of collectNeededRegistryPackages(allOverrides, lockfile)) {
    void client.fetchPackage(name).then((outcome) => {
      if (outcome.kind === "failed") {
        emitError(outcome.message);
      }
    });
  }

  const collectedEntries: AuditEntry[] = [];
  let prunableCount = 0;

  for (const source of SOURCE_ORDER) {
    const sectionEntries = allOverrides.filter((o) => o.source === source);
    if (sectionEntries.length === 0) {
      continue;
    }
    process.stdout.write(formatSectionHeader(source, sectionEntries.length));
    const width = entryWidth(sectionEntries);
    for (const override of sectionEntries) {
      const fetched = await Promise.all(
        collectPackagesForOverride(override, lockfile).map(async (name) => ({
          name,
          outcome: await client.fetchPackage(name),
        })),
      );
      const dataMap = new Map<string, PackageMetadata | null>();
      for (const { name, outcome } of fetched) {
        if (outcome.kind === "found") {
          dataMap.set(name, outcome.metadata);
        } else if (outcome.kind === "failed") {
          dataMap.set(name, null);
        }
      }
      const result = evaluateOverride(
        override,
        lockfile,
        workspaceDirectDeps,
        dataMap,
      );
      const entry: AuditEntry = { override, result };
      collectedEntries.push(entry);
      if (result.status === "prune") {
        prunableCount++;
      }
      process.stdout.write(formatLine(entry, width));
    }
    process.stdout.write("\n");
  }

  if (fix && prunableCount > 0) {
    await applyFix(
      packageJsonPath,
      packageJsonContent,
      workspace,
      collectedEntries,
    );
    process.stdout.write(formatSummary({ prunableCount, fixed: true }));
    return 0;
  }
  if (prunableCount > 0) {
    process.stdout.write(formatSummary({ prunableCount, fixed: false }));
    return 1;
  }
  process.stdout.write(formatSummary({ prunableCount: 0, fixed: false }));
  return 0;
}
