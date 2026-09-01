import { type PackageMetadata, parsePackageMetadata } from "./registry.ts";

export type FetchOutcome =
  | { readonly kind: "found"; readonly metadata: PackageMetadata }
  /** The registry has no package by that name (HTTP 404). */
  | { readonly kind: "missing" }
  /** Anything else: network error, non-404 status, malformed metadata. */
  | { readonly kind: "failed"; readonly message: string };

export interface RegistryClient {
  /** Never rejects; every failure is reported through the outcome. */
  fetchPackage(name: string): Promise<FetchOutcome>;
}

export interface RegistryClientOptions {
  readonly baseUrl?: string;
}

function encodePackageName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function failed(name: string, cause: unknown): FetchOutcome {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    kind: "failed",
    message: `failed to fetch '${name}' from registry: ${detail}`,
  };
}

export function createNpmRegistryClient(
  options: RegistryClientOptions = {},
): RegistryClient {
  const baseUrl = options.baseUrl ?? "https://registry.npmjs.org";
  const cache = new Map<string, Promise<FetchOutcome>>();
  return {
    fetchPackage(name: string): Promise<FetchOutcome> {
      const cached = cache.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const promise = (async (): Promise<FetchOutcome> => {
        const url = `${baseUrl}/${encodePackageName(name)}`;
        try {
          const response = await fetch(url);
          if (response.status === 404) {
            return { kind: "missing" };
          }
          if (!response.ok) {
            return failed(name, `HTTP ${response.status}`);
          }
          const raw: unknown = await response.json();
          return { kind: "found", metadata: parsePackageMetadata(raw, name) };
        } catch (cause) {
          return failed(name, cause);
        }
      })();
      cache.set(name, promise);
      return promise;
    },
  };
}
