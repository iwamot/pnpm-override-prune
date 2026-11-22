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
  it("names the package and the cause", () => {
    expect(failureMessage("lodash", "HTTP 401", 1)).toBe(
      "failed to fetch 'lodash' from registry: HTTP 401",
    );
  });

  it("counts the attempts when the failure survived retries", () => {
    expect(failureMessage("lodash", "HTTP 503", 3)).toBe(
      "failed to fetch 'lodash' from registry: HTTP 503 (after 3 attempts)",
    );
  });
});
