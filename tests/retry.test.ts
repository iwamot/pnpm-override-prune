import { describe, expect, it } from "bun:test";
import { failureMessage, retryDelay } from "../src/retry.ts";

describe("retryDelay", () => {
  it("retries a thrown fetch with a growing pause, then gives up", () => {
    expect(retryDelay({ kind: "thrown" }, 1)).toBe(500);
    expect(retryDelay({ kind: "thrown" }, 2)).toBe(1500);
    expect(retryDelay({ kind: "thrown" }, 3)).toBeNull();
  });

  it("retries server errors and rate limiting", () => {
    expect(retryDelay({ kind: "status", status: 500 }, 1)).toBe(500);
    expect(retryDelay({ kind: "status", status: 503 }, 2)).toBe(1500);
    expect(retryDelay({ kind: "status", status: 429 }, 1)).toBe(500);
    expect(retryDelay({ kind: "status", status: 503 }, 3)).toBeNull();
  });

  it("does not retry other client errors", () => {
    expect(retryDelay({ kind: "status", status: 401 }, 1)).toBeNull();
    expect(retryDelay({ kind: "status", status: 403 }, 1)).toBeNull();
    expect(retryDelay({ kind: "status", status: 400 }, 1)).toBeNull();
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
