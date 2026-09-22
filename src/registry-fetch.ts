import { setTimeout as sleep } from "node:timers/promises";
import type { RegistryTarget } from "./npmrc.ts";
import {
  type PackageMetadata,
  type PackumentForm,
  parsePackageMetadata,
  requestHeaders,
} from "./registry.ts";
import { failureMessage, REQUEST_TIMEOUT_MS, retryDelay } from "./retry.ts";

export type FetchOutcome =
  | { readonly kind: "found"; readonly metadata: PackageMetadata }
  /** The registry has no package by that name (HTTP 404). */
  | { readonly kind: "missing" }
  /** Anything else: network error, non-404 status, malformed metadata. */
  | { readonly kind: "failed"; readonly message: string };

export interface RegistryClient {
  /** Never rejects; every failure is reported through the outcome. */
  fetchPackage(name: string, form?: PackumentForm): Promise<FetchOutcome>;
}

/** Picks the registry (and credentials) that serves a package name. */
export type RegistryResolver = (name: string) => RegistryTarget;

function encodePackageName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function failed(name: string, cause: unknown, attempts: number): FetchOutcome {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { kind: "failed", message: failureMessage(name, detail, attempts) };
}

async function fetchWithRetry(
  name: string,
  target: RegistryTarget,
  form: PackumentForm,
): Promise<FetchOutcome> {
  const url = `${target.baseUrl}/${encodePackageName(name)}`;
  const headers = requestHeaders(target.authorization, form);
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      const delay = retryDelay({ kind: "thrown" }, attempt);
      if (delay === null) {
        return failed(name, cause, attempt);
      }
      await sleep(delay);
      continue;
    }
    if (response.status === 404) {
      return { kind: "missing" };
    }
    if (!response.ok) {
      const delay = retryDelay(
        { kind: "status", status: response.status },
        attempt,
      );
      if (delay === null) {
        return failed(name, `HTTP ${response.status}`, attempt);
      }
      await sleep(delay);
      continue;
    }
    try {
      const raw: unknown = await response.json();
      return { kind: "found", metadata: parsePackageMetadata(raw, name) };
    } catch (cause) {
      return failed(name, cause, attempt);
    }
  }
}

export function createNpmRegistryClient(
  registryFor: RegistryResolver,
): RegistryClient {
  const cache = new Map<string, Promise<FetchOutcome>>();
  return {
    fetchPackage(
      name: string,
      form: PackumentForm = "abbreviated",
    ): Promise<FetchOutcome> {
      const key = `${form} ${name}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const promise = (async (): Promise<FetchOutcome> => {
        try {
          return await fetchWithRetry(name, registryFor(name), form);
        } catch (cause) {
          return failed(name, cause, 1);
        }
      })();
      cache.set(key, promise);
      return promise;
    },
  };
}
