/**
 * Retry policy for registry requests. Pure: the fetch loop asks whether a
 * failed attempt should be retried and how long to wait first.
 */

/** Wall-clock budget for one attempt, including reading the body. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Pause before the second and third attempts. Its length caps the attempts. */
const RETRY_DELAYS_MS: readonly number[] = [500, 1500];

export type AttemptResult =
  /** The registry answered with a non-2xx status other than 404. */
  | { readonly kind: "status"; readonly status: number }
  /** fetch rejected: network error, timeout, or abort. */
  | { readonly kind: "thrown" };

function isTransient(result: AttemptResult): boolean {
  if (result.kind === "thrown") {
    return true;
  }
  return result.status >= 500 || result.status === 429;
}

/**
 * Milliseconds to wait before retrying after the given attempt (1-based),
 * or null when the failure is final: a non-transient status, or the last
 * attempt already made.
 */
export function retryDelay(
  result: AttemptResult,
  attempt: number,
): number | null {
  if (!isTransient(result)) {
    return null;
  }
  return RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export function failureMessage(
  name: string,
  detail: string,
  attempts: number,
): string {
  const suffix = attempts > 1 ? ` (after ${attempts} attempts)` : "";
  return `failed to fetch '${name}' from registry: ${detail}${suffix}`;
}
