# Contributing

Thanks for helping. Bug reports, docs fixes and PRs are all welcome.

- **Bugs and ideas:** open an [issue](https://github.com/teenybase/teenybase/issues). For anything bigger than a small fix, open an issue before the PR so we can agree on the approach.
- **Security issues:** report privately, see [SECURITY.md](SECURITY.md).

## Setup

Node.js 22 or later.

```bash
git clone https://github.com/teenybase/teenybase.git
cd teenybase
npm ci              # also builds dist/
```

Working with a coding agent? `AGENTS.md` has the commands, layout and rules for this repo.

## Checks

Run these before opening a PR. CI runs the same commands.

```bash
npm run check          # type-check src/
npm run test-check     # type-check test/
npm run vitest         # unit tests
npm run vitest-worker  # worker integration tests (workerd via miniflare)
npm run linkcheck      # relative links and anchors in README and docs (needs python3)
```

## Layout

| Path | What's there |
|---|---|
| `src/sql/` | Rule and expression parsing, SQL generation, migration diffing |
| `src/worker/` | Runtime: `$Database`, extensions (auth, CRUD, rules, OpenAPI, admin UI) |
| `src/node/` | The `teeny` CLI |
| `src/types/` | Config types and zod schemas |
| `test/` | Unit tests; `test/worker/` runs inside workerd |
| `docs/` | User docs (shipped in the npm package) |
| `skills/` | Agent skills (shipped in the npm package) |

## Pull requests

- Keep PRs focused, one change per PR.
- Add or update tests for behaviour changes.
- Update `docs/` and `skills/` when a feature or config option changes.
- Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
- By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE).

## Releases

Maintainers release by bumping `version` in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`, turning `Unreleased` in the changelog into the version heading (`## 0.1.1 - 2026-11-02`), and pushing to `main`. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs [repalash/release-tools](https://github.com/repalash/release-tools): when the version is not on npm yet it builds, tests and packs the package, posts an approval link, and after a maintainer approves the `npm-publish` environment it publishes with npm trusted publishing (provenance, no npm token) and creates the `v<version>` tag and GitHub release. Prerelease versions (`0.2.0-beta.1`) are published under the `next` dist-tag.

One-time setup, from a clone of release-tools (needs `gh` with admin rights on the repository and `npm` logged in as a teenybase maintainer): `scripts/setup-repos.sh teenybase/teenybase:publish.yml:teenybase`. It creates the `npm-publish` environment with the maintainer as required reviewer, stores the optional Discord and review secrets, and registers the npm trusted publisher for `publish.yml`.
