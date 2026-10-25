#!/usr/bin/env bash
#
# Automated Claude CLI tests for teenybase skills plugin.
# Spawns claude in non-interactive mode (-p) with --plugin-dir pointing
# at the repo, then validates the output contains expected patterns
# and does NOT contain bad patterns.
#
# Usage: bash scripts/test-skills-ai.sh
#
# Requirements:
#   - claude CLI installed and authenticated
#   - jq installed
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
TOTAL_TESTS=0

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
section() { echo; echo -e "${YELLOW}━━━ $1 ━━━${RESET}"; }

# ─── Preflight checks ────────────────────────────────────────────────────────

if ! command -v claude &>/dev/null; then
    echo -e "${RED}Error: claude CLI not found. Install it first.${RESET}"
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo -e "${RED}Error: jq not found. Install it first.${RESET}"
    exit 1
fi

# ─── Core test runner ─────────────────────────────────────────────────────────

# run_skill_test <label> <prompt> --must <pattern1> [pattern2] ... [--must-not <pattern1> ...]
#
# Runs claude -p with the given prompt and checks:
#   --must patterns: ALL must appear (case-insensitive) in the output
#   --must-not patterns: NONE must appear (case-sensitive) in the output
#
# Fails with output dump on any violation.
run_skill_test() {
    local label="$1"
    local prompt="$2"
    shift 2

    local must_patterns=()
    local must_not_patterns=()
    local mode="must"

    while [ $# -gt 0 ]; do
        case "$1" in
            --must) mode="must"; shift ;;
            --must-not) mode="must_not"; shift ;;
            *)
                if [ "$mode" = "must" ]; then
                    must_patterns+=("$1")
                else
                    must_not_patterns+=("$1")
                fi
                shift
                ;;
        esac
    done

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -e "\n  ${DIM}Running: $label${RESET}"
    echo -e "  ${DIM}Prompt: ${prompt:0:80}...${RESET}"

    local output=""
    local exit_code=0

    output=$(CLAUDECODE="" claude -p \
        --plugin-dir "$REPO_ROOT" \
        --output-format json \
        --model sonnet \
        --max-budget-usd 0.50 \
        --no-session-persistence \
        --dangerously-skip-permissions \
        "$prompt" 2>/dev/null) || exit_code=$?

    if [ $exit_code -ne 0 ]; then
        fail "$label (claude exited with code $exit_code)"
        echo -e "  ${DIM}stderr/stdout:${RESET}"
        echo "$output" | head -20
        return
    fi

    # Extract text result from JSON output
    local result=""
    result=$(echo "$output" | jq -r '.result // empty' 2>/dev/null || echo "")
    if [ -z "$result" ]; then
        result=$(echo "$output" | jq -r '.text // empty' 2>/dev/null || echo "")
    fi
    if [ -z "$result" ]; then
        result="$output"
    fi

    local test_failed=false
    local issues=()

    # Check must-have patterns (case-insensitive, fixed-string)
    for pattern in "${must_patterns[@]}"; do
        if echo "$result" | grep -qiF -- "$pattern"; then
            : # found
        else
            test_failed=true
            issues+=("MISSING: $pattern")
        fi
    done

    # Check must-not patterns (case-sensitive, fixed-string)
    for pattern in "${must_not_patterns[@]+"${must_not_patterns[@]}"}"; do
        [ -z "$pattern" ] && continue
        if echo "$result" | grep -qF -- "$pattern"; then
            test_failed=true
            issues+=("UNEXPECTED: $pattern")
        fi
    done

    if [ "$test_failed" = true ]; then
        fail "$label"
        for issue in "${issues[@]}"; do
            echo -e "    ${RED}✗${RESET} $issue"
        done
        echo -e "  ${DIM}Output (first 1000 chars):${RESET}"
        echo "$result" | head -c 1000
        echo
    else
        local total_checks=$(( ${#must_patterns[@]} + ${#must_not_patterns[@]} ))
        pass "$label ($total_checks checks passed)"
    fi
}

# ─── Tests ────────────────────────────────────────────────────────────────────

section "Skill Discovery"

run_skill_test "skill discovery" \
    "List the teenybase skills/slash commands available to you. Just list their names, one per line." \
    --must "teenybase" "teeny-rules" "teeny-migrate" \
    --must-not "teeny-actions" "teeny-api"

section "Config Generation"

# Specific patterns: exact import paths, exact type assertion, specific teenybase patterns
run_skill_test "new project config" \
    "Show me a complete teeny.config.ts for a new project with users table (auth) and posts table. Just show the config code, nothing else." \
    --must \
        "satisfies DatabaseSettings" \
        "baseFields" \
        "authFields" \
        "passwordType" \
        "createdTrigger" \
        "updatedTrigger" \
        "from 'teenybase'" \
        "teenybase/scaffolds/fields" \
        "autoSetUid" \
        "TableRulesExtensionData" \
    --must-not \
        "type: 'boolean'" \
        "listRule: true" \
        "createRule: null"

section "Rules Syntax"

run_skill_test "rules syntax" \
    "How do I write a teenybase rule expression that lets users see only their own posts plus published posts from others? Show the rules extension config." \
    --must \
        "listRule" \
        "auth.uid" \
        "published" \
        "TableRulesExtensionData" \
    --must-not \
        "listRule: true," \
        "||"

section "Migration Workflow"

run_skill_test "migration workflow" \
    "How do I deploy my teenybase project to production? List the steps briefly." \
    --must \
        "migrate" \
        "--remote" \
        ".prod.vars" \
        "secrets" \
        "deploy"

section "Field Types"

# Must use 'bool' (teenybase type), not 'boolean' as the type value
run_skill_test "field types" \
    "What teenybase field type should I use for a boolean/true-false field? Show a complete field definition object." \
    --must \
        "type: 'bool'" \
        "sqlType" \
    --must-not \
        "type: 'boolean'"

section "OAuth Setup"

run_skill_test "oauth setup" \
    "How do I add Google OAuth login to my teenybase project? Show the config snippet." \
    --must \
        "oauthProviders" \
        "GOOGLE_CLIENT_ID" \
        "GOOGLE_CLIENT_SECRET" \
        "clientId" \
        "clientSecret"

section "Common Mistakes"

# Specific patterns: the exact string 'true' (quoted), null as deny, createRule limitation
run_skill_test "common mistakes" \
    "What are common mistakes when writing teenybase access rules? I keep getting denied." \
    --must \
        "'true'" \
        "null" \
        "createRule" \
        "string" \
    --must-not \
        "listRule: true,"

section "Skill Content Accuracy"

# Verify the skills teach correct teenybase-specific details that an LLM wouldn't
# know without the skills (e.g., exact operator syntax, exact field type names)
run_skill_test "expression operators" \
    "What operators can I use in teenybase rule expressions? List them all with their SQL equivalents." \
    --must \
        "~" \
        "LIKE" \
        "@@" \
        "MATCH" \
        "&" \
        "AND" \
    --must-not \
        "&&"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}$PASS passed${RESET}  ${RED}$FAIL failed${RESET}  (${TOTAL_TESTS} scenarios)"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}Some tests failed!${RESET}"
    exit 1
else
    echo -e "\n${GREEN}All tests passed!${RESET}"
fi
