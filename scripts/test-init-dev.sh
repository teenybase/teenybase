#!/usr/bin/env bash
#
# Dev test script for `teeny create` + `teeny deploy` + `teeny dev`.
# Creates projects in ./tmp/, runs local migrations, starts dev servers,
# tests endpoints, then keeps servers running for manual testing.
#
# Usage: npm run test-init-dev          — run tests, keep servers alive
#        npm run test-init-dev:ci       — run tests, exit after completion
#
set -euo pipefail

CI_MODE=false
for arg in "$@"; do
    case "$arg" in
        --ci) CI_MODE=true ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEENY_BIN="$REPO_ROOT/bin/teeny.js"
TMP_DIR="$REPO_ROOT/tmp"
PASS=0
FAIL=0

# Ports for dev servers
PORT_DEFAULT=8801
PORT_BLANK=8802

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo -e "${BOLD}$1${RESET}"; }
pass() { echo -e "  ${GREEN}✓${RESET} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${RESET} $1"; FAIL=$((FAIL + 1)); }

run_teeny() {
    CLOUDFLARE_API_BASE_URL="" CLOUDFLARE_API_TOKEN="" \
        node "$TEENY_BIN" "$@"
}

# Track child PIDs for cleanup on error
PIDS=()
cleanup() {
    if [ ${#PIDS[@]} -gt 0 ]; then
        echo
        log "Stopping dev servers..."
        for pid in "${PIDS[@]}"; do
            kill "$pid" 2>/dev/null || true
        done
        wait 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for a URL to return HTTP 200, with timeout
wait_for_url() {
    local url="$1"
    local label="$2"
    local max_attempts=30  # 30 seconds
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    return 1
}

# Test that a URL returns HTTP 200
assert_http_ok() {
    local url="$1"
    local label="$2"
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
    if [ "$status" = "200" ]; then
        pass "$label (HTTP $status)"
    else
        fail "$label (HTTP $status)"
    fi
}

# Test that a URL response contains a string
assert_http_contains() {
    local url="$1"
    local pattern="$2"
    local label="$3"
    local body
    body=$(curl -sf "$url" 2>/dev/null || echo "")
    if echo "$body" | grep -q "$pattern"; then
        pass "$label"
    else
        fail "$label (pattern '$pattern' not found)"
    fi
}

# ─── Setup ────────────────────────────────────────────────────────────────────

log "Building teenybase..."
(cd "$REPO_ROOT" && npm run build --silent 2>/dev/null)

# Clean and recreate tmp dir
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# Use local teenybase build instead of published npm package
use_local_teenybase() {
    local project_dir="$1"
    local pkg="$project_dir/package.json"
    # Point "teenybase" (the scaffold pins the CLI's exact version, which may not be published yet)
    # at the repo root, then install. Projects are created with --no-install for this reason.
    local rel_path
    rel_path=$(node -e "const p=require('path'); console.log(p.relative('$project_dir','$REPO_ROOT'))")
    node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$pkg', 'utf8'));
        pkg.dependencies.teenybase = 'file:$rel_path';
        fs.writeFileSync('$pkg', JSON.stringify(pkg, null, 2) + '\n');
    "
    log "  Patched package.json to use local teenybase (file:$rel_path)"
    (cd "$project_dir" && npm install --silent 2>&1)
}

# ─── Create default project (with-auth) ──────────────────────────────────────

echo
log "━━━ Creating default project (my-app) ━━━"
(cd "$TMP_DIR" && run_teeny create my-app --yes --no-install 2>&1)
use_local_teenybase "$TMP_DIR/my-app"

echo
log "━━━ Running deploy --local for my-app ━━━"
(cd "$TMP_DIR/my-app" && run_teeny deploy --local --yes 2>&1)

# ─── Create blank project ────────────────────────────────────────────────────

echo
log "━━━ Creating blank project (blank-app) ━━━"
(cd "$TMP_DIR" && run_teeny create blank-app --yes --template blank --no-install 2>&1)
use_local_teenybase "$TMP_DIR/blank-app"

echo
log "━━━ Running deploy --local for blank-app ━━━"
(cd "$TMP_DIR/blank-app" && run_teeny deploy --local --yes 2>&1)

# ─── Start dev servers ────────────────────────────────────────────────────────

echo
log "━━━ Starting dev servers ━━━"

# Each wrangler instance needs a unique inspector port (default 9229 causes clashes)
# Kill any leftover wrangler/workerd processes from previous runs
pkill -f "wrangler dev.*my-app\|wrangler dev.*blank-app" 2>/dev/null || true
pkill -f "workerd" 2>/dev/null || true

log "  Starting my-app on port $PORT_DEFAULT..."
(cd "$TMP_DIR/my-app" && TEENY_DEV_PORT=$PORT_DEFAULT TEENY_INSPECTOR_PORT=9330 run_teeny dev --local 2>&1 | sed "s/^/  [my-app] /") &
PIDS+=($!)

log "  Starting blank-app on port $PORT_BLANK..."
(cd "$TMP_DIR/blank-app" && TEENY_DEV_PORT=$PORT_BLANK TEENY_INSPECTOR_PORT=9331 run_teeny dev --local 2>&1 | sed "s/^/  [blank-app] /") &
PIDS+=($!)

# Wait for servers to be ready
log "\nWaiting for dev servers to start..."

if wait_for_url "http://localhost:$PORT_DEFAULT/api/v1/health" "my-app"; then
    pass "my-app dev server is up on port $PORT_DEFAULT"
else
    fail "my-app dev server failed to start on port $PORT_DEFAULT"
fi

if wait_for_url "http://localhost:$PORT_BLANK/api/v1/health" "blank-app"; then
    pass "blank-app dev server is up on port $PORT_BLANK"
else
    fail "blank-app dev server failed to start on port $PORT_BLANK"
fi

# ─── Seed users in my-app ─────────────────────────────────────────────────────

echo
log "━━━ Seeding users in my-app (port $PORT_DEFAULT) ━━━"

for i in 1 2 3; do
    SIGNUP_RES=$(curl -s -w '\n%{http_code}' -X POST "http://localhost:$PORT_DEFAULT/api/v1/table/users/auth/sign-up" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"user$i\",\"email\":\"user$i@example.com\",\"password\":\"password$i\",\"passwordConfirm\":\"password$i\",\"name\":\"Test User $i\"}" 2>/dev/null)
    SIGNUP_CODE=$(echo "$SIGNUP_RES" | tail -1)
    if [ "$SIGNUP_CODE" = "200" ]; then
        pass "Seeded user$i"
    else
        fail "Failed to seed user$i (HTTP $SIGNUP_CODE)"
        echo "$SIGNUP_RES" | head -1 | head -c 200
        echo
    fi
done

# ─── Test endpoints: my-app (with-auth) ──────────────────────────────────────

echo
log "━━━ Testing my-app endpoints (port $PORT_DEFAULT) ━━━"

BASE="http://localhost:$PORT_DEFAULT"

assert_http_ok "$BASE/api/v1/health" "GET /api/v1/health"
assert_http_contains "$BASE/api/v1/health" '"status":"ok"' "health returns status ok"

assert_http_ok "$BASE/api/v1/doc/ui" "GET /api/v1/doc/ui"
assert_http_contains "$BASE/api/v1/doc/ui" 'swagger' "doc/ui returns Swagger UI"

# OpenAPI JSON doc
DOC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/doc" 2>/dev/null)
if [ "$DOC_STATUS" = "200" ]; then
    pass "GET /api/v1/doc (HTTP $DOC_STATUS)"
    assert_http_contains "$BASE/api/v1/doc" '"openapi"' "doc returns OpenAPI spec"
    assert_http_contains "$BASE/api/v1/doc" '"paths"' "doc includes paths"
    assert_http_contains "$BASE/api/v1/doc" 'users' "doc includes users table routes"
    assert_http_contains "$BASE/api/v1/doc" 'auth' "doc includes auth routes"
else
    fail "GET /api/v1/doc (HTTP $DOC_STATUS)"
    # Dump server-side error for debugging
    echo -e "  ${DIM}  Response body:${RESET}"
    curl -s "$BASE/api/v1/doc" 2>/dev/null | head -c 500
    echo
fi

# Pocket UI — /pocket should redirect to /pocket/
POCKET_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/pocket" 2>/dev/null)
if [ "$POCKET_STATUS" = "302" ] || [ "$POCKET_STATUS" = "301" ]; then
    pass "GET /api/v1/pocket redirects (HTTP $POCKET_STATUS)"
else
    fail "GET /api/v1/pocket should redirect (HTTP $POCKET_STATUS)"
fi

# Pocket UI — /pocket/ should return HTML
assert_http_ok "$BASE/api/v1/pocket/" "GET /api/v1/pocket/"
assert_http_contains "$BASE/api/v1/pocket/" '<html' "pocket/ returns HTML"

# Pocket UI — /pocket/login should return login page
POCKET_LOGIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/pocket/login" 2>/dev/null)
if [ "$POCKET_LOGIN_STATUS" = "200" ]; then
    pass "GET /api/v1/pocket/login (HTTP $POCKET_LOGIN_STATUS)"
    assert_http_contains "$BASE/api/v1/pocket/login" 'Login' "pocket login page has Login text"
else
    fail "GET /api/v1/pocket/login (HTTP $POCKET_LOGIN_STATUS)"
fi

# Test users table CRUD
USERS_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/table/users/select" 2>/dev/null)
if [ "$USERS_STATUS" != "000" ] && [ "$USERS_STATUS" != "404" ]; then
    pass "GET /api/v1/table/users/select responds (HTTP $USERS_STATUS)"
else
    fail "GET /api/v1/table/users/select not found (HTTP $USERS_STATUS)"
fi

# Test auth endpoint exists
AUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/table/users/auth/login-password" -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
if [ "$AUTH_STATUS" != "000" ] && [ "$AUTH_STATUS" != "404" ]; then
    pass "POST /api/v1/table/users/auth/login-password responds (HTTP $AUTH_STATUS)"
else
    fail "POST /api/v1/table/users/auth/login-password not found (HTTP $AUTH_STATUS)"
fi

# ─── Test endpoints: blank-app ────────────────────────────────────────────────

echo
log "━━━ Testing blank-app endpoints (port $PORT_BLANK) ━━━"

BASE="http://localhost:$PORT_BLANK"

assert_http_ok "$BASE/api/v1/health" "GET /api/v1/health"
assert_http_contains "$BASE/api/v1/health" '"status":"ok"' "health returns status ok"

assert_http_ok "$BASE/api/v1/doc/ui" "GET /api/v1/doc/ui"
assert_http_contains "$BASE/api/v1/doc/ui" 'swagger' "doc/ui returns Swagger UI"

# OpenAPI JSON doc — blank app should work since no complex auth schemas
DOC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/doc" 2>/dev/null)
if [ "$DOC_STATUS" = "200" ]; then
    pass "GET /api/v1/doc (HTTP $DOC_STATUS)"
    # Blank app should have no tables
    BLANK_DOC=$(curl -s "$BASE/api/v1/doc" 2>/dev/null || echo "")
    if echo "$BLANK_DOC" | grep -q '"users"'; then
        fail "blank-app doc should NOT have users table"
    else
        pass "blank-app doc has no users table (correct)"
    fi
else
    fail "GET /api/v1/doc (HTTP $DOC_STATUS)"
fi

# Pocket UI — /pocket/ should return HTML
assert_http_ok "$BASE/api/v1/pocket/" "GET /api/v1/pocket/"
assert_http_contains "$BASE/api/v1/pocket/" '<html' "pocket/ returns HTML"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}$PASS passed${RESET}  ${RED}$FAIL failed${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}Some tests failed!${RESET}"
fi

# ─── CI mode: exit, Dev mode: keep servers running ───────────────────────────

if [ "$CI_MODE" = true ]; then
    if [ "$FAIL" -gt 0 ]; then
        exit 1
    fi
    exit 0
fi

echo
log "Dev servers are running:"
echo -e "  ${GREEN}●${RESET} my-app (with-auth):  ${BOLD}http://localhost:$PORT_DEFAULT${RESET}"
echo -e "  ${GREEN}●${RESET} blank-app:           ${BOLD}http://localhost:$PORT_BLANK${RESET}"
echo
echo -e "  Swagger UI:  http://localhost:$PORT_DEFAULT/api/v1/doc/ui"
echo -e "  Pocket UI:   http://localhost:$PORT_DEFAULT/api/v1/pocket/"
echo -e "  Swagger UI:  http://localhost:$PORT_BLANK/api/v1/doc/ui"
echo -e "  Pocket UI:   http://localhost:$PORT_BLANK/api/v1/pocket/"
echo
log "Press Ctrl+C to stop all servers."
echo

# Wait for background processes (keeps script alive until Ctrl+C)
wait
