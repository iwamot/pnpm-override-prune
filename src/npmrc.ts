/**
 * Registry selection and credentials from npm's configuration surface: the
 * `npm_config_*` environment, the project `.npmrc`, and the user `.npmrc`.
 * Everything here is pure; callers read the files and pass the text in.
 */

import { join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export class NpmrcConfigError extends Error {
  override readonly name = "NpmrcConfigError";
  constructor(message: string) {
    super(message);
  }
}

export interface RegistryConfig {
  /** Registry for packages without a scope-specific `@scope:registry`. */
  readonly defaultRegistry: string;
  /** Merged `.npmrc` entries, project layer over user layer. */
  readonly entries: ReadonlyMap<string, string>;
}

export interface RegistryTarget {
  /** Registry origin plus path, without a trailing slash. */
  readonly baseUrl: string;
  /** Value for the `Authorization` request header, if configured. */
  readonly authorization: string | null;
}

export interface RegistryConfigInput {
  readonly env: Env;
  readonly projectNpmrc: string | null;
  readonly userNpmrc: string | null;
}

/**
 * npm reads `npm_config_<key>` case-insensitively, so `NPM_CONFIG_REGISTRY`
 * and `npm_config_registry` are the same setting.
 */
function envConfig(env: Env, key: string): string | undefined {
  const wanted = `npm_config_${key}`;
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

export function userNpmrcPath(env: Env, homeDir: string): string {
  const configured = envConfig(env, "userconfig");
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return join(homeDir, ".npmrc");
}

const ENV_EXPRESSION = /(\\*)\$\{([^${}]+)\}/g;

/**
 * Expands `${VAR}` the way npm does: an odd number of preceding backslashes
 * escapes the expression, and a variable that isn't set is a configuration
 * error rather than an empty string.
 */
function expandEnv(value: string, env: Env, line: string): string {
  return value.replace(
    ENV_EXPRESSION,
    (match, backslashes: string, name: string) => {
      if (backslashes.length % 2 === 1) {
        return match.slice(1);
      }
      const replacement = env[name];
      if (replacement === undefined) {
        throw new NpmrcConfigError(
          `failed to replace env in config: ${line.trim()}`,
        );
      }
      return backslashes + replacement;
    },
  );
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    (value.startsWith('"') || value.startsWith("'")) &&
    value.endsWith(value.charAt(0))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Minimal ini reader for `.npmrc`: `key=value` lines, `#` / `;` comments,
 * blank lines, and section headers (ignored, as npm does).
 */
export function parseNpmrc(text: string, env: Env): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("#") ||
      trimmed.startsWith(";") ||
      trimmed.startsWith("[")
    ) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = unquote(trimmed.slice(eq + 1).trim());
    entries.set(key, expandEnv(value, env, line));
  }
  return entries;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function assertRegistryUrl(value: string): void {
  try {
    new URL(value);
  } catch {
    throw new NpmrcConfigError(`invalid registry url: ${value}`);
  }
}

export function buildRegistryConfig(
  input: RegistryConfigInput,
): RegistryConfig {
  const entries = new Map<string, string>();
  // Later layers only fill keys the earlier ones left unset.
  for (const text of [input.projectNpmrc, input.userNpmrc]) {
    if (text === null) {
      continue;
    }
    for (const [key, value] of parseNpmrc(text, input.env)) {
      if (!entries.has(key)) {
        entries.set(key, value);
      }
    }
  }
  const defaultRegistry =
    envConfig(input.env, "registry") ??
    entries.get("registry") ??
    DEFAULT_REGISTRY;
  assertRegistryUrl(defaultRegistry);
  for (const [key, value] of entries) {
    if (key.startsWith("@") && key.endsWith(":registry")) {
      assertRegistryUrl(value);
    }
  }
  return { defaultRegistry: stripTrailingSlash(defaultRegistry), entries };
}

function scopeOf(name: string): string | null {
  if (!name.startsWith("@")) {
    return null;
  }
  const slash = name.indexOf("/");
  return slash === -1 ? null : name.slice(0, slash);
}

/**
 * npm's "nerf dart" for a registry: `//host/path/`. Credentials in `.npmrc`
 * are keyed by it, and the most specific path prefix that has any wins.
 */
function nerfDart(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  return `//${url.host}${url.pathname}`;
}

function authorizationFor(
  baseUrl: string,
  entries: ReadonlyMap<string, string>,
): string | null {
  let key = nerfDart(baseUrl);
  while (key.length > "//".length) {
    const token = entries.get(`${key}:_authToken`);
    if (token !== undefined) {
      return `Bearer ${token}`;
    }
    const basic = entries.get(`${key}:_auth`);
    if (basic !== undefined) {
      return `Basic ${basic}`;
    }
    key = key.replace(/([^/]+|\/)$/, "");
  }
  return null;
}

export function registryFor(
  name: string,
  config: RegistryConfig,
): RegistryTarget {
  const scope = scopeOf(name);
  const scoped =
    scope === null ? undefined : config.entries.get(`${scope}:registry`);
  const baseUrl =
    scoped === undefined ? config.defaultRegistry : stripTrailingSlash(scoped);
  return { baseUrl, authorization: authorizationFor(baseUrl, config.entries) };
}
