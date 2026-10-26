import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let buildDir: string;
let projectDir: string;
let cliPath: string;

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "pnpm-override-prune-build-"));
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/cli.ts")],
    target: "node",
    outdir: buildDir,
    naming: "cli.mjs",
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Failed to build the CLI");
  }
  cliPath = join(buildDir, "cli.mjs");
});

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "pnpm-override-prune-cli-"));
  await writeFile(join(projectDir, "package.json"), "{}");
  await writeFile(
    join(projectDir, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nimporters: {}\n",
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

async function runCli(args = [join(projectDir, "package.json")], slow = false) {
  const node = Bun.which("node");
  if (node === null) {
    throw new Error("CLI integration tests require Node.js on PATH");
  }
  const userconfig = join(projectDir, "user.npmrc");
  const child = Bun.spawn([node, cliPath, ...args], {
    cwd: projectDir,
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: userconfig,
      npm_config_userconfig: userconfig,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  if (slow) {
    // Leave enough output pending to exercise the Node pipe's backpressure.
    await sleep(100);
  }
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout, stderr: await stderr };
}

describe("CLI I/O", () => {
  it("accepts missing optional configuration files", async () => {
    expect(await runCli()).toEqual({
      code: 0,
      stdout: "No prunable entries found.\n",
      stderr: "",
    });
  });

  it("reports a missing required manifest", async () => {
    await rm(join(projectDir, "package.json"));
    const result = await runCli();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("file not found:");
    expect(result.stdout).toBe("");
  });

  // Directories produce real read errors without depending on the user's
  // privileges or replacing the filesystem with a mock.
  it.each([
    "package.json",
    "pnpm-workspace.yaml",
    "aube-workspace.yaml",
    "pnpm-lock.yaml",
    "aube-lock.yaml",
    ".npmrc",
    "user.npmrc",
  ])("reports a read error for %s", async (filename) => {
    if (filename === "aube-lock.yaml") {
      await rm(join(projectDir, "pnpm-lock.yaml"));
    }
    const path = join(projectDir, filename);
    await rm(path, { force: true });
    await mkdir(path);
    const result = await runCli();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("EISDIR");
    expect(result.stderr).toContain(filename);
    expect(result.stdout).toBe("");
  });

  it("reports a workspace importer's manifest read error", async () => {
    await writeFile(
      join(projectDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nimporters:\n  packages/app: {}\n",
    );
    await mkdir(join(projectDir, "packages/app/package.json"), {
      recursive: true,
    });
    const result = await runCli();
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("EISDIR");
    expect(result.stderr).toContain("package.json");
    expect(result.stdout).toBe("");
  });

  it("finishes writing every result before exiting with a slow pipe", async () => {
    const count = 20_000;
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({
        overrides: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`pkg-${i}`, "workspace:*"]),
        ),
      }),
    );
    const result = await runCli(undefined, true);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.match(/^\[SKIP\]/gm)).toHaveLength(count);
    expect(result.stdout).toEndWith("No prunable entries found.\n");
  });

  it.each(["--help", "--version"])(
    "prints %s without starting an audit",
    async (flag) => {
      await rm(join(projectDir, "package.json"));
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("pnpm-override-prune");
      expect(result.stderr).toBe("");
    },
  );
});
