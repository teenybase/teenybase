#!/usr/bin/env bash
#
# Structural validation for teenybase Claude Code skills plugin.
# Checks that all required files exist, have valid content, and will
# ship correctly via npm pack.
#
# Usage: bash scripts/test-skills.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
section() { echo; echo -e "${YELLOW}━━━ $1 ━━━${RESET}"; }

assert_file() {
    local file="$1"
    local label="${2:-$file}"
    if [ -f "$file" ]; then
        pass "$label exists"
    else
        fail "$label missing"
    fi
}

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

# ─── Test 1: Plugin manifest ─────────────────────────────────────────────────

section "Plugin manifest (.claude-plugin/plugin.json)"

PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"

assert_file "$PLUGIN_JSON" "plugin.json"

if [ -f "$PLUGIN_JSON" ]; then
    # Valid JSON
    if jq empty "$PLUGIN_JSON" 2>/dev/null; then
        pass "plugin.json is valid JSON"
    else
        fail "plugin.json is NOT valid JSON"
    fi

    # Required fields
    for field in name version description; do
        if jq -e ".$field" "$PLUGIN_JSON" >/dev/null 2>&1; then
            pass "plugin.json has '$field' field"
        else
            fail "plugin.json missing '$field' field"
        fi
    done
fi

# ─── Test 2: SKILL.md files exist ────────────────────────────────────────────

section "SKILL.md files"

SKILLS=(
    "skills/teenybase/SKILL.md"
    "skills/teeny-rules/SKILL.md"
    "skills/teeny-migrate/SKILL.md"
)

for skill in "${SKILLS[@]}"; do
    assert_file "$REPO_ROOT/$skill" "$skill"
done

# ─── Test 3: SKILL.md frontmatter ────────────────────────────────────────────

section "SKILL.md frontmatter validation"

for skill in "${SKILLS[@]}"; do
    skill_path="$REPO_ROOT/$skill"
    [ -f "$skill_path" ] || continue

    # Check YAML frontmatter delimiter
    first_line=$(head -1 "$skill_path")
    if [ "$first_line" = "---" ]; then
        pass "$skill has frontmatter start"
    else
        fail "$skill missing frontmatter start (---)"
        continue
    fi

    # Extract frontmatter (between first and second ---)
    frontmatter=$(awk 'NR==1{next} /^---$/{exit} {print}' "$skill_path")

    # Check required fields
    if echo "$frontmatter" | grep -q "^name:"; then
        pass "$skill has 'name' field"
    else
        fail "$skill missing 'name' field"
    fi

    if echo "$frontmatter" | grep -q "^description:"; then
        pass "$skill has 'description' field"
    else
        fail "$skill missing 'description' field"
    fi
done

# ─── Test 4: Portable frontmatter ────────────────────────────────────────────

section "SKILL.md frontmatter uses only Agent Skills standard fields"

for skill in "${SKILLS[@]}"; do
    skill_path="$REPO_ROOT/$skill"
    [ -f "$skill_path" ] || continue
    # top-level keys of the frontmatter (indented lines belong to a folded value)
    keys=$(awk 'NR==1{next} /^---$/{exit} /^[A-Za-z_-]+:/{sub(/:.*/, ""); print}' "$skill_path")
    bad=$(echo "$keys" | grep -vxE 'name|description|license|compatibility|metadata|allowed-tools' || true)
    if [ -z "$bad" ]; then
        pass "$skill frontmatter keys: $(echo $keys)"
    else
        fail "$skill has non-standard frontmatter keys: $(echo $bad)"
    fi
    dir_name=$(basename "$(dirname "$skill_path")")
    name=$(awk 'NR==1{next} /^---$/{exit} /^name:/{sub(/^name:[ ]*/, ""); print}' "$skill_path")
    if [ "$name" = "$dir_name" ]; then
        pass "$skill name matches its directory"
    else
        fail "$skill name '$name' does not match directory '$dir_name'"
    fi
done

# ─── Test 5: Line count limits ───────────────────────────────────────────────

section "SKILL.md line count (max 500)"

for skill in "${SKILLS[@]}"; do
    skill_path="$REPO_ROOT/$skill"
    [ -f "$skill_path" ] || continue

    line_count=$(wc -l < "$skill_path" | tr -d ' ')
    if [ "$line_count" -le 500 ]; then
        pass "$skill: $line_count lines (≤ 500)"
    else
        fail "$skill: $line_count lines (> 500 limit)"
    fi
done

# ─── Test 6: Internal links resolve ──────────────────────────────────────────

section "Internal link resolution"

for skill in "${SKILLS[@]}"; do
    skill_path="$REPO_ROOT/$skill"
    skill_dir=$(dirname "$skill_path")
    [ -f "$skill_path" ] || continue

    # Find markdown links: [text](path)
    links=$(grep -oE '\[([^]]*)\]\(([^)]+)\)' "$skill_path" | grep -oE '\(([^)]+)\)' | tr -d '()' || true)

    for link in $links; do
        # Skip http/https URLs
        [[ "$link" =~ ^https?:// ]] && continue
        # Skip anchors
        [[ "$link" =~ ^# ]] && continue

        # Remove anchor from link
        link_path="${link%%#*}"
        [ -z "$link_path" ] && continue

        resolved="$skill_dir/$link_path"
        if [ -f "$resolved" ] || [ -d "$resolved" ]; then
            pass "$skill → $link_path resolves"
        else
            fail "$skill → $link_path does NOT resolve (from $skill_dir)"
        fi
    done
done

# ─── Test 7: Import paths in code examples ───────────────────────────────────

section "Import paths in code examples"

for skill in "${SKILLS[@]}"; do
    skill_path="$REPO_ROOT/$skill"
    [ -f "$skill_path" ] || continue

    # Check that imports use correct package paths
    if grep -q "from 'teenybase'" "$skill_path" 2>/dev/null; then
        pass "$skill uses 'teenybase' import"
    fi

    if grep -q "teenybase/scaffolds/fields" "$skill_path" 2>/dev/null; then
        pass "$skill uses 'teenybase/scaffolds/fields' import"
    fi
done

# ─── Test 8: package.json files array ────────────────────────────────────────

section "package.json files array"

PKG="$REPO_ROOT/package.json"

assert_contains "$PKG" '".claude-plugin"' "package.json files includes .claude-plugin"
for skill in "${SKILLS[@]}"; do
    dir=$(dirname "$skill")
    assert_contains "$PKG" "\"$dir\"" "package.json files includes $dir"
done

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
