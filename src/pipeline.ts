import { intersects } from "semver";
import {
  categorize,
  classify,
  hasProtocolPrefix,
  type Result,
  type SkipReason,
} from "./analyze.ts";
import { type Lockfile, parseSnapshotKey } from "./lockfile.ts";
import type { Override, WorkspaceDirectDeps } from "./manifest.ts";
import type { PackageMetadata } from "./registry.ts";
import { computeNaturalResolution } from "./resolve.ts";

export interface AuditEntry {
  readonly override: Override;
  readonly result: Result;
}

function skipReasonToValue(reason: SkipReason): string {
  switch (reason) {
    case "nested-key":
      return "(nested key)";
    case "unsupported-selector":
      return "(unsupported selector)";
    case "protocol-spec":
      return "(protocol spec)";
    case "non-lower-bound":
      return "(non-lower-bound)";
  }
}

/**
 * Registry metadata keyed by package name. A package the registry doesn't
 * know is absent; a package whose fetch failed for any other reason maps to
 * `null`, so the failure can't pass for "no constraint".
 */
export type RegistryData = ReadonlyMap<string, PackageMetadata | null>;

export interface GatheredSpecs {
  /** Semver specs that constrain the target without the override applied. */
  readonly specs: readonly string[];
  /**
   * Direct importer specs using a non-semver protocol (`catalog:`,
   * `workspace:`, ...). They do constrain the target, but the tool cannot
   * turn them into a range, so the natural resolution is unknowable.
   */
  readonly protocolSpecs: readonly string[];
}

export function gatherSpecsForTarget(
  target: string,
  lockfile: Lockfile,
  workspaceDirectDeps: WorkspaceDirectDeps,
  registryData: RegistryData,
): GatheredSpecs {
  const specs: string[] = [];
  const protocolSpecs: string[] = [];
  const direct = workspaceDirectDeps.get(target);
  if (direct !== undefined) {
    for (const dep of direct) {
      if (hasProtocolPrefix(dep.spec)) {
        protocolSpecs.push(dep.spec);
        continue;
      }
      specs.push(dep.spec);
    }
  }
  const parents = lockfile.transitiveParents.get(target);
  if (parents !== undefined) {
    for (const parent of parents) {
      const parsed = parseSnapshotKey(parent.parentKey);
      if (parsed === null) {
        continue;
      }
      const meta = registryData.get(parsed.name);
      if (meta === undefined || meta === null) {
        continue;
      }
      const versionMeta = meta.versions.get(parsed.version);
      if (versionMeta === undefined) {
        continue;
      }
      const spec = versionMeta.dependencies.get(target);
      if (spec === undefined) {
        continue;
      }
      specs.push(spec);
    }
  }
  return { specs, protocolSpecs };
}

function protocolOf(spec: string): string {
  const colon = spec.indexOf(":");
  return colon === -1 ? spec : spec.slice(0, colon + 1);
}

export function evaluateOverride(
  override: Override,
  lockfile: Lockfile,
  workspaceDirectDeps: WorkspaceDirectDeps,
  registryData: RegistryData,
): Result {
  const cat = categorize(override.key, override.spec);
  if (cat.kind === "skip") {
    return { status: "skip", value: skipReasonToValue(cat.reason) };
  }
  // A verdict computed without a parent's constraints would describe a
  // different tree, so a fetch failure is an error rather than a guess.
  const failed = packagesForTarget(cat.name, lockfile).filter(
    (name) => registryData.get(name) === null,
  );
  if (failed.length > 0) {
    return { status: "error", value: `(fetch failed: ${failed.join(", ")})` };
  }
  const { specs: allSpecs, protocolSpecs } = gatherSpecsForTarget(
    cat.name,
    lockfile,
    workspaceDirectDeps,
    registryData,
  );
  // A protocol-prefixed direct dep still constrains the target, but its
  // range is not visible here. Any verdict computed from the remaining
  // specs would describe a different tree, so leave it for human review.
  if (protocolSpecs.length > 0) {
    const protocols = Array.from(new Set(protocolSpecs.map(protocolOf)));
    return {
      status: "skip",
      value: `(constrained by ${protocols.join(", ")} spec)`,
    };
  }
  if (allSpecs.length === 0) {
    return { status: "prune", value: "(unused)" };
  }
  // pnpm fires a versioned-key override on parents whose requested spec
  // intersects the selector range (see pnpm/pnpm#6904). Drop parent specs
  // that don't intersect — the override is inert for them.
  const selector = cat.selector;
  const specs =
    selector === null
      ? allSpecs
      : allSpecs.filter((s) => {
          try {
            return intersects(s, selector);
          } catch {
            return false;
          }
        });
  if (specs.length === 0) {
    return { status: "prune", value: "(selector miss)" };
  }
  const targetMeta = registryData.get(cat.name);
  if (targetMeta === undefined || targetMeta === null) {
    return { status: "error", value: "(registry miss)" };
  }
  const candidates = Array.from(targetMeta.versions.keys());
  const natural = computeNaturalResolution(specs, candidates);
  return classify(override.spec, natural);
}

function packagesForTarget(
  target: string,
  lockfile: Lockfile,
): readonly string[] {
  const needed = new Set<string>();
  needed.add(target);
  const parents = lockfile.transitiveParents.get(target);
  if (parents !== undefined) {
    for (const parent of parents) {
      const parsed = parseSnapshotKey(parent.parentKey);
      if (parsed !== null) {
        needed.add(parsed.name);
      }
    }
  }
  return Array.from(needed);
}

export function collectPackagesForOverride(
  override: Override,
  lockfile: Lockfile,
): readonly string[] {
  const cat = categorize(override.key, override.spec);
  if (cat.kind !== "target") {
    return [];
  }
  return packagesForTarget(cat.name, lockfile);
}

export function collectNeededRegistryPackages(
  overrides: readonly Override[],
  lockfile: Lockfile,
): readonly string[] {
  const needed = new Set<string>();
  for (const override of overrides) {
    for (const name of collectPackagesForOverride(override, lockfile)) {
      needed.add(name);
    }
  }
  return Array.from(needed);
}
