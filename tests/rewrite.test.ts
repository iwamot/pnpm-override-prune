import { describe, expect, it } from "bun:test";
import { parse } from "yaml";
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
              expect(removeFromPackageJson(before, new Map())).toBe(before);
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

  it("removes independently from every combination of JSON containers in one call", () => {
    const containers = [
      "package.json:pnpm.overrides",
      "package.json:aube.overrides",
      "package.json:overrides",
      "package.json:resolutions",
    ] as const;
    const before = JSON.stringify({
      pnpm: { overrides: { a: "1", b: "2" } },
      aube: { overrides: { c: "3", d: "4" } },
      overrides: { e: "5", f: "6" },
      resolutions: { g: "7", h: "8" },
      custom: { a: "keep" },
    });
    for (let mask = 0; mask < 2 ** containers.length; mask++) {
      const keys = ["a", "d", "f", "g"] as const;
      const removals = containers.map(
        (container, index) =>
          [
            container,
            (mask & (1 << index)) !== 0 ? [keys[index]!] : [],
          ] as const,
      );
      const expected = {
        pnpm: { overrides: (mask & 1) !== 0 ? { b: "2" } : { a: "1", b: "2" } },
        aube: { overrides: (mask & 2) !== 0 ? { c: "3" } : { c: "3", d: "4" } },
        overrides: (mask & 4) !== 0 ? { e: "5" } : { e: "5", f: "6" },
        resolutions: (mask & 8) !== 0 ? { h: "8" } : { g: "7", h: "8" },
        custom: { a: "keep" },
      };
      for (const ordered of [removals, removals.toReversed()]) {
        expect(
          JSON.parse(removeFromPackageJson(before, new Map(ordered))),
        ).toEqual(expected);
      }
    }
  });

  it("preserves the exact JSON bytes when the requested container cannot be rewritten", () => {
    const nonMappings = [null, [], ["array-entry"], 42, "oops", true];
    const documents: unknown[] = [...nonMappings];
    for (const value of [undefined, ...nonMappings]) {
      documents.push(
        ...[
          { overrides: value },
          { pnpm: value },
          { pnpm: { overrides: value } },
          { aube: value },
          { aube: { overrides: value } },
          { resolutions: value },
        ],
      );
    }
    for (const document of documents) {
      for (const indent of [undefined, 2, "\t"]) {
        for (const newline of ["", "\n"]) {
          const before = JSON.stringify(document, null, indent) + newline;
          for (const container of [
            "package.json:pnpm.overrides",
            "package.json:aube.overrides",
            "package.json:overrides",
            "package.json:resolutions",
          ] as const) {
            expect(
              removeFromPackageJson(before, only(container, ["foo"])),
            ).toBe(before);
          }
        }
      }
    }
  });
});

describe("removeFromWorkspaceYaml", () => {
  it("removes every selected subset while preserving other settings and comments", () => {
    const entries = [
      ["foo", ">=1.0.0"],
      ["@scope/pkg", ">=2.0.0"],
      ["parent@^1>child", "npm:aliased@^3.0.0"],
      ["日本語", "4.0.0"],
    ] as const;
    for (let mask = 0; mask < 2 ** entries.length; mask++) {
      const selected = entries.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const retained = entries.filter(
        (_, index) => (mask & (1 << index)) === 0,
      );
      const expected = {
        minimumReleaseAge: 1440,
        packages: ["apps/*"],
        custom: { overrides: Object.fromEntries(entries) },
        overrides: Object.fromEntries(retained),
      };
      const pairs = entries.map(
        ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
      );
      for (const mapping of [
        `overrides:\n${pairs.map((pair) => `  ${pair}`).join("\n")}`,
        `overrides: { ${pairs.join(", ")} }`,
      ]) {
        for (const newline of ["", "\n"]) {
          const before =
            [
              "# workspace settings",
              "minimumReleaseAge: 1440",
              "packages: [apps/*]",
              `custom: ${JSON.stringify({ overrides: Object.fromEntries(entries) })}`,
              mapping,
              "# end of workspace",
            ].join("\n") + newline;
          const keys = selected.map(([key]) => key);
          const after = removeFromWorkspaceYaml(before, keys);
          const actual: unknown = parse(after);
          expect(actual).toEqual(expected);
          expect(after).toContain("# workspace settings");
          expect(after).toContain("# end of workspace");
          expect(removeFromWorkspaceYaml(after, keys)).toBe(after);
          if (keys.length === 0) {
            expect(after).toBe(before);
          }
          // Removal order, repeated keys, and missing keys have no semantic effect.
          const reordered: unknown = parse(
            removeFromWorkspaceYaml(before, [
              ...keys.toReversed(),
              ...keys,
              "not-present",
            ]),
          );
          expect(reordered).toEqual(expected);
        }
      }
    }
  });

  it("preserves exact YAML bytes when overrides are absent or not a mapping", () => {
    for (const overrides of [
      "",
      "overrides: oops\n",
      "overrides: []\n",
      "overrides: null\n",
      "overrides: 42\n",
    ]) {
      for (const newline of ["\n", "\r\n"]) {
        const before = (
          "# workspace settings\nminimumReleaseAge: 1440\n" + overrides
        ).replaceAll("\n", newline);
        expect(removeFromWorkspaceYaml(before, ["foo", "@scope/pkg"])).toBe(
          before,
        );
        expect(removeFromWorkspaceYaml(before, [])).toBe(before);
      }
    }
  });
});
