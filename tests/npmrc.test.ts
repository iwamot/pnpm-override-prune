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
  it("reads key=value lines and skips comments, blanks, and sections", () => {
    const text = [
      "# comment",
      "; another comment",
      "",
      "[section]",
      "registry = https://example.com/npm/",
      "no-equals-sign",
      "save-exact=true",
    ].join("\n");
    expect(parseNpmrc(text, {})).toEqual(
      new Map([
        ["registry", "https://example.com/npm/"],
        ["save-exact", "true"],
      ]),
    );
  });

  it("handles CRLF line endings", () => {
    expect(parseNpmrc("a=1\r\nb=2\r\n", {})).toEqual(
      new Map([
        ["a", "1"],
        ["b", "2"],
      ]),
    );
  });

  it("strips matching surrounding quotes from values", () => {
    const text = ['a="quoted"', "b='single'", "c=\"mismatched'", 'd=""'].join(
      "\n",
    );
    expect(parseNpmrc(text, {})).toEqual(
      new Map([
        ["a", "quoted"],
        ["b", "single"],
        ["c", "\"mismatched'"],
        ["d", ""],
      ]),
    );
  });

  it("keeps everything after the first equals sign in the value", () => {
    expect(parseNpmrc("//host/:_authToken=abc=def", {})).toEqual(
      new Map([["//host/:_authToken", "abc=def"]]),
    );
  });

  it("expands a variable reference from the environment", () => {
    const entries = parseNpmrc(`//host/:_authToken=\${NPM_TOKEN}`, {
      NPM_TOKEN: "secret",
    });
    expect(entries.get("//host/:_authToken")).toBe("secret");
  });

  it("expands several variables inside one value", () => {
    const entries = parseNpmrc(`registry=\${SCHEME}://\${HOST}/`, {
      SCHEME: "https",
      HOST: "example.com",
    });
    expect(entries.get("registry")).toBe("https://example.com/");
  });

  it("treats a backslash-escaped expression as literal text", () => {
    const entries = parseNpmrc(`a=\\\${NOT_A_VAR}\nb=\\\\\${VAR}`, {
      VAR: "x",
    });
    expect(entries.get("a")).toBe(`\${NOT_A_VAR}`);
    expect(entries.get("b")).toBe("\\\\x");
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
  it("defaults to .npmrc in the home directory", () => {
    expect(userNpmrcPath({}, "/home/me")).toBe("/home/me/.npmrc");
  });

  it("honors npm_config_userconfig", () => {
    expect(
      userNpmrcPath({ npm_config_userconfig: "/tmp/ci/.npmrc" }, "/home/me"),
    ).toBe("/tmp/ci/.npmrc");
  });

  it("matches the environment key case-insensitively", () => {
    expect(
      userNpmrcPath({ NPM_CONFIG_USERCONFIG: "/tmp/ci/.npmrc" }, "/home/me"),
    ).toBe("/tmp/ci/.npmrc");
  });

  it("ignores an empty override", () => {
    expect(userNpmrcPath({ npm_config_userconfig: "" }, "/home/me")).toBe(
      "/home/me/.npmrc",
    );
  });
});

describe("buildRegistryConfig", () => {
  it("falls back to the public registry with no configuration", () => {
    const config = buildRegistryConfig({
      env: {},
      projectNpmrc: null,
      userNpmrc: null,
    });
    expect(config.defaultRegistry).toBe(DEFAULT_REGISTRY);
    expect(config.entries.size).toBe(0);
  });

  it("prefers the environment over the project and user files", () => {
    const config = buildRegistryConfig({
      env: { NPM_CONFIG_REGISTRY: "https://env.example.com/" },
      projectNpmrc: "registry=https://project.example.com/",
      userNpmrc: "registry=https://user.example.com/",
    });
    expect(config.defaultRegistry).toBe("https://env.example.com");
  });

  it("prefers the project file over the user file", () => {
    const config = buildRegistryConfig({
      env: {},
      projectNpmrc: "registry=https://project.example.com/",
      userNpmrc: "registry=https://user.example.com/",
    });
    expect(config.defaultRegistry).toBe("https://project.example.com");
  });

  it("uses the user file when the project file has no registry", () => {
    const config = buildRegistryConfig({
      env: {},
      projectNpmrc: "save-exact=true",
      userNpmrc: "registry=https://user.example.com",
    });
    expect(config.defaultRegistry).toBe("https://user.example.com");
    expect(config.entries.get("save-exact")).toBe("true");
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

  it("uses the default registry without credentials", () => {
    expect(registryFor("lodash", configFrom(""))).toEqual({
      baseUrl: DEFAULT_REGISTRY,
      authorization: null,
    });
  });

  it("routes a scoped package to its scope registry", () => {
    const config = configFrom("@myorg:registry=https://npm.example.com/");
    expect(registryFor("@myorg/pkg", config).baseUrl).toBe(
      "https://npm.example.com",
    );
    expect(registryFor("lodash", config).baseUrl).toBe(DEFAULT_REGISTRY);
    expect(registryFor("@other/pkg", config).baseUrl).toBe(DEFAULT_REGISTRY);
  });

  it("does not treat a bare @name without a slash as scoped", () => {
    const config = configFrom("@weird:registry=https://npm.example.com/");
    expect(registryFor("@weird", config).baseUrl).toBe(DEFAULT_REGISTRY);
  });

  it("lets the scope registry win over an environment default", () => {
    const config = configFrom("@myorg:registry=https://npm.example.com/", {
      npm_config_registry: "https://env.example.com/",
    });
    expect(registryFor("@myorg/pkg", config).baseUrl).toBe(
      "https://npm.example.com",
    );
    expect(registryFor("lodash", config).baseUrl).toBe(
      "https://env.example.com",
    );
  });

  it("sends a bearer token configured for the registry host", () => {
    const config = configFrom(
      [
        "registry=https://npm.example.com/",
        "//npm.example.com/:_authToken=tok",
      ].join("\n"),
    );
    expect(registryFor("lodash", config).authorization).toBe("Bearer tok");
  });

  it("sends basic credentials configured with _auth", () => {
    const config = configFrom(
      [
        "registry=https://npm.example.com/",
        "//npm.example.com/:_auth=dXM6cHc=",
      ].join("\n"),
    );
    expect(registryFor("lodash", config).authorization).toBe("Basic dXM6cHc=");
  });

  it("picks the most specific path prefix that has credentials", () => {
    const config = configFrom(
      [
        "registry=https://host.example.com/artifactory/api/npm/npm-virtual/",
        "//host.example.com/:_authToken=host-wide",
        "//host.example.com/artifactory/api/npm/:_authToken=all-repos",
        "//host.example.com/artifactory/api/npm/npm-virtual/:_authToken=this-repo",
      ].join("\n"),
    );
    expect(registryFor("lodash", config).authorization).toBe(
      "Bearer this-repo",
    );
  });

  it("walks up to a shorter path prefix when the full one has none", () => {
    const config = configFrom(
      [
        "registry=https://host.example.com/artifactory/api/npm/npm-virtual",
        "//host.example.com/artifactory/:_authToken=under-artifactory",
      ].join("\n"),
    );
    expect(registryFor("lodash", config).authorization).toBe(
      "Bearer under-artifactory",
    );
  });

  it("does not send credentials configured for another host", () => {
    const config = configFrom(
      [
        "registry=https://npm.example.com/",
        "//other.example.com/:_authToken=tok",
      ].join("\n"),
    );
    expect(registryFor("lodash", config).authorization).toBeNull();
  });

  it("keeps a port as part of the host", () => {
    const config = configFrom(
      [
        "registry=http://localhost:4873/",
        "//localhost:4873/:_authToken=tok",
      ].join("\n"),
    );
    expect(registryFor("lodash", config)).toEqual({
      baseUrl: "http://localhost:4873",
      authorization: "Bearer tok",
    });
  });
});
