import {
  categorize,
  classify,
  type Result,
  type SkipReason,
} from "./analyze.ts";
import { type Lockfile, parseSnapshotKey } from "./lockfile.ts";
import type { Override } from "./manifest.ts";
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
    case "protocol-spec":
      return "(protocol spec)";
    case "non-lower-bound":
      return "(non-lower-bound)";
  }
}

export function gatherSpecsForTarget(
  target: string,
  lockfile: Lockfile,
  registryData: ReadonlyMap<string, PackageMetadata>,
): readonly string[] {
  const specs: string[] = [];
  const direct = lockfile.directRequirements.get(target);
  if (direct !== undefined) {
    for (const req of direct) {
      specs.push(req.specifier);
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
      if (meta === undefined) {
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
  return specs;
}

export function evaluateOverride(
  override: Override,
  lockfile: Lockfile,
  registryData: ReadonlyMap<string, PackageMetadata>,
): Result {
  const cat = categorize(override.key, override.spec);
  if (cat.kind === "skip") {
    return { status: "skip", value: skipReasonToValue(cat.reason) };
  }
  const specs = gatherSpecsForTarget(override.key, lockfile, registryData);
  if (specs.length === 0) {
    return { status: "prune", value: "(unused)" };
  }
  const targetMeta = registryData.get(override.key);
  if (targetMeta === undefined) {
    return { status: "error", value: "(registry miss)" };
  }
  const candidates = Array.from(targetMeta.versions.keys());
  const natural = computeNaturalResolution(specs, candidates);
  return classify(override.spec, natural);
}

export function collectPackagesForOverride(
  override: Override,
  lockfile: Lockfile,
): readonly string[] {
  const cat = categorize(override.key, override.spec);
  if (cat.kind !== "target") {
    return [];
  }
  const needed = new Set<string>();
  needed.add(override.key);
  const parents = lockfile.transitiveParents.get(override.key);
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
