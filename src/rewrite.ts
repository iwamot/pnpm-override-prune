import { isMap, parseDocument } from "yaml";
import {
  PACKAGE_JSON_CONTAINERS,
  type PackageJsonContainer,
  packageJsonMappingAt,
} from "./manifest.ts";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function detectJsonIndent(content: string): string | number {
  const match = content.match(/^([\t ]+)/m);
  if (match !== null) {
    return match[1] ?? 2;
  }
  return 2;
}

export type PackageJsonRemoval = ReadonlyMap<
  PackageJsonContainer,
  readonly string[]
>;

export function removeFromPackageJson(
  content: string,
  removal: PackageJsonRemoval,
): string {
  if ([...removal.values()].every((keys) => keys.length === 0)) {
    return content;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) {
    return content;
  }
  let modified = false;
  for (const [container, keys] of removal) {
    if (keys.length === 0) {
      continue;
    }
    const path = PACKAGE_JSON_CONTAINERS.get(container);
    if (path === undefined) {
      continue;
    }
    const mapping = packageJsonMappingAt(parsed, path);
    if (mapping === null) {
      continue;
    }
    for (const key of keys) {
      delete mapping[key];
    }
    modified = true;
  }
  if (!modified) {
    return content;
  }
  const indent = detectJsonIndent(content);
  const trailingNewline = content.endsWith("\n") ? "\n" : "";
  return JSON.stringify(parsed, null, indent) + trailingNewline;
}

export function removeFromWorkspaceYaml(
  content: string,
  keys: readonly string[],
): string {
  if (keys.length === 0) {
    return content;
  }
  const doc = parseDocument(content);
  const overridesNode = doc.get("overrides", true);
  if (!isMap(overridesNode)) {
    return content;
  }
  for (const key of keys) {
    overridesNode.delete(key);
  }
  return doc.toString();
}
