#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
binary="$repo_root/packages/coding-agent/dist/omp"
session="frank-tui-test-$$"
timeout_secs=180
dry_run=false

while (($#)); do
  case "$1" in
    --binary) (($# >= 2)) || { echo "missing value for --binary" >&2; exit 2; }; binary="$2"; shift 2 ;;
    --session) (($# >= 2)) || { echo "missing value for --session" >&2; exit 2; }; session="$2"; shift 2 ;;
    --timeout) (($# >= 2)) || { echo "missing value for --timeout" >&2; exit 2; }; timeout_secs="$2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -x "$binary" ]] || { echo "Binary not executable: $binary" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is unavailable" >&2; exit 1; }
if $dry_run; then
  echo "Binary available: $binary"
  echo "tmux available: $(command -v tmux)"
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
workdir="$repo_root"
if [[ "$binary" == "$repo_root/packages/coding-agent/dist/omp" ]]; then
  launch=("$binary")
else
  launch=("$binary")
fi
tmux new-session -d -s "$session" -x 180 -y 50 -c "$workdir" \
  env FRANK_BIN=/Users/jamie/.local/bin/frank \
  FRANK_ACCEPT_BIN=/Users/jamie/Projects/active/rust-pi-build/target/release/frank_accept \
  OMP_SESSION_MODE=PRESENT "${launch[@]}"
tmux resize-window -t "$session" -x 180 -y 50
sleep 4
tmux send-keys -t "$session" -l '/task agent:frank-poteto-agent task:"Read packages/coding-agent/package.json. Spawn one frank-implementer child to read that file and summarize dependencies."'
tmux send-keys -t "$session" Enter

last_frame=''
start=$SECONDS
while (( SECONDS - start < timeout_secs )); do
  last_frame="$(tmux capture-pane -p -t "$session" 2>/dev/null || true)"
  if printf '%s\n' "$last_frame" | grep -q 'frank-poteto-agent' &&
     printf '%s\n' "$last_frame" | grep -q 'frank-implementer'; then
    parent_line="$(printf '%s\n' "$last_frame" | grep 'frank-poteto-agent' | head -n 1)"
    child_line="$(printf '%s\n' "$last_frame" | grep 'frank-implementer' | head -n 1)"
    # 1. Parent row description is present and not blank
    has_desc=false
    if [[ -n "${parent_line#*frank-poteto-agent}" ]] && ! [[ "$parent_line" =~ frank-poteto-agent[[:space:]]*$ ]]; then
      has_desc=true
    fi
    # 2. Non-zero token count appears on at least one Frank row
    has_tokens=false
    if printf '%s\n' "$parent_line $child_line" | grep -Eq '[1-9][0-9]*[[:space:]]*(tokens|tok|[kKmM]|$)'; then
      has_tokens=true
    fi
    # 3. Resolved model string with thinking level appears
    has_model=false
    if printf '%s\n' "$parent_line $child_line" | grep -Eq ':[[:space:]]*(low|medium|high|xhigh|none)'; then
      has_model=true
    fi
    # 4. Child is indented or has tree rail under parent
    has_nesting=false
    if [[ "$child_line" =~ [│├└] ]] || [[ "$child_line" =~ ^[[:space:]]{2,} ]]; then
      has_nesting=true
    fi
    if $has_desc && $has_tokens && $has_model && $has_nesting; then
      printf '=== Captured Frank TUI Frame ===\n%s\n' "$last_frame"
      echo "Verification SUCCESS: Frank rows show description, non-zero tokens, model:thinking, and nested indentation."
      exit 0
    fi
  fi
  sleep 2
done
printf '%s\n' "$last_frame"
echo "Timed out waiting for Frank TUI rows and metadata." >&2
exit 1
