import { describe, expect, it } from "bun:test";
import {
  removeFromPackageJson,
  removeFromWorkspaceYaml,
} from "../src/rewrite.ts";

function pnpm(keys: readonly string[]) {
  return { fromPnpmOverrides: keys, fromTopLevelOverrides: [] as string[] };
}

function topLevel(keys: readonly string[]) {
  return { fromPnpmOverrides: [] as string[], fromTopLevelOverrides: keys };
}

describe("removeFromPackageJson", () => {
  it("removes the given keys from pnpm.overrides", () => {
    const before = `{
  "name": "demo",
  "pnpm": {
    "overrides": {
      "@xmldom/xmldom": ">=0.9.10",
      "postcss": ">=8.5.10",
      "keep-me": "1.0.0"
    }
  }
}
`;
    const after = removeFromPackageJson(
      before,
      pnpm(["@xmldom/xmldom", "postcss"]),
    );
    const parsed = JSON.parse(after) as Record<string, unknown>;
    const pnpmField = parsed.pnpm as Record<string, unknown>;
    const overrides = pnpmField.overrides as Record<string, unknown>;
    expect(Object.keys(overrides)).toEqual(["keep-me"]);
    expect(overrides["keep-me"]).toBe("1.0.0");
  });

  it("removes the given keys from top-level overrides", () => {
    const before = `{
  "name": "demo",
  "overrides": {
    "foo": ">=1.0.0",
    "bar": ">=2.0.0"
  }
}
`;
    const after = removeFromPackageJson(before, topLevel(["foo"]));
    const parsed = JSON.parse(after) as Record<string, unknown>;
    const overrides = parsed.overrides as Record<string, unknown>;
    expect(Object.keys(overrides)).toEqual(["bar"]);
  });

  it("removes from both containers in a single call", () => {
    const before = `{
  "pnpm": { "overrides": { "a": "1", "b": "2" } },
  "overrides": { "c": "3", "d": "4" }
}
`;
    const after = removeFromPackageJson(before, {
      fromPnpmOverrides: ["a"],
      fromTopLevelOverrides: ["d"],
    });
    const parsed = JSON.parse(after) as Record<string, unknown>;
    const pnpmField = parsed.pnpm as Record<string, unknown>;
    expect(Object.keys(pnpmField.overrides as Record<string, unknown>)).toEqual(
      ["b"],
    );
    expect(Object.keys(parsed.overrides as Record<string, unknown>)).toEqual([
      "c",
    ]);
  });

  it("preserves trailing newline when present in input", () => {
    const before = `{"pnpm":{"overrides":{"foo":">=1.0.0"}}}\n`;
    const after = removeFromPackageJson(before, pnpm(["foo"]));
    expect(after.endsWith("\n")).toBe(true);
  });

  it("omits trailing newline when input lacks one", () => {
    const before = `{"pnpm":{"overrides":{"foo":">=1.0.0"}}}`;
    const after = removeFromPackageJson(before, pnpm(["foo"]));
    expect(after.endsWith("\n")).toBe(false);
  });

  it("preserves 4-space indent when input uses it", () => {
    const before = `{
    "pnpm": {
        "overrides": {
            "foo": ">=1.0.0",
            "bar": ">=2.0.0"
        }
    }
}
`;
    const after = removeFromPackageJson(before, pnpm(["foo"]));
    expect(after).toContain('    "pnpm"');
    expect(after).toContain('        "overrides"');
  });

  it("preserves tab indent when input uses tabs", () => {
    const before =
      '{\n\t"pnpm": {\n\t\t"overrides": {\n\t\t\t"foo": ">=1.0.0"\n\t\t}\n\t}\n}\n';
    const after = removeFromPackageJson(before, pnpm(["foo"]));
    expect(after).toContain("\t");
  });

  it("returns content unchanged when both removal lists are empty", () => {
    const before = `{"pnpm":{"overrides":{"foo":">=1.0.0"}}}`;
    expect(
      removeFromPackageJson(before, {
        fromPnpmOverrides: [],
        fromTopLevelOverrides: [],
      }),
    ).toBe(before);
  });

  it("returns content unchanged when pnpm field is absent", () => {
    const before = `{"name":"x"}`;
    expect(removeFromPackageJson(before, pnpm(["foo"]))).toBe(before);
  });

  it("returns content unchanged when pnpm field is not a mapping", () => {
    const before = `{"pnpm":"oops"}`;
    expect(removeFromPackageJson(before, pnpm(["foo"]))).toBe(before);
  });

  it("returns content unchanged when pnpm.overrides is absent", () => {
    const before = `{"pnpm":{}}`;
    expect(removeFromPackageJson(before, pnpm(["foo"]))).toBe(before);
  });

  it("returns content unchanged when pnpm.overrides is not a mapping", () => {
    const before = `{"pnpm":{"overrides":"oops"}}`;
    expect(removeFromPackageJson(before, pnpm(["foo"]))).toBe(before);
  });

  it("returns content unchanged when top-level overrides is absent", () => {
    const before = `{"name":"x"}`;
    expect(removeFromPackageJson(before, topLevel(["foo"]))).toBe(before);
  });

  it("returns content unchanged when top-level overrides is not a mapping", () => {
    const before = `{"overrides":"oops"}`;
    expect(removeFromPackageJson(before, topLevel(["foo"]))).toBe(before);
  });

  it("returns content unchanged when root is not an object", () => {
    const before = `[1,2,3]`;
    expect(removeFromPackageJson(before, pnpm(["foo"]))).toBe(before);
  });

  it("leaves remaining override keys untouched and stable in order", () => {
    const before = `{
  "pnpm": {
    "overrides": {
      "a": "1",
      "b": "2",
      "c": "3"
    }
  }
}
`;
    const after = removeFromPackageJson(before, pnpm(["b"]));
    expect(after).toContain('"a": "1"');
    expect(after).toContain('"c": "3"');
    expect(after).not.toContain('"b"');
    expect(after.indexOf('"a"')).toBeLessThan(after.indexOf('"c"'));
  });
});

describe("removeFromWorkspaceYaml", () => {
  it("removes the given keys from overrides field", () => {
    const before = `overrides:
  '@xmldom/xmldom': '>=0.9.10'
  postcss: '>=8.5.10'
  keep-me: '1.0.0'
`;
    const after = removeFromWorkspaceYaml(before, [
      "@xmldom/xmldom",
      "postcss",
    ]);
    expect(after).toContain("keep-me");
    expect(after).not.toContain("@xmldom/xmldom");
    expect(after).not.toContain("postcss");
  });

  it("preserves comments and surrounding fields", () => {
    const before = `# top comment
minimumReleaseAge: 1440

overrides:
  foo: '>=1.0.0'
  bar: '>=2.0.0'

# trailing comment
`;
    const after = removeFromWorkspaceYaml(before, ["foo"]);
    expect(after).toContain("# top comment");
    expect(after).toContain("minimumReleaseAge: 1440");
    expect(after).toContain("# trailing comment");
    expect(after).toContain("bar:");
    expect(after).not.toMatch(/^\s+foo:/m);
  });

  it("returns content unchanged when keys is empty", () => {
    const before = `overrides:\n  foo: '>=1.0.0'\n`;
    expect(removeFromWorkspaceYaml(before, [])).toBe(before);
  });

  it("returns content (re-emitted) when overrides field is absent", () => {
    const before = "minimumReleaseAge: 1440\n";
    const after = removeFromWorkspaceYaml(before, ["foo"]);
    expect(after).toContain("minimumReleaseAge: 1440");
  });
});
