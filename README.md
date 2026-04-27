# pnpm-override-prune

[![Validate](https://github.com/iwamot/pnpm-override-prune/actions/workflows/validate.yml/badge.svg)](https://github.com/iwamot/pnpm-override-prune/actions/workflows/validate.yml)
[![codecov](https://codecov.io/gh/iwamot/pnpm-override-prune/graph/badge.svg)](https://codecov.io/gh/iwamot/pnpm-override-prune)
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

pnpm and aube let you pin a transitive dependency version via override
entries — in `package.json` (`pnpm.overrides` or top-level `overrides`)
or in `pnpm-workspace.yaml` / `aube-workspace.yaml` (top-level
`overrides:`). A common reason to reach for these is CVE
mitigation: a vulnerability is disclosed in a transitive package, and you
force the patched minimum version while waiting for direct deps to require
it naturally. Once they catch up, the entry is no longer doing anything —
but it's easy to forget which ones are still load-bearing, and stale
overrides become a judgment cost at every audit or upgrade ("is this still
needed, or just history?"). `pnpm-override-prune` answers that mechanically
by checking whether each entry's lower bound is already satisfied by the
natural resolution that the npm registry would yield without the override.

## Scope

- Reads override entries from these locations:
  - `package.json` &rarr; `pnpm.overrides`
  - `package.json` &rarr; top-level `overrides` (npm-compatible form, also
    used by `aube audit --fix`)
  - `pnpm-workspace.yaml` or `aube-workspace.yaml` &rarr; top-level `overrides:`
- When the same key appears in both `pnpm.overrides` and top-level
  `overrides`, both entries are evaluated and reported independently
  (pnpm gives `pnpm.overrides` precedence at install time, but the tool
  surfaces both so dead duplicates can be cleaned up).
- Only entries whose specifier uses `>=` and/or `>` are checked. Entries
  using exact pins (`1.2.3`), caret (`^1.2.3`), tilde (`~1.2.3`), or
  bounded ranges are skipped — removing an upper bound the user wrote
  intentionally is unsafe.
- Lockfile must be `pnpm-lock.yaml` or `aube-lock.yaml` at
  `lockfileVersion: '9.0'` (pnpm 9+ / aube). Older formats are not
  supported in this release.
- Detection method: the tool gathers the parent specs that constrain each
  override target — direct importer specs from the lockfile plus
  parent-package metadata from `https://registry.npmjs.org` — and computes
  the highest published version satisfying their intersection. If that
  natural resolution already meets the override's lower bound, the entry
  is `[PRUNE]`.

## Known limitations

- Skips entries whose value is a non-semver protocol (`catalog:`,
  `workspace:`, `file:`, `link:`, `portal:`, `npm:`, `github:`, `git`-prefixed,
  `http:` / `https:`).
- Skips nested-key overrides like `"parent>child": "1.2.3"`. Only flat
  `name &rarr; spec` mappings are evaluated.
- Public npm registry only. Private registries / scoped registry
  configuration in `.npmrc` are not consulted.
- Parents that aren't on the public registry (workspace-internal packages
  resolved as transitive parents) are silently dropped from the constraint
  set, which can make the natural resolution appear less constrained than
  it really is.

## License

MIT
