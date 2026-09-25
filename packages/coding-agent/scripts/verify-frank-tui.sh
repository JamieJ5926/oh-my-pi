#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
binary="$repo_root/packages/coding-agent/dist/omp"
session="frank-tui-test-$$"
timeout_secs=240
drive_model="cli-proxy/codex.gpt-6-luna"
dry_run=false

while (($#)); do
  case "$1" in
    --binary) (($# >= 2)) || { echo "missing value for --binary" >&2; exit 2; }; binary="$2"; shift 2 ;;
    --session) (($# >= 2)) || { echo "missing value for --session" >&2; exit 2; }; session="$2"; shift 2 ;;
    --timeout) (($# >= 2)) || { echo "missing value for --timeout" >&2; exit 2; }; timeout_secs="$2"; shift 2 ;;
    --model) (($# >= 2)) || { echo "missing value for --model" >&2; exit 2; }; drive_model="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -x "$binary" ]] || { echo "Binary not executable: $binary" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is unavailable" >&2; exit 1; }
if $dry_run; then
  echo "Binary available: $binary"
  echo "tmux available: $(command -v tmux)"
  echo "drive model: $drive_model"
  echo "Dry run checks passed."
  exit 0
fi

if ! [[ "$timeout_secs" =~ ^[1-9][0-9]*$ ]]; then
  echo "--timeout must be a positive integer" >&2
  exit 2
fi
if tmux has-session -t "$session" 2>/dev/null; then
  echo "tmux session already exists: $session" >&2
  exit 1
fi

cleanup() { tmux kill-session -t "$session" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# A token cell is a non-zero count: "Σ 15.6k", "2.1k", "408", "15K tok". A bare
# "1" (as in "frank-implementer ×1") is not a token cell, so it must not match.
token_re='(Σ[[:space:]]*[1-9][0-9]*(\.[0-9]+)?|[1-9][0-9]*(\.[0-9]+)?[kKmM]|[1-9][0-9]{2,})'

# A model badge is the Subagents HUD's bracketed resolved-model id, which always
# carries a dotted identifier. Keying on it keeps transcript text (briefs, intake
# lines) from satisfying these assertions: a seat badge such as
# ⟨frank-poteto-agent⟩ has no dot and so never counts as the model.
model_badge_re='⟨[^⟩]*[A-Za-z][A-Za-z0-9._-]*\.[A-Za-z0-9._-]+[^⟩]*⟩'

# The parent HUD row carries PotetoChainProbe, its ⟨frank-poteto-agent⟩ seat, a
# token cell and a model badge. The child HUD row beneath it is indented and
# carries its own frank-implementer seat, a token cell and a model badge.
assert_rows() {
  local frame="$1" parent_no parent_line child_line
  parent_line="$(printf '%s\n' "$frame" | grep -E 'PotetoChainProbe' | grep -F '⟨frank-poteto-agent⟩' | grep -E "$token_re" | grep -E "$model_badge_re" | head -n 1)"
  [[ -n "$parent_line" ]] || return 1
  parent_no="$(printf '%s\n' "$frame" | grep -nF "$parent_line" | head -n 1 | cut -d: -f1)"
  [[ -n "$parent_no" ]] || return 1
  child_line="$(printf '%s\n' "$frame" | awk -v p="$parent_no" 'NR>p' | grep -E '(└─|↳|^[[:space:]]{2,})' | grep -F 'frank-implementer' | grep -E "$token_re" | grep -E "$model_badge_re" | head -n 1)"
  [[ -n "$child_line" ]] || return 1
  PARENT_ROW="$parent_line"
  CHILD_ROW="$child_line"
  return 0
}

tmux new-session -d -s "$session" -x 200 -y 55 -c "$repo_root" \
  env -u HERDR_PANE_ID -u HERDR_RUN_ID -u HERDR_ROLE \
  FRANK_BIN=/Users/jamie/.local/bin/frank \
  FRANK_ACCEPT_BIN=/Users/jamie/.local/bin/frank_accept \
  OMP_SESSION_MODE=PRESENT "$binary" --model "$drive_model"
tmux resize-window -t "$session" -x 200 -y 55
sleep 5

# The dispatch guard refuses any task call whose brief lacks a delegation
# declaration, so both the pot's own call and the child's brief carry one.
prompt='Use the task tool exactly once, with agent frank-poteto-agent and name PotetoChainProbe. Its task text must contain the line "delegable: none - the child reads the file itself, no grandchildren" and must order exactly one child: agent frank-implementer, name FrankRowsRead, whose brief also carries "delegable: none" and reads packages/coding-agent/package.json. Dispatch nothing else and do not read the file yourself.'
tmux send-keys -t "$session" -l "$prompt"
tmux send-keys -t "$session" Enter

last_frame=''
start=$SECONDS
while (( SECONDS - start < timeout_secs )); do
  sleep 2
  last_frame="$(tmux capture-pane -p -S -1000 -t "$session" 2>/dev/null || true)"
  if assert_rows "$last_frame"; then
    printf '=== Captured Frank TUI Frame ===\n%s\n\n' "$last_frame"
    printf 'parent row: %s\n' "$PARENT_ROW"
    printf 'child row:  %s\n' "$CHILD_ROW"
    echo "Verification SUCCESS: the Frank parent and its indented child both carry a description, a non-zero token count and a model."
    exit 0
  fi
done

printf '%s\n' "$last_frame"
echo "Timed out waiting for the Frank parent/child rows with description, tokens and model." >&2
exit 1