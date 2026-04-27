# pnpm-override-prune

[![Validate](https://github.com/iwamot/pnpm-override-prune/actions/workflows/validate.yml/badge.svg)](https://github.com/iwamot/pnpm-override-prune/actions/workflows/validate.yml)
[![codecov](https://codecov.io/gh/iwamot/pnpm-override-prune/graph/badge.svg)](https://codecov.io/gh/iwamot/pnpm-override-prune)
[![npm](https://img.shields.io/npm/v/pnpm-override-prune.svg)](https://www.npmjs.com/package/pnpm-override-prune)
[![Node](https://img.shields.io/node/v/pnpm-override-prune.svg)](https://www.npmjs.com/package/pnpm-override-prune)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Detect prunable override entries in pnpm / [aube](https://github.com/endevco/aube) projects.

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
| `2`  | `package.json` or lockfile not found, or parse error |

## Why

pnpm and aube let you pin a transitive dependency version via override entries — in `package.json` (`pnpm.overrides` or top-level `overrides`) or in `pnpm-workspace.yaml` / `aube-workspace.yaml` (top-level `overrides:`).

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
  - `pnpm-workspace.yaml` or `aube-workspace.yaml` &rarr; top-level `overrides:`
- When a key appears in both `pnpm.overrides` and top-level `overrides`, both are reported independently. pnpm gives `pnpm.overrides` precedence at install time, but stale duplicates in the other location are easy to overlook.
- Only specifiers using `>=` and/or `>` are checked. Exact pins (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`), and bounded ranges are skipped — removing an intentional upper bound is unsafe.
- Lockfile must be `pnpm-lock.yaml` or `aube-lock.yaml` at `lockfileVersion: '9.0'` (pnpm 9+ / aube). Older formats are not supported in this release.

## Known limitations

- Skips values using non-semver protocols (`catalog:`, `workspace:`, `file:`, `link:`, `portal:`, `npm:`, `github:`, `git`-prefixed, `http:` / `https:`).
- Skips nested-key overrides like `"parent>child": "1.2.3"`. Only flat `name &rarr; spec` mappings are evaluated.
- Skips versioned keys like `"ajv@^8.0.0": ">=8.18.0"`. Such entries combine a selector and a replacement; safely transforming them is not expressible in pnpm syntax, so the verdict is left for human review.
- Public npm registry only. Private registries and `.npmrc` scoped registry configuration are not consulted.
- Parents that aren't on the public registry — e.g. workspace-internal packages resolved as transitive parents — are silently dropped from the constraint set. The natural resolution may then appear less constrained than it actually is.

## License

MIT
