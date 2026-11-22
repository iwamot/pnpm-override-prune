import { describe, expect, it } from "bun:test";
import {
  buildRegistryConfig,
  DEFAULT_REGISTRY,
  NpmrcConfigError,
  parseNpmrc,
  registryFor,
  userNpmrcPath,
} from "../src/npmrc.ts";

describe("parseNpmrc", () => {
  it("recovers each selected setting across equivalent ini encodings", () => {
    const entries = [
      ["registry", "https://example.com/npm/?mirror=a=b"],
      ["//host/:_authToken", "abc=def"],
      ["save-exact", "true"],
      ["empty", ""],
      ["mismatched", "\"mismatched'"],
      ["unicode", "日本語 MixedCase=Value"],
    ] as const;
    for (let mask = 0; mask < 2 ** entries.length; mask++) {
      const selected = entries.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      for (const ordered of [selected, selected.toReversed()]) {
        for (const quote of ["", '"', "'"]) {
          for (const space of ["", " ", "\t"]) {
            const ignored = [
              "# ignored=value",
              "; ignored=value",
              "",
              "[section=ignored]",
              "no-equals-sign",
            ];
            const lines = [
              ...ignored,
              ...ordered.flatMap(([key, value]) => [
                `${space}${key}${space}=${space}${quote}${value}${quote}${space}`,
                ...ignored,
              ]),
            ].map((line) => space + line + space);
            for (const newline of ["\n", "\r\n"]) {
              expect(parseNpmrc(lines.join(newline), {})).toEqual(
                new Map(selected),
              );
            }
          }
        }
      }
    }
  });

  it("expands composed fragments once while preserving escaped references", () => {
    for (const env of [
      { LEFT: "https", RIGHT: "example.com" },
      { LEFT: "", RIGHT: "${MISSING}" },
      { LEFT: "$&=$1", RIGHT: "日本語\\value" },
    ]) {
      // Each fragment declares its meaning without reusing the expansion regex.
      const fragments = [
        { encoded: "literal", expanded: "literal" },
        { encoded: "${LEFT}", expanded: env.LEFT },
        { encoded: "${RIGHT}", expanded: env.RIGHT },
        { encoded: "\\${MISSING}", expanded: "${MISSING}" },
        { encoded: "\\\\${LEFT}", expanded: "\\\\" + env.LEFT },
        { encoded: "\\\\\\${MISSING}", expanded: "\\\\${MISSING}" },
        { encoded: "\\\\\\\\${RIGHT}", expanded: "\\\\\\\\" + env.RIGHT },
      ];
      for (const left of fragments) {
        for (const right of fragments) {
          for (const separator of ["", "://", "|"]) {
            const encoded = left.encoded + separator + right.encoded;
            const expected = left.expanded + separator + right.expanded;
            expect(parseNpmrc(`token=${encoded}`, env)).toEqual(
              new Map([["token", expected]]),
            );
          }
        }
      }
    }
  });

  it("fails when a referenced variable is not set", () => {
    expect(() => parseNpmrc(`token=\${MISSING}`, {})).toThrow(
      new NpmrcConfigError(
        `failed to replace env in config: token=\${MISSING}`,
      ),
    );
  });
});

describe("userNpmrcPath", () => {
  it("selects the configured path independently of key casing, home, and unrelated environment entries", () => {
    const homes = [
      ["/home/me", "/home/me/.npmrc"],
      ["/home/日本語 dir", "/home/日本語 dir/.npmrc"],
      ["/", "/.npmrc"],
    ] as const;
    for (const [home, fallback] of homes) {
      for (const key of [
        "npm_config_userconfig",
        "NPM_CONFIG_USERCONFIG",
        "NpM_CoNfIg_UsErCoNfIg",
      ]) {
        for (const [configured, expected] of [
          [undefined, fallback],
          ["", fallback],
          ["/tmp/ci/.npmrc", "/tmp/ci/.npmrc"],
          ["設定 dir/[local]#?.npmrc", "設定 dir/[local]#?.npmrc"],
        ] as const) {
          const fields = [
            ["npm_config_registry", "https://registry.example.test/"],
            ["npm_config_userconfig_extra", "wrong-suffix"],
            ["other_npm_config_userconfig", "wrong-prefix"],
            ...(configured === undefined ? [] : [[key, configured] as const]),
          ] as const;
          for (const ordered of [fields, fields.toReversed()]) {
            expect(userNpmrcPath(Object.fromEntries(ordered), home)).toBe(
              expected,
            );
          }
        }
      }
    }
  });
});

describe("buildRegistryConfig", () => {
  it("merges each key with project precedence and lets the environment select the default registry", () => {
    const settings = [
      ["registry", "https://user.example.com", "https://project.example.com/"],
      [
        "@myorg:registry",
        "https://user-scope.example.com/",
        "https://project-scope.example.com/",
      ],
      ["//host/:_authToken", "user-token", "project-token"],
      ["save-exact", "false", "true"],
    ] as const;
    const environments = [
      {},
      { npm_config_registry: "https://env.example.com" },
      { NPM_CONFIG_REGISTRY: "https://env.example.com/" },
      { NpM_CoNfIg_ReGiStRy: "https://env.example.com/" },
    ];
    for (let mask = 0; mask < 2 ** (settings.length * 2); mask++) {
      const user = Object.fromEntries(
        settings.flatMap(([key, value], index) =>
          (mask & (1 << index)) === 0 ? [] : [[key, value] as const],
        ),
      );
      const project = Object.fromEntries(
        settings.flatMap(([key, , value], index) =>
          (mask & (1 << (index + settings.length))) === 0
            ? []
            : [[key, value] as const],
        ),
      );
      // Record overlay defines precedence without sharing the merge implementation.
      const expectedEntries = { ...user, ...project };
      const fileRegistry = project.registry ?? user.registry;
      for (const [envIndex, env] of environments.entries()) {
        const expectedRegistry =
          envIndex === 0
            ? (fileRegistry?.replace(/\/$/, "") ?? DEFAULT_REGISTRY)
            : "https://env.example.com";
        for (const reversed of [false, true]) {
          const text = (entries: Record<string, string>) => {
            const pairs = Object.entries(entries);
            const lines = (reversed ? pairs.toReversed() : pairs).map(
              ([key, value]) => `${key}=${value}`,
            );
            return lines.length === 0
              ? reversed
                ? ""
                : null
              : lines.join("\n");
          };
          const config = buildRegistryConfig({
            env,
            projectNpmrc: text(project),
            userNpmrc: text(user),
          });
          expect(config.defaultRegistry).toBe(expectedRegistry);
          expect(Object.fromEntries(config.entries)).toEqual(expectedEntries);
        }
      }
    }
  });

  it("rejects a default registry that is not a URL", () => {
    expect(() =>
      buildRegistryConfig({
        env: { npm_config_registry: "not a url" },
        projectNpmrc: null,
        userNpmrc: null,
      }),
    ).toThrow(new NpmrcConfigError("invalid registry url: not a url"));
  });

  it("rejects a scope registry that is not a URL", () => {
    expect(() =>
      buildRegistryConfig({
        env: {},
        projectNpmrc: "@myorg:registry=npm.example.com/",
        userNpmrc: null,
      }),
    ).toThrow(new NpmrcConfigError("invalid registry url: npm.example.com/"));
  });

  it("leaves other settings of a scope alone", () => {
    expect(() =>
      buildRegistryConfig({
        env: {},
        projectNpmrc:
          "@myorg:always-auth=true\n@myorg:registry=https://npm.example.com/",
        userNpmrc: null,
      }),
    ).not.toThrow();
  });

  it("propagates an unset variable as a configuration error", () => {
    expect(() =>
      buildRegistryConfig({
        env: {},
        projectNpmrc: null,
        userNpmrc: `//host/:_authToken=\${MISSING}`,
      }),
    ).toThrow(NpmrcConfigError);
  });
});

describe("registryFor", () => {
  function configFrom(projectNpmrc: string, env = {}) {
    return buildRegistryConfig({ env, projectNpmrc, userNpmrc: null });
  }

  it("routes exact scopes independently of the default registry and configuration order", () => {
    const scopes = [
      ["@myorg:registry", "https://npm.example.com"],
      ["@myorg-extra:registry", "https://other.example.com/team"],
    ] as const;
    for (let mask = 0; mask < 2 ** scopes.length; mask++) {
      const selected = scopes.filter((_, index) => (mask & (1 << index)) !== 0);
      for (const [env, fallback] of [
        [{}, DEFAULT_REGISTRY],
        [
          { npm_config_registry: "https://env.example.com/" },
          "https://env.example.com",
        ],
      ] as const) {
        const org = (mask & 1) === 0 ? fallback : scopes[0][1];
        const extra = (mask & 2) === 0 ? fallback : scopes[1][1];
        for (const ordered of [selected, selected.toReversed()]) {
          const config = configFrom(
            ordered.map(([key, url]) => `${key}=${url}/`).join("\n"),
            env,
          );
          for (const [name, baseUrl] of [
            ["lodash", fallback],
            ["@myorg/pkg", org],
            ["@myorg/other", org],
            ["@myorg-extra/pkg", extra],
            ["@other/pkg", fallback],
            ["@myorg", fallback],
          ] as const) {
            expect(registryFor(name, config)).toEqual({
              baseUrl,
              authorization: null,
            });
          }
        }
      }
    }
  });

  it("selects credentials by path specificity, then bearer preference, independent of entry order", () => {
    const prefixes = ["/", "/team/", "/team/api/npm/repo/"];
    // Eligible ancestor ranks are explicit, independent of URL prefix parsing.
    const targets = [
      { path: "", ancestors: [0] },
      { path: "/team", ancestors: [1, 0] },
      { path: "/team/api/npm/repo", ancestors: [2, 1, 0] },
      { path: "/team/api/npm/repository", ancestors: [1, 0] },
      { path: "/other", ancestors: [0] },
    ];
    for (const [protocol, host] of [
      ["https", "host.example.com"],
      ["http", "host.example.com:4873"],
    ]) {
      for (let mask = 0; mask < 2 ** (prefixes.length * 2); mask++) {
        const credentials = prefixes.flatMap((prefix, rank) =>
          [
            { field: "_authToken", value: `token-${rank}`, scheme: "Bearer" },
            {
              field: "_auth",
              value: btoa(`user-${rank}:password`),
              scheme: "Basic",
            },
          ].flatMap(({ field, value, scheme }, index) =>
            (mask & (1 << (rank * 2 + index))) === 0
              ? []
              : [
                  {
                    rank,
                    line: `//${host}${prefix}:${field}=${value}`,
                    authorization: `${scheme} ${value}`,
                  },
                ],
          ),
        );
        for (const { path, ancestors } of targets) {
          const baseUrl = `${protocol}://${host}${path}`;
          const preferred = ancestors.flatMap((rank) =>
            credentials.filter((entry) => entry.rank === rank),
          );
          const expected = {
            baseUrl,
            authorization: preferred[0]?.authorization ?? null,
          };
          for (const trailingSlash of ["", "/"]) {
            const lines = [
              `registry=${baseUrl}${trailingSlash}`,
              "//other.example.com/:_authToken=foreign-host",
              "//host.example.com:9999/:_authToken=foreign-port",
              `//${host}/unrelated/:_authToken=unrelated-path`,
              ...credentials.map(({ line }) => line),
            ];
            for (const ordered of [lines, lines.toReversed()]) {
              expect(
                registryFor("lodash", configFrom(ordered.join("\n"))),
              ).toEqual(expected);
            }
          }
        }
      }
    }
  });
});
