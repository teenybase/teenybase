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
