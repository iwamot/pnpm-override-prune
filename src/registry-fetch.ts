import type { RegistryTarget } from "./npmrc.ts";
import {
  type PackageMetadata,
  parsePackageMetadata,
  requestHeaders,
} from "./registry.ts";

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

/** Picks the registry (and credentials) that serves a package name. */
export type RegistryResolver = (name: string) => RegistryTarget;

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
  registryFor: RegistryResolver,
): RegistryClient {
  const cache = new Map<string, Promise<FetchOutcome>>();
  return {
    fetchPackage(name: string): Promise<FetchOutcome> {
      const cached = cache.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const promise = (async (): Promise<FetchOutcome> => {
        try {
          const target = registryFor(name);
          const url = `${target.baseUrl}/${encodePackageName(name)}`;
          const response = await fetch(url, {
            headers: requestHeaders(target.authorization),
          });
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
