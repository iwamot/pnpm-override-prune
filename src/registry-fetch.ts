import { type PackageMetadata, parsePackageMetadata } from "./registry.ts";

export interface RegistryClient {
  fetchPackage(name: string): Promise<PackageMetadata>;
}

export interface RegistryClientOptions {
  readonly baseUrl?: string;
}

export class RegistryFetchError extends Error {
  override readonly name = "RegistryFetchError";
  readonly packageName: string;
  constructor(packageName: string, cause: unknown) {
    super(
      `failed to fetch '${packageName}' from registry: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.packageName = packageName;
  }
}

function encodePackageName(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

export function createNpmRegistryClient(
  options: RegistryClientOptions = {},
): RegistryClient {
  const baseUrl = options.baseUrl ?? "https://registry.npmjs.org";
  const cache = new Map<string, Promise<PackageMetadata>>();
  return {
    fetchPackage(name: string): Promise<PackageMetadata> {
      const cached = cache.get(name);
      if (cached !== undefined) {
        return cached;
      }
      const promise = (async () => {
        const url = `${baseUrl}/${encodePackageName(name)}`;
        let response: Response;
        try {
          response = await fetch(url);
        } catch (cause) {
          throw new RegistryFetchError(name, cause);
        }
        if (!response.ok) {
          throw new RegistryFetchError(
            name,
            new Error(`HTTP ${response.status}`),
          );
        }
        const raw: unknown = await response.json();
        return parsePackageMetadata(raw, name);
      })();
      cache.set(name, promise);
      return promise;
    },
  };
}
