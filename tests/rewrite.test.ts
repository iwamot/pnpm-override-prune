import { describe, expect, it } from "bun:test";
import type { PackageJsonContainer } from "../src/manifest.ts";
import {
  type PackageJsonRemoval,
  removeFromPackageJson,
  removeFromWorkspaceYaml,
} from "../src/rewrite.ts";

function only(
  container: PackageJsonContainer,
  keys: readonly string[],
): PackageJsonRemoval {
  return new Map([[container, keys]]);
}

function pnpm(keys: readonly string[]) {
  return only("package.json:pnpm.overrides", keys);
}

function topLevel(keys: readonly string[]) {
  return only("package.json:overrides", keys);
}

describe("removeFromPackageJson", () => {
  it("preserves unselected data and layout for every removal subset", () => {
    const base = {
      name: "日本語 fixture",
      scripts: { build: "keep this command" },
      dependencies: { "@scope/pkg": "5.0.0" },
      pnpm: {
        overrides: { "@scope/pkg": "1.0.0" },
        onlyBuiltDependencies: ["native-package"],
      },
      aube: { overrides: { "@scope/pkg": "2.0.0" } },
      overrides: { "@scope/pkg": "3.0.0" },
      resolutions: { "@scope/pkg": "4.0.0" },
      custom: { overrides: { "@scope/pkg": "6.0.0" } },
    };
    const layouts = [
      {
        container: "package.json:pnpm.overrides",
        wrap: (overrides: Record<string, string>) => ({
          ...base,
          pnpm: { ...base.pnpm, overrides },
        }),
      },
      {
        container: "package.json:aube.overrides",
        wrap: (overrides: Record<string, string>) => ({
          ...base,
          aube: { ...base.aube, overrides },
        }),
      },
      {
        container: "package.json:overrides",
        wrap: (overrides: Record<string, string>) => ({ ...base, overrides }),
      },
      {
        container: "package.json:resolutions",
        wrap: (resolutions: Record<string, string>) => ({
          ...base,
          resolutions,
        }),
      },
    ] satisfies {
      container: PackageJsonContainer;
      wrap: (overrides: Record<string, string>) => unknown;
    }[];
    const entries = [
      ["foo", ">=1.0.0"],
      ["@scope/pkg", "1.2.3"],
      ["parent@^1.0.0>child", ">=2.0.0"],
      ["other", "npm:aliased@^3.0.0"],
    ] as const;
    for (let mask = 0; mask < 1 << entries.length; mask++) {
      const tagged = entries.map(([key, value], index) => ({
        key,
        value,
        remove: (mask & (1 << index)) !== 0,
      }));
      const selected = tagged
        .filter((entry) => entry.remove)
        .map(({ key }) => key);
      const retained = Object.fromEntries(
        tagged
          .filter((entry) => !entry.remove)
          .map(({ key, value }) => [key, value] as const),
      );
      for (const { container, wrap } of layouts) {
        for (const indent of [undefined, 2, 4, "\t"]) {
          for (const newline of ["", "\n"]) {
            const before =
              JSON.stringify(wrap(Object.fromEntries(entries)), null, indent) +
              newline;
            const removal = new Map<PackageJsonContainer, readonly string[]>(
              layouts.map(({ container }) => [container, []] as const),
            );
            removal.set(container, selected);
            const after = removeFromPackageJson(before, removal);
            const actual: unknown = JSON.parse(after);
            // Normalize whitespace while retaining every field's value and key order.
            expect(JSON.stringify(actual)).toBe(JSON.stringify(wrap(retained)));
            expect(after.endsWith("\n")).toBe(newline === "\n");
            expect(removeFromPackageJson(after, removal)).toBe(after);
            if (selected.length === 0) {
              expect(after).toBe(before);
            } else {
              const spacing =
                typeof indent === "number"
                  ? " ".repeat(indent)
                  : (indent ?? "  ");
              expect(after).toContain(`\n${spacing}"name":`);
              expect(after).toContain(`\n${spacing.repeat(2)}"overrides":`);
            }
          }
        }
      }
    }
  });

  it("removes from both containers in a single call", () => {
    const before = `{
  "pnpm": { "overrides": { "a": "1", "b": "2" } },
  "overrides": { "c": "3", "d": "4" }
}
`;
    const after = removeFromPackageJson(
      before,
      new Map([
        ["package.json:pnpm.overrides", ["a"]],
        ["package.json:overrides", ["d"]],
      ]),
    );
    const parsed = JSON.parse(after) as Record<string, unknown>;
    const pnpmField = parsed.pnpm as Record<string, unknown>;
    expect(Object.keys(pnpmField.overrides as Record<string, unknown>)).toEqual(
      ["b"],
    );
    expect(Object.keys(parsed.overrides as Record<string, unknown>)).toEqual([
      "c",
    ]);
  });

  it("returns content unchanged when every removal list is empty", () => {
    const before = `{"pnpm":{"overrides":{"foo":">=1.0.0"}}}`;
    expect(
      removeFromPackageJson(
        before,
        new Map([
          ["package.json:pnpm.overrides", []],
          ["package.json:overrides", []],
        ]),
      ),
    ).toBe(before);
    expect(removeFromPackageJson(before, new Map())).toBe(before);
  });

  it("returns content unchanged when resolutions is absent", () => {
    const before = `{"name":"x"}`;
    expect(
      removeFromPackageJson(before, only("package.json:resolutions", ["foo"])),
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
