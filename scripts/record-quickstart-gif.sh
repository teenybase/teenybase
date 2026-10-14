#!/usr/bin/env bash
# Records docs/images/quickstart.gif (and quickstart.png, its last frame): the README quick start,
# run for real in tmux and recorded with asciinema, rendered with agg.
#
#   bash scripts/record-quickstart-gif.sh <empty-work-dir>
#
# Needs: tmux, asciinema (2.x), agg (>= 1.9), gifsicle, ImageMagick (convert), pngquant, jq, curl,
# the "JetBrains Mono" font.
# The recorded shell gets a clean environment (env -i), because wrangler changes its output when it
# detects an AI agent. The dev server uses TEENY_DEV_PORT (default 8787, the README's port); set it
# to something else if 8787 is taken. Before a release is on npm, set NPM_CONFIG_USERCONFIG to an
# npmrc whose registry serves the packed build: `create` pins the CLI's own version.
#
# What is edited after recording: timing only. The npm install inside `create`, the migration run
# and the dev server start-up are played back faster (their output is kept), and gaps between typed
# keys are capped at 90 ms. Every line on screen is real output of this run. (jq prints null in gray
# via JQ_COLORS so it stays readable on the dark theme.)
set -euo pipefail

WORK="$(cd "$1" && pwd)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/docs/images"
PORT="${TEENY_DEV_PORT:-8787}"
SOCK="teeny-rec-$$"
COLS=100
ROWS=28
CAST="$WORK/quickstart.cast"
export TERM=xterm-256color # the attached tmux client must know the terminal

T() { tmux -L "$SOCK" "$@"; }
type_in() { # type_in <pane> <text> [delay]: type like a person, one key at a time
  local pane="$1" text="$2" delay="${3:-0.035}" i
  for ((i = 0; i < ${#text}; i++)); do T send-keys -t "$pane" -l -- "${text:i:1}"; sleep "$delay"; done
}
enter() { sleep 0.35; T send-keys -t "$1" Enter; }
wait_for() { # wait_for <pane> <regex> <timeout-seconds>
  local i
  for ((i = 0; i < $3 * 4; i++)); do
    T capture-pane -p -t "$1" -S -200 | grep -qE "$2" && return 0
    sleep 0.25
  done
  echo "timed out waiting for /$2/ in pane $1" >&2; T capture-pane -p -t "$1" -S -200 >&2; return 1
}

wait_prompt() { # wait_prompt <pane>: until the command finished and the shell prompt is back
  local i last
  for ((i = 0; i < 600; i++)); do
    last="$(T capture-pane -p -t "$1" | grep -v '^[[:space:]]*$' | tail -1)"
    [[ "$last" =~ ^[A-Za-z0-9._-]+\ \$$ ]] && return 0
    sleep 0.2
  done
  echo "timed out waiting for the prompt in pane $1" >&2; return 1
}
run() { # run <pane> <command> [typing delay] [seconds to show the result]
  wait_prompt "$1"; type_in "$1" "$2" "${3:-0.035}"; enter "$1"; sleep 0.3; wait_prompt "$1"; sleep "${4:-1}"
}

HOME_DIR="$(mktemp -d)"
cleanup() { T kill-server 2> /dev/null || true; }
trap cleanup EXIT

# The recorded shell: clean env, short prompt.
SHELL_CMD="env -i HOME=$HOME_DIR PATH=$PATH TERM=xterm-256color LANG=C.UTF-8 TEENY_DEV_PORT=$PORT JQ_COLORS='0;90'"
[ -n "${NPM_CONFIG_USERCONFIG:-}" ] && SHELL_CMD="$SHELL_CMD NPM_CONFIG_USERCONFIG=$NPM_CONFIG_USERCONFIG"
[ -n "${NPM_CONFIG_CACHE:-}" ] && SHELL_CMD="$SHELL_CMD NPM_CONFIG_CACHE=$NPM_CONFIG_CACHE"
SHELL_CMD="$SHELL_CMD PS1='\[\e[2m\]\W\[\e[0m\] \[\e[1;34m\]\$\[\e[0m\] ' bash --norc --noprofile"

cd "$WORK"
T -f /dev/null new-session -d -s demo -x "$COLS" -y "$ROWS" -c "$WORK" "$SHELL_CMD"
T set -g status off \; set -g pane-border-style fg=colour240 \; set -g pane-active-border-style fg=colour240 \; set -g default-command "$SHELL_CMD"
sleep 0.5

# Drive the session in the background while asciinema records an attached client.
(
  for _ in $(seq 1 40); do [ -n "$(T list-clients -t demo 2> /dev/null)" ] && break; sleep 0.25; done
  sleep 1.5
  P=demo:0.0
  type_in $P "npx teenybase create my-app --yes"; enter $P
  wait_for $P 'To get started' 600; sleep 2.5
  run $P "cd my-app" 0.035 0.3
  run $P "npx teenybase deploy --local --yes" 0.035 2
  # Second pane for requests; the dev server runs in the top one.
  T split-window -v -l 19 -t $P -c "$WORK/my-app"; sleep 0.8
  T select-pane -t $P
  type_in $P "npx teenybase dev"; enter $P
  wait_for $P 'Ready on' 180; sleep 2
  Q=demo:0.1
  T select-pane -t $Q; sleep 0.5
  run $Q "API=http://localhost:$PORT/api/v1" 0.035 0.3
  run $Q "curl -s \$API/table/users/auth/sign-up -H 'Content-Type: application/json' -d '{\"username\":\"ada\",\"email\":\"ada@example.com\",\"password\":\"correct-horse-9\",\"passwordConfirm\":\"correct-horse-9\",\"name\":\"Ada Lovelace\"}' | tee signup.json | jq .record" 0.012 2.5
  run $Q 'TOKEN=$(jq -r .token signup.json)' 0.035 0.3
  run $Q 'curl -s $API/table/users/list -H "Authorization: Bearer $TOKEN" | jq -c' 0.025 2.5
  run $Q 'curl -s $API/table/users/list | jq -c   # no token: the list rule returns nothing' 0.025 0
  sleep 5
  T detach-client -s demo
) &
DRIVER=$!

asciinema rec --overwrite -q --cols "$COLS" --rows "$ROWS" -c "tmux -L $SOCK attach -t demo" "$CAST" < /dev/null
wait "$DRIVER"

# Shorten the waits: replay the output of each slow step faster, keep every byte of it.
python3 -I - "$CAST" <<'PY'
import json, sys
path = sys.argv[1]
lines = open(path, encoding='utf-8').read().splitlines()
header, events = lines[0], [json.loads(l) for l in lines[1:]]
# Drop the tmux detach at the end (it leaves the alternate screen and clears it); the GIF ends
# on the last real output.
for i, ev in enumerate(events):
    if '\x1b[?1049l' in ev[2] or '[detached' in ev[2]:
        events = events[:i]
        break

def find(text, start=0):
    acc = ''
    for i in range(start, len(events)):
        if events[i][1] == 'o':
            acc = (acc + events[i][2])[-4000:]
            if text in acc:
                return i
    raise SystemExit(f'marker not found: {text!r}')

# (start event, end event, seconds the segment takes on screen); in order, non-overlapping.
segs = []
a = find('Installing dependencies'); b = find('added ', a); segs.append((a, b, 2.0))
a = find('deploy --local --yes', b); b = find('Migrations applied', a); segs.append((a, b, 3.0))
a = find('npx teenybase dev', b); b = find('Ready on', a); segs.append((a, b, 3.0))
spans = [(events[s][0], events[e][0], d) for s, e, d in segs]

def warp(t):
    lost = 0.0
    for ts, te, d in spans:
        span = te - ts
        if span <= d:
            continue
        if t >= te:
            lost += span - d
        elif t > ts:
            return t - lost - (t - ts) * (1 - d / span)
    return t - lost

times = [warp(ev[0]) for ev in events]

# Typing: the driver sends one key at a time, and a busy machine can stall a key for seconds.
# Keep the rhythm of a person typing: at most 90 ms between two echoed keys.
def typed(ev):
    return ev[1] == 'o' and len(ev[2]) <= 3 and not any(ch in ev[2] for ch in '\r\n\x1b')
out, prev_in, prev_out = [], 0.0, 0.0
for i, (ev, t) in enumerate(zip(events, times)):
    gap = t - prev_in
    if i > 0 and typed(ev) and typed(events[i - 1]):
        gap = min(gap, 0.09)
    prev_in, prev_out = t, prev_out + max(gap, 0.0)
    out.append(prev_out)

with open(path, 'w', encoding='utf-8') as f:
    f.write(header + '\n')
    for ev, t in zip(events, out):
        f.write(json.dumps([round(t, 6), ev[1], ev[2]], ensure_ascii=False) + '\n')
PY

agg --theme github-dark --font-family "JetBrains Mono" --font-size 20 --line-height 1.3 \
    --idle-time-limit 3 --fps-cap 15 --last-frame-duration 6 "$CAST" "$WORK/quickstart.raw.gif"
gifsicle -O3 --lossy=30 --colors 64 "$WORK/quickstart.raw.gif" -o "$OUT/quickstart.gif"
# Static fallback (prefers-reduced-motion): the last frame.
agg --theme github-dark --font-family "JetBrains Mono" --font-size 20 --line-height 1.3 \
    --idle-time-limit 3 --select 100% "$CAST" "$WORK/quickstart.last.gif"
convert "$WORK/quickstart.last.gif[0]" "$OUT/quickstart.png"
pngquant --force --skip-if-larger --quality 80-95 --output "$OUT/quickstart.png" "$OUT/quickstart.png" || true
ls -la "$OUT/quickstart.gif" "$OUT/quickstart.png"
