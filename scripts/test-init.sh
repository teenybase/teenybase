#!/usr/bin/env bash
#
# Manual test script for `teeny init` and `teeny create`.
# Creates projects in a scratch directory and verifies the generated files.
#
# Usage: npm run test-init
#        TEENY_TEST_INIT_DIR=/some/dir npm run test-init   — use another scratch directory
#
# The scratch directory (default: ./tmp/test-init) is owned by this script: it is marked with a
# .teeny-test-scratch file and emptied at the start of each run. A directory that exists without
# that marker is never deleted; the script stops instead.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEENY_BIN="$REPO_ROOT/bin/teeny.js"
TMP_DIR="${TEENY_TEST_INIT_DIR:-$REPO_ROOT/tmp/test-init}"
SCRATCH_MARKER=".teeny-test-scratch"
PASS=0
FAIL=0

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
skip() { echo -e "  ${DIM}○${RESET} $1 (skipped)"; }
section() { echo; echo -e "${YELLOW}━━━ $1 ━━━${RESET}"; }

# Run teeny CLI without the caller's Cloudflare API settings (base URL, token) leaking in
run_teeny() {
    CLOUDFLARE_API_BASE_URL="" CLOUDFLARE_API_TOKEN="" \
        node "$TEENY_BIN" "$@"
}

# Assert file exists
assert_file() {
    local file="$1"
    local label="${2:-$file}"
    if [ -f "$file" ]; then
        pass "$label exists"
    else
        fail "$label missing"
    fi
}

# Assert directory exists
assert_dir() {
    local dir="$1"
    local label="${2:-$dir}"
    if [ -d "$dir" ]; then
        pass "$label exists"
    else
        fail "$label missing"
    fi
}

# Assert file contains string
assert_contains() {
    local file="$1"
    local pattern="$2"
    local label="${3:-$file contains '$pattern'}"
    if grep -q "$pattern" "$file" 2>/dev/null; then
        pass "$label"
    else
        fail "$label"
    fi
}

# Assert file does NOT contain string
assert_not_contains() {
    local file="$1"
    local pattern="$2"
    local label="${3:-$file does not contain '$pattern'}"
    if ! grep -q "$pattern" "$file" 2>/dev/null; then
        pass "$label"
    else
        fail "$label"
    fi
}

# Assert command fails (non-zero exit)
assert_fails() {
    local label="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        fail "$label (expected failure, got success)"
    else
        pass "$label"
    fi
}

# ─── Setup ────────────────────────────────────────────────────────────────────

log "Building teenybase..."
(cd "$REPO_ROOT" && npm run build --silent 2>/dev/null)

# Empty the scratch dir from the previous run. Only a directory this script created (it has the
# marker file) is deleted; anything else at that path is left alone and the run stops.
if [ -e "$TMP_DIR" ]; then
    if [ ! -f "$TMP_DIR/$SCRATCH_MARKER" ]; then
        echo -e "${RED}$TMP_DIR exists and was not created by this script (no $SCRATCH_MARKER). Move it away or set TEENY_TEST_INIT_DIR.${RESET}"
        exit 1
    fi
    rm -rf "$TMP_DIR"
fi
mkdir -p "$TMP_DIR"
touch "$TMP_DIR/$SCRATCH_MARKER"

# ─── Test 1: teeny create (default template) ─────────────────────────────────

section "Test 1: teeny create my-app --yes (default template)"

(cd "$TMP_DIR" && run_teeny create my-app --yes 2>&1) || true

DIR="$TMP_DIR/my-app"

assert_file "$DIR/package.json" "package.json"
assert_file "$DIR/wrangler.jsonc" "wrangler.jsonc"
assert_file "$DIR/tsconfig.json" "tsconfig.json"
assert_file "$DIR/teenybase.ts" "teenybase.ts"
assert_file "$DIR/src/index.ts" "src/index.ts"
assert_file "$DIR/worker-configuration.d.ts" "worker-configuration.d.ts"
assert_file "$DIR/.dev.vars" ".dev.vars"
assert_file "$DIR/.gitignore" ".gitignore"
assert_dir  "$DIR/migrations" "migrations/"
assert_file "$DIR/.claude/settings.json" ".claude/settings.json"

# Claude settings content checks
assert_contains "$DIR/.claude/settings.json" '"extraKnownMarketplaces"' "claude settings declares the teenybase marketplace"
assert_contains "$DIR/.claude/settings.json" '"teenybase@teenybase-tools": true' "claude settings enables the teenybase plugin"
assert_contains "$DIR/.claude/settings.json" 'node_modules/teenybase' "claude settings points to teenybase"
assert_not_contains "$DIR/.claude/settings.json" '"rules"' "claude settings has no undocumented rules key"
assert_file "$DIR/.claude/rules/teenybase.md" ".claude/rules/teenybase.md"
assert_contains "$DIR/.claude/rules/teenybase.md" 'npx wrangler login' "claude rules allow npx wrangler login"
assert_not_contains "$DIR/.claude/rules/teenybase.md" 'Never run npx wrangler directly' "claude rules don't forbid wrangler login"

# Content checks
assert_contains "$DIR/package.json" '"name": "my-app"' "package.json has correct name"
assert_contains "$DIR/package.json" '"teenybase"' "package.json has teenybase dep"
assert_contains "$DIR/package.json" '"hono"' "package.json has hono dep"
assert_contains "$DIR/package.json" '"@cloudflare/workers-types"' "package.json has workers-types"
assert_contains "$DIR/package.json" '"cf-typegen"' "package.json has cf-typegen script"
assert_contains "$DIR/package.json" '"type": "module"' "package.json is ESM"

assert_contains "$DIR/wrangler.jsonc" '"PRIMARY_DB"' "wrangler.jsonc has PRIMARY_DB binding"
assert_contains "$DIR/wrangler.jsonc" '"nodejs_compat"' "wrangler.jsonc has nodejs_compat"
assert_contains "$DIR/wrangler.jsonc" '"my-app"' "wrangler.jsonc has project name"
assert_contains "$DIR/wrangler.jsonc" '"my-app-db"' "wrangler.jsonc has db name"
assert_contains "$DIR/wrangler.jsonc" '"RESPOND_WITH_ERRORS": "false"' "wrangler.jsonc keeps error details off by default"

assert_contains "$DIR/tsconfig.json" 'virtual:teenybase' "tsconfig has virtual:teenybase path"
assert_contains "$DIR/tsconfig.json" '@cloudflare/workers-types' "tsconfig has workers-types"
assert_contains "$DIR/tsconfig.json" 'worker-configuration.d.ts' "tsconfig includes worker-configuration.d.ts"

assert_contains "$DIR/teenybase.ts" "name: 'users'" "teeny.config has users table (with-auth default)"
assert_contains "$DIR/teenybase.ts" "name: 'auth'" "teeny.config has auth extension"
assert_contains "$DIR/teenybase.ts" "name: 'rules'" "teeny.config has rules extension"
assert_contains "$DIR/teenybase.ts" "satisfies DatabaseSettings" "teeny.config uses satisfies"

assert_contains "$DIR/src/index.ts" "teenyHono" "src/index.ts has teenyHono"
assert_contains "$DIR/src/index.ts" '$Database' "src/index.ts has \$Database"
assert_contains "$DIR/src/index.ts" "virtual:teenybase" "src/index.ts imports virtual:teenybase"
assert_contains "$DIR/src/index.ts" "export default app" "src/index.ts exports app"

assert_contains "$DIR/worker-configuration.d.ts" "CloudflareBindings" "worker-configuration.d.ts has CloudflareBindings"
assert_contains "$DIR/worker-configuration.d.ts" "D1Database" "worker-configuration.d.ts has D1Database"

assert_contains "$DIR/.dev.vars" "JWT_SECRET=" ".dev.vars has JWT_SECRET"
assert_contains "$DIR/.dev.vars" "ADMIN_JWT_SECRET=" ".dev.vars has ADMIN_JWT_SECRET"
assert_contains "$DIR/.dev.vars" "ADMIN_SERVICE_TOKEN=" ".dev.vars has ADMIN_SERVICE_TOKEN"
assert_contains "$DIR/.dev.vars" "# RESPOND_WITH_ERRORS=true" ".dev.vars documents the local-only error-details opt-in"

assert_contains "$DIR/.gitignore" "node_modules" ".gitignore has node_modules"
assert_contains "$DIR/.gitignore" ".dev.vars" ".gitignore has .dev.vars"
assert_contains "$DIR/.gitignore" ".local-persist" ".gitignore has .local-persist"

# ─── Test 2: teeny create with blank template ────────────────────────────────

section "Test 2: teeny create blank-app --yes --template blank"

(cd "$TMP_DIR" && run_teeny create blank-app --yes --template blank 2>&1) || true

DIR="$TMP_DIR/blank-app"

assert_file "$DIR/teenybase.ts" "teenybase.ts"
assert_contains "$DIR/teenybase.ts" "tables: \[\]" "blank template has empty tables"
assert_not_contains "$DIR/teenybase.ts" "authFields" "blank template has no authFields"
assert_not_contains "$DIR/teenybase.ts" "name: 'auth'" "blank template has no auth extension"

# ─── Test 3: teeny create rejects invalid names ──────────────────────────────

section "Test 3: teeny create rejects invalid names"

assert_fails "rejects uppercase name" run_teeny create MyApp --yes
assert_fails "rejects name with spaces" run_teeny create "my app" --yes
assert_fails "rejects name starting with dot" run_teeny create .hidden --yes

# ─── Test 4: teeny create rejects non-empty directory ────────────────────────

section "Test 4: teeny create rejects non-empty directory"

mkdir -p "$TMP_DIR/existing-dir"
echo "occupied" > "$TMP_DIR/existing-dir/file.txt"
assert_fails "rejects non-empty directory" bash -c "cd '$TMP_DIR' && CLOUDFLARE_API_BASE_URL='' CLOUDFLARE_API_TOKEN='' node '$TEENY_BIN' create existing-dir --yes"

# ─── Test 5: teeny create into empty existing directory ──────────────────────

section "Test 5: teeny create into empty existing directory"

mkdir -p "$TMP_DIR/empty-dir"
(cd "$TMP_DIR" && run_teeny create empty-dir --yes --template blank 2>&1) || true
assert_file "$TMP_DIR/empty-dir/package.json" "package.json created in empty existing dir"

# ─── Test 6: teeny create rejects unknown template ───────────────────────────

section "Test 6: teeny create rejects unknown template"

assert_fails "rejects --template bogus" run_teeny create bad-template-app --yes --template bogus

# ─── Test 7: teeny init in empty directory ────────────────────────────────────

section "Test 7: teeny init --yes in empty directory"

mkdir -p "$TMP_DIR/init-empty"
(cd "$TMP_DIR/init-empty" && run_teeny init --yes 2>&1) || true

DIR="$TMP_DIR/init-empty"
assert_file "$DIR/package.json" "package.json"
assert_file "$DIR/wrangler.jsonc" "wrangler.jsonc"
assert_file "$DIR/teenybase.ts" "teenybase.ts"
assert_file "$DIR/src/index.ts" "src/index.ts"
assert_file "$DIR/worker-configuration.d.ts" "worker-configuration.d.ts"
assert_file "$DIR/.claude/settings.json" ".claude/settings.json"
assert_contains "$DIR/.claude/settings.json" 'node_modules/teenybase' "claude settings points to teenybase"

# ─── Test 8: teeny init skips existing files ──────────────────────────────────

section "Test 8: teeny init --yes skips existing package.json"

mkdir -p "$TMP_DIR/init-existing-pkg"
echo '{"name": "original-name", "version": "1.0.0"}' > "$TMP_DIR/init-existing-pkg/package.json"
(cd "$TMP_DIR/init-existing-pkg" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/init-existing-pkg"
# Original package.json should be untouched
assert_contains "$DIR/package.json" '"original-name"' "package.json preserved (not overwritten)"
assert_not_contains "$DIR/package.json" '"teenybase"' "original package.json not modified"
# But other files should be created
assert_file "$DIR/wrangler.jsonc" "wrangler.jsonc created"
assert_file "$DIR/teenybase.ts" "teenybase.ts created"

# ─── Test 9: teeny init with all files present ───────────────────────────────

section "Test 9: teeny init --yes with all files present (no-op)"

# Use the my-app dir from test 1 which has everything
DIR="$TMP_DIR/my-app"
OUTPUT=$(cd "$DIR" && run_teeny init --yes 2>&1) || true

# Should show all skips, no creates
if echo "$OUTPUT" | grep -q "create "; then
    # "create " with trailing space distinguishes from "create" in other contexts
    # But we need to be careful — "Creating project" also has "create"
    # Check for the file creation pattern specifically
    if echo "$OUTPUT" | grep -q "  create "; then
        fail "should not create any files (got 'create' in output)"
    else
        pass "no files created (all skipped)"
    fi
else
    pass "no files created (all skipped)"
fi

# ─── Test 10: teeny init sanitizes directory name ─────────────────────────────

section "Test 10: teeny init --yes sanitizes uppercase directory name"

mkdir -p "$TMP_DIR/My-Cool-App"
(cd "$TMP_DIR/My-Cool-App" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/My-Cool-App"
assert_contains "$DIR/package.json" '"my-cool-app"' "package name sanitized to lowercase"

# ─── Test 11: teeny init appends to existing .gitignore ───────────────────────

section "Test 11: teeny init --yes appends to existing .gitignore"

mkdir -p "$TMP_DIR/init-gitignore"
echo -e "node_modules\n*.log" > "$TMP_DIR/init-gitignore/.gitignore"
(cd "$TMP_DIR/init-gitignore" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/init-gitignore"
assert_contains "$DIR/.gitignore" "node_modules" ".gitignore keeps existing entries"
assert_contains "$DIR/.gitignore" '*.log' ".gitignore keeps existing *.log"
assert_contains "$DIR/.gitignore" ".local-persist" ".gitignore has appended .local-persist"
assert_contains "$DIR/.gitignore" "# teenybase" ".gitignore has teenybase section header"
# node_modules should appear only once (not duplicated)
NODE_MODULES_COUNT=$(grep -c "^node_modules$" "$DIR/.gitignore" || true)
if [ "$NODE_MODULES_COUNT" -le 1 ]; then
    pass "node_modules not duplicated in .gitignore"
else
    fail "node_modules duplicated in .gitignore ($NODE_MODULES_COUNT times)"
fi

# ─── Test 12: teeny init detects existing wrangler.toml ──────────────────────

section "Test 12: teeny init --yes detects existing wrangler.toml"

mkdir -p "$TMP_DIR/init-wrangler-toml"
echo 'name = "existing-worker"' > "$TMP_DIR/init-wrangler-toml/wrangler.toml"
(cd "$TMP_DIR/init-wrangler-toml" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/init-wrangler-toml"
# Should NOT create wrangler.jsonc since wrangler.toml exists
if [ -f "$DIR/wrangler.jsonc" ]; then
    fail "wrangler.jsonc should NOT be created when wrangler.toml exists"
else
    pass "wrangler.jsonc skipped (wrangler.toml detected)"
fi
# But other files should still be created
assert_file "$DIR/teenybase.ts" "teenybase.ts still created"

# ─── Test 13: teeny init into existing C3 project ────────────────────────────

section "Test 13: teeny init --yes into existing C3 hello-world project"

C3_DIR="$TMP_DIR/c3-hello-world"
log "  Creating C3 hello-world project (this may take a moment)..."
npx create-cloudflare@latest "$C3_DIR" \
    --type hello-world --lang ts \
    --no-deploy --no-git -y 2>&1 | tail -3

# Run teeny init on top of the C3 project
(cd "$C3_DIR" && run_teeny init --yes --template with-auth 2>&1) || true

# C3 project already has package.json, wrangler.jsonc, tsconfig.json, src/index.ts
# teeny init should skip those and only create missing teenybase files
assert_file "$C3_DIR/teenybase.ts" "teenybase.ts created"
assert_file "$C3_DIR/.dev.vars" ".dev.vars created"

# package.json should still be the C3 original (not overwritten)
assert_not_contains "$C3_DIR/package.json" '"teenybase"' "C3 package.json not overwritten"

# wrangler config should still be the C3 original (not overwritten with teenybase template)
assert_not_contains "$C3_DIR/wrangler.jsonc" '"PRIMARY_DB"' "C3 wrangler.jsonc not overwritten (no PRIMARY_DB binding)"

# tsconfig should still be the C3 original
assert_contains "$C3_DIR/tsconfig.json" 'virtual:teenybase' "C3 tsconfig updated with virtual:teenybase path alias"

# ─── Test 14: teeny init preserves existing .claude/settings.json ─────────────

section "Test 14: teeny init --yes preserves existing .claude/settings.json"

mkdir -p "$TMP_DIR/init-claude-settings/.claude"
echo '{"custom": true}' > "$TMP_DIR/init-claude-settings/.claude/settings.json"
(cd "$TMP_DIR/init-claude-settings" && run_teeny init --yes --template blank 2>&1) || true

assert_contains "$TMP_DIR/init-claude-settings/.claude/settings.json" '"custom"' "existing .claude/settings.json preserved"

# ─── Test 15: teeny init adds virtual:teenybase to existing tsconfig ──────────

section "Test 15: teeny init --yes adds virtual:teenybase to existing tsconfig (preserves comments)"

mkdir -p "$TMP_DIR/init-tsconfig-update"
cat > "$TMP_DIR/init-tsconfig-update/tsconfig.json" << 'TSEOF'
{
    // This is a user comment that should be preserved
    "compilerOptions": {
        "target": "ESNext",
        "module": "ESNext",
        /* block comment */
        "strict": true
    },
    "include": ["src/**/*.ts"]
}
TSEOF

(cd "$TMP_DIR/init-tsconfig-update" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/init-tsconfig-update"
assert_contains "$DIR/tsconfig.json" 'virtual:teenybase' "tsconfig has virtual:teenybase path alias"
assert_contains "$DIR/tsconfig.json" './teenybase' "tsconfig path alias points to teenybase"
assert_contains "$DIR/tsconfig.json" 'user comment that should be preserved' "tsconfig preserves line comments"
assert_contains "$DIR/tsconfig.json" 'block comment' "tsconfig preserves block comments"
assert_contains "$DIR/tsconfig.json" '"strict": true' "tsconfig preserves existing options"

# ─── Test 16: teeny init skips tsconfig that already has virtual:teenybase ────

section "Test 16: teeny init --yes skips tsconfig that already has virtual:teenybase"

mkdir -p "$TMP_DIR/init-tsconfig-skip"
cat > "$TMP_DIR/init-tsconfig-skip/tsconfig.json" << 'TSEOF'
{
    "compilerOptions": {
        "paths": {
            "virtual:teenybase": ["./teeny.config"]
        }
    }
}
TSEOF

OUTPUT=$(cd "$TMP_DIR/init-tsconfig-skip" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/init-tsconfig-skip"
if echo "$OUTPUT" | grep -q "virtual:teenybase path alias already configured"; then
    pass "tsconfig skipped (already has virtual:teenybase)"
else
    fail "should report that virtual:teenybase is already configured"
fi

# ─── Test 17: teeny init adds paths to tsconfig with no compilerOptions ───────

section "Test 17: teeny init --yes adds paths to minimal tsconfig (no compilerOptions)"

mkdir -p "$TMP_DIR/init-tsconfig-minimal"
echo '{}' > "$TMP_DIR/init-tsconfig-minimal/tsconfig.json"

(cd "$TMP_DIR/init-tsconfig-minimal" && run_teeny init --yes --template blank 2>&1) || true

DIR="$TMP_DIR/init-tsconfig-minimal"
assert_contains "$DIR/tsconfig.json" 'virtual:teenybase' "minimal tsconfig gets virtual:teenybase"
assert_contains "$DIR/tsconfig.json" 'compilerOptions' "minimal tsconfig gets compilerOptions added"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}$PASS passed${RESET}  ${RED}$FAIL failed${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}Some tests failed!${RESET}"
    exit 1
else
    echo -e "\n${GREEN}All tests passed!${RESET}"
fi
