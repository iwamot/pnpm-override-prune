# repo-template

Starter template for repositories in iwamot's ecosystem.

## Files

| Path | Purpose |
|------|---------|
| `.github/dco.yml` | DCO Bot config. Allows individual remediation commits for missing sign-offs. |
| `.github/release.yml` | GitHub auto-generated release notes categorization (Features / Dependencies). |
| `.github/renovate.json` | Extends `iwamot/renovate-config` preset. |
| `.github/workflows/validate.yml` | Runs `validate.sh` on push and PR via `iwamot/workflows`. |
| `.github/workflows/renovate.yml` | Self-hosted Renovate runner (hourly + on push to main). |
| `.github/workflows/dependency-review.yml` | Vulnerability and license review on PRs. |
| `.github/workflows/dependabot-auto-merge.yml` | Auto-merges Dependabot PRs. |
| `mise.toml` | Pins mise minimum version and includes shared tasks from `iwamot/mise-tasks`. |
| `validate.sh` | Lint entry point invoked by `iwamot/actions/mise-validate`. Add repo-specific lint at the marked location. |

## Post-creation setup

After clicking **Use this template**:

1. **Replace this README.md** with the new repository's own description.
2. **Install GitHub Apps** for the new repo:
   - [DCO](https://github.com/apps/dco) — sign-off enforcement
   - Renovate App (or your self-hosted equivalent)
3. **Create a GitHub Environment** for Renovate (default name: `production`, override via the `environment` input on `renovate.yml` if needed) and add environment-scoped secrets:
   - `RENOVATE_APP_ID`
   - `RENOVATE_PRIVATE_KEY`
4. **Add a publish workflow** if the repo ships artifacts. These also take an `environment` input — create additional environments as needed:
   - `iwamot/workflows/.github/workflows/publish-ghcr.yml` for GHCR
   - `iwamot/workflows/.github/workflows/publish-ecr-public.yml` for ECR Public
5. **Add language-specific files** as needed: `Dockerfile`, `package.json`, `pyproject.toml`, `.gitignore`, etc.
6. **Extend `validate.sh`** with repo-specific lint (e.g. `mise run docker-lint Dockerfile`, language linters).
7. **Review `mise.toml`'s `min_version`**: the template provides a default, but the minimum mise version is each repository's own decision. Bump it if your tasks require a newer feature, or drop it if no constraint is needed. This is *not* auto-bumped by Renovate.

Renovate runs on this template to keep pinned versions in `.github/workflows/*.yml` and `mise.toml`'s `task_config.includes` reasonably current, but derived repositories are responsible for their own updates going forward — enable Renovate and let it track upstream from there.
