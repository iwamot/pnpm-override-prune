import { describe, expect, it } from "bun:test";
import { failureMessage, retryDelay } from "../src/retry.ts";

describe("retryDelay", () => {
  it("applies the retry schedule to transient failures and stops on other statuses", () => {
    const servers = Array.from({ length: 100 }, (_, index) => ({
      kind: "status" as const,
      status: 500 + index,
    }));
    const permanent = Array.from({ length: 200 }, (_, index) => 300 + index)
      .filter((status) => status !== 404 && status !== 429)
      .map((status) => ({ kind: "status" as const, status }));
    // 404 is handled as a missing package before the retry policy is consulted.
    const policies = [
      {
        failures: [
          { kind: "thrown" as const },
          { kind: "status" as const, status: 429 },
          ...servers,
        ],
        delays: [500, 1500, null],
      },
      { failures: permanent, delays: [null, null, null] },
    ];
    for (const { failures, delays } of policies) {
      for (const failure of failures) {
        for (const [index, delay] of delays.entries()) {
          expect(retryDelay(failure, index + 1)).toBe(delay);
        }
      }
    }
  });
});

describe("failureMessage", () => {
  it("preserves package and cause text independently of the attempt-count suffix", () => {
    const suffixes = [
      [1, ""],
      [2, " (after 2 attempts)"],
      [3, " (after 3 attempts)"],
    ] as const;
    for (const name of ["lodash", "@scope/pkg", "with-dash"]) {
      for (const detail of ["HTTP 401", "HTTP 503", "network error: 日本語"]) {
        for (const [attempts, suffix] of suffixes) {
          expect(failureMessage(name, detail, attempts)).toBe(
            `failed to fetch '${name}' from registry: ${detail}${suffix}`,
          );
        }
      }
    }
  });
});
