import { isMap, parseDocument } from "yaml";

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

export interface PackageJsonRemoval {
  readonly fromPnpmOverrides: readonly string[];
  readonly fromTopLevelOverrides: readonly string[];
}

export function removeFromPackageJson(
  content: string,
  removal: PackageJsonRemoval,
): string {
  if (
    removal.fromPnpmOverrides.length === 0 &&
    removal.fromTopLevelOverrides.length === 0
  ) {
    return content;
  }
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) {
    return content;
  }
  let modified = false;
  if (removal.fromPnpmOverrides.length > 0) {
    const pnpmField = parsed.pnpm;
    if (isObject(pnpmField)) {
      const overrides = pnpmField.overrides;
      if (isObject(overrides)) {
        for (const key of removal.fromPnpmOverrides) {
          delete overrides[key];
        }
        modified = true;
      }
    }
  }
  if (removal.fromTopLevelOverrides.length > 0) {
    const overrides = parsed.overrides;
    if (isObject(overrides)) {
      for (const key of removal.fromTopLevelOverrides) {
        delete overrides[key];
      }
      modified = true;
    }
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
