#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BINARY=/Users/jamie/Projects/active/rust-pi-build/target/release/frank_accept
TMP="$(mktemp -d)"
PID=
cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
for mode in answer error slow; do
  PORT_FILE="$TMP/$mode.port"
  python3 "$HERE/canned_sse_stub.py" "$mode" > "$PORT_FILE" 2> "$TMP/$mode.stub.stderr" &
  PID=$!
  for _ in $(seq 1 100); do
    [[ -s "$PORT_FILE" ]] && break
    sleep 0.05
  done
  [[ -s "$PORT_FILE" ]] || { cat "$TMP/$mode.stub.stderr" >&2; exit 1; }
  PORT="$(cat "$PORT_FILE")"
  NAME="$mode"
  [[ "$mode" == slow ]] && NAME=cancelled
  OUT="$HERE/$NAME.jsonl"
  ERR="$TMP/$mode.stderr.jsonl"
  if [[ "$mode" == slow ]]; then
    { printf '%s\n' '{"op":"submit","turn_id":1,"text":"Reply with exactly OK."}'; sleep 1; printf '%s\n' '{"op":"cancel","turn_id":1}' '{"op":"shutdown"}'; } | "$BINARY" agent --endpoint "http://127.0.0.1:$PORT/v1/chat/completions" --model fixture --cwd /tmp --wall-secs 60 --events-path "$TMP/$mode.events.jsonl" > "$OUT" 2> "$ERR" || STATUS=$?
  else
    printf '%s\n' '{"op":"submit","turn_id":1,"text":"say fixture answer"}' '{"op":"shutdown"}' | "$BINARY" agent --endpoint "http://127.0.0.1:$PORT/v1/chat/completions" --model fixture --cwd /tmp --wall-secs 60 --events-path "$TMP/$mode.events.jsonl" > "$OUT" 2> "$ERR" || STATUS=$?
  fi
  STATUS="${STATUS:-0}"
  printf 'MODE=%s COMMAND=' "$mode"
  printf 'frank_accept agent --endpoint http://127.0.0.1:%s/v1/chat/completions --model fixture --cwd /tmp --wall-secs 60' "$PORT"
  [[ "$mode" == slow ]] && printf ' stdin=submit,sleep 1,cancel,shutdown'
  printf ' EXIT=%s BYTES=' "$STATUS"
  wc -c < "$OUT" | tr -d ' '
  printf 'STDERR_TERMINAL='
  python3 -c 'import json,sys; [print(x.rstrip()) for x in open(sys.argv[1]) if json.loads(x).get("type")=="terminal"]' "$ERR"
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=
  unset STATUS
 done
