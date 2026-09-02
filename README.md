# pnpm-override-prune

[![npm](https://img.shields.io/npm/v/pnpm-override-prune.svg)](https://www.npmjs.com/package/pnpm-override-prune)
[![node](https://img.shields.io/node/v/pnpm-override-prune.svg)](https://www.npmjs.com/package/pnpm-override-prune)

Detect prunable override entries in pnpm / [aube](https://github.com/jdx/aube) projects.

## Usage

```bash
# Detect prunable entries (default)
pnpm dlx pnpm-override-prune                          # checks ./package.json
pnpm dlx pnpm-override-prune path/to/package.json     # checks given file

# Remove prunable entries in place
pnpm dlx pnpm-override-prune --fix
```

For aube users, replace `pnpm dlx` with `aube dlx`.

Example output:

```
=== package.json:pnpm.overrides (2 entries) ===
[PRUNE] @xmldom/xmldom >=0.9.10  0.9.10
[PRUNE] postcss >=8.5.10         8.5.12

Run with --fix to prune entries marked [PRUNE].
```

Exit codes:

| Code | Meaning |
|------|---------|
| `0`  | No prunable entries (or `--fix` succeeded) |
| `1`  | Prunable entries found (without `--fix`) |
| `2`  | `package.json` or lockfile not found, parse error, or an entry marked `[ERROR]` (the audit is incomplete, even when other entries were pruned) |

## Why

pnpm and aube let you pin a transitive dependency version via override entries — in `package.json` (`pnpm.overrides`, `aube.overrides`, top-level `overrides`, or Yarn-style `resolutions`) or in `pnpm-workspace.yaml` / `aube-workspace.yaml` (top-level `overrides:`).

A common reason to reach for these is CVE mitigation: a vulnerability is disclosed in a transitive package, and you force the patched minimum version while direct deps catch up.

Once they do, the entry is no longer doing anything — but it's easy to forget which ones are still load-bearing. Stale overrides become a judgment cost at every audit or upgrade ("is this still needed, or just history?").

`pnpm-override-prune` answers that mechanically: it checks whether each entry's lower bound is already satisfied by what the npm registry would resolve without the override.

## How it works

For each override target, the tool gathers the specs that constrain it without the override applied:

- direct importer specs read from each workspace `package.json` (the lockfile's importer specifiers are skipped because pnpm rewrites them to the override value)
- parent-package metadata fetched from `https://registry.npmjs.org` for transitive parents

For each spec it computes the highest published version that spec would resolve to on its own. The reported version is the **lowest** of those — the worst case some consumer would land on if the override were removed. If that version already meets the override's lower bound, the entry is `[PRUNE]`; otherwise `[KEEP]`.

## Scope

- Reads override entries from:
  - `package.json` &rarr; `pnpm.overrides`
  - `package.json` &rarr; top-level `overrides` (npm-compatible form, also used by `aube audit --fix`)
  - `package.json` &rarr; `aube.overrides` (read by aube)
  - `package.json` &rarr; `resolutions` (Yarn-compatible form, read by pnpm 9/10 and aube)
  - `pnpm-workspace.yaml` or `aube-workspace.yaml` &rarr; top-level `overrides:`
- When a key appears in more than one of these locations, each is reported independently. Which one wins at install time depends on the package manager, but stale duplicates in the other locations are easy to overlook.
- Only specifiers using `>=` and/or `>` are checked. Exact pins (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`), and bounded ranges are skipped — removing an intentional upper bound is unsafe.
- Versioned keys like `"glob-parent@<5.1.2": ">=5.1.2"` (the form `pnpm audit --fix` typically emits) are evaluated. The selector is matched against each parent's requested spec via [`semver.intersects`](https://github.com/npm/node-semver#ranges-1) — the rule pnpm itself uses since [pnpm/pnpm#6904](https://github.com/pnpm/pnpm/pull/6904).
- Lockfile must be `pnpm-lock.yaml` or `aube-lock.yaml` at `lockfileVersion: '9.0'` (pnpm 9+ / aube). Older formats are not supported in this release.

## Known limitations

- Skips values using non-semver protocols (`catalog:`, `workspace:`, `file:`, `link:`, `portal:`, `npm:`, `github:`, `git`-prefixed, `http:` / `https:`).
- Skips entries whose target is a direct dependency declared with such a protocol in any workspace `package.json` (e.g. `"lodash": "catalog:"`), reported as `[SKIP] (constrained by catalog: spec)`. That spec does constrain the target, but its range isn't visible to the tool, so no verdict is computed rather than treating the entry as unused.
- Skips nested-key overrides like `"parent>child": "1.2.3"`, including npm's object form `"parent": { "child": "1.2.3" }` (reported as `parent>child`). Only flat `name &rarr; spec` mappings are evaluated.
- Skips versioned keys whose selector isn't a parseable semver range (e.g., `"foo@latest": ">=1.0.0"`). pnpm itself falls back to literal-string matching for such selectors, so they're rarely effective; verdict is left for human review.
- Each override entry is evaluated independently. When multiple entries target the same package (e.g., several `lodash@...` rows from cumulative `pnpm audit --fix` runs), the tool won't propose consolidating them into a single stronger entry — it only marks each one prunable when its own selector/spec combination is a no-op against the natural resolution.
- Public npm registry only. Private registries and `.npmrc` scoped registry configuration are not consulted.
- Parents that the public registry doesn't know (HTTP 404) — e.g. workspace-internal packages resolved as transitive parents — are silently dropped from the constraint set. The natural resolution may then appear less constrained than it actually is. Any other fetch failure (network error, non-404 status, malformed metadata) marks the entry `[ERROR] (fetch failed: <package>)` instead of judging it, so a flaky connection can't make an override look unused.

## License

MIT
