#!/usr/bin/env bash
# Packed-quickstart smoke test: the README quickstart, run against a tarball of this checkout
# instead of the npm registry. Used by .github/workflows/ci.yml on Linux and Windows (Git Bash).
#
#   bash scripts/ci-quickstart.sh <path-to-teenybase.tgz> <empty-work-dir>
#
# Steps: create a project from the tarball -> npm install -> deploy --local (stdin closed)
# -> start dev -> POST sign-up -> expect HTTP 200.
set -euo pipefail

TARBALL="$1"
WORK="$2"
if command -v cygpath > /dev/null 2>&1; then
  # Git Bash on Windows: C:/style paths work for both bash and the native node/npm.
  TARBALL="$(cygpath -m "$TARBALL")"
  WORK="$(cygpath -m "$WORK")"
fi
# TEENY_DEV_PORT is read by `teenybase dev` and `deploy --local`; override it to run next to another dev server.
PORT="${TEENY_DEV_PORT:-8787}"
export TEENY_DEV_PORT="$PORT"
BASE="http://127.0.0.1:$PORT/api/v1"

mkdir -p "$WORK"
cd "$WORK"

npx --yes --package "$TARBALL" teenybase create my-app --template with-auth --yes --no-install < /dev/null
cd my-app
npm install "$TARBALL"
npx teenybase deploy --local --yes < /dev/null

# Job control gives the dev server its own process group, so cleanup can stop
# npx -> teenybase -> wrangler -> workerd together.
set -m
npx teenybase dev < /dev/null > dev.log 2>&1 &
DEV_PID=$!
set +m
cleanup() {
  if [ -r "/proc/$DEV_PID/winpid" ]; then
    # Git Bash on Windows: kill the native process tree.
    taskkill //F //T //PID "$(cat "/proc/$DEV_PID/winpid")" > /dev/null 2>&1 || true
  else
    kill -- "-$DEV_PID" 2> /dev/null || kill "$DEV_PID" 2> /dev/null || true
  fi
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health" || true)" = "200" ]; then ready=1; break; fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "dev server did not become healthy on port $PORT"; cat dev.log; exit 1
fi

code=$(curl -s -o signup.json -w '%{http_code}' -X POST "$BASE/table/users/auth/sign-up" \
  -H 'Content-Type: application/json' \
  -d '{"username":"ciuser","email":"ci@example.com","password":"ci-password-123","passwordConfirm":"ci-password-123","name":"CI User"}')
echo "sign-up HTTP $code"
cat signup.json; echo
if [ "$code" != "200" ]; then
  echo "--- dev.log"; cat dev.log; exit 1
fi
