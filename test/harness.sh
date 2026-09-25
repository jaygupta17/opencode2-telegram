#!/usr/bin/env bash
# Isolated-HOME plugin load harness. Never touches the live opencode serve.
#
#   Test A: `opencode run --standalone` — fast green/red loop (~60s).
#   Test B: `opencode serve` on a random port — the real target process.
#
# Usage: bash test/harness.sh [a|b|both]   (default: both)
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
T="$REPO/.harness-home"
PORT="${TG_HARNESS_PORT:-49197}"
MODE="${1:-both}"
FAILED=0

fresh_home() {
  rm -rf "$T"
  rm -f "$REPO/.tg-proof"
  mkdir -p "$T/.config/opencode" "$T/.local/share"
  cat > "$T/.config/opencode/opencode.json" <<EOF
{
  "plugins": ["$REPO/src"]
}
EOF
}

grep_log() { # $1 = file, $2.. = patterns (ERE, any match = ok)
  local file="$1"; shift
  local pat
  pat=$(IFS='|'; echo "$*")
  grep -E "$pat" "$file" >/dev/null 2>&1
}

report() { # $1 = label, $2 = file, $3.. = required patterns
  local label="$1" file="$2"; shift 2
  local missing=()
  local pat
  for pat in "$@"; do
    grep -E "$pat" "$file" >/dev/null 2>&1 || missing+=("$pat")
  done
  if [ ${#missing[@]} -eq 0 ]; then
    echo "PASS: $label"
  else
    echo "FAIL: $label — missing: ${missing[*]}"
    echo "--- log tail ---"
    tail -n 40 "$file"
    FAILED=1
  fi
}

test_a() {
  echo "== Test A: opencode run --standalone =="
  fresh_home
  env HOME="$T" XDG_CONFIG_HOME="$T/.config" \
    timeout 120 opencode run --standalone --print-logs --log-level debug \
    "Reply with only OK." >"$T/run.log" 2>&1
  report "standalone load" "$T/run.log" \
    "loading plugin.*entrypoint=file://.*src/index.ts"
  report "standalone proof" "$REPO/.tg-proof" \
    "\[tg\] setup" \
    "\[tg\] storage ok" \
    "\[tg\] event-type" \
    "\[tg\] cleanup"
  if grep -q "failed to load plugin" "$T/run.log"; then
    echo "FAIL: plugin load error present"
    FAILED=1
  fi
  grep -E "\[tg\] event-type|OK" "$T/run.log" | head -n 20
}

test_b() {
  echo "== Test B: opencode serve :$PORT (target process) =="
  fresh_home
  env HOME="$T" XDG_CONFIG_HOME="$T/.config" OPENCODE_PASSWORD=tg-harness \
    opencode serve --hostname 127.0.0.1 --port "$PORT" --print-logs --log-level debug \
    >"$T/serve.log" 2>&1 &
  local pid=$!
  local up=0
  for _ in $(seq 1 40); do
    if curl -sf -m 1 -u opencode:tg-harness "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1; then
      up=1
      break
    fi
    sleep 0.5
  done
  if [ "$up" != 1 ]; then
    echo "FAIL: serve did not come up"
    tail -n 40 "$T/serve.log"
    kill "$pid" 2>/dev/null
    FAILED=1
    return
  fi
  # serve loads location plugins lazily — first location/plugin API call boots them
  curl -s -m 5 -u opencode:tg-harness "http://127.0.0.1:$PORT/api/location" >/dev/null
  curl -s -m 5 -u opencode:tg-harness "http://127.0.0.1:$PORT/api/plugin" >/dev/null
  local proof_ok=0
  for _ in $(seq 1 30); do
    if grep -qF '[tg] setup' "$REPO/.tg-proof" 2>/dev/null; then
      proof_ok=1
      break
    fi
    sleep 1
  done
  [ "$proof_ok" = 1 ] || echo "NOTE: setup not yet proven when killed"
  curl -s -m 5 -u opencode:tg-harness "http://127.0.0.1:$PORT/api/plugin" \
    >"$T/pluginlist.json" 2>/dev/null || true
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  sleep 1
  report "serve load" "$T/serve.log" \
    "server listening"
  report "serve plugin list" "$T/pluginlist.json" \
    '"id":"opencode-telegram"'
  report "serve proof" "$REPO/.tg-proof" \
    "\[tg\] setup" \
    "\[tg\] storage ok" \
    "\[tg\] cleanup"
  if grep -q "failed to load plugin" "$T/serve.log"; then
    echo "FAIL: plugin load error present"
    FAILED=1
  fi
}

case "$MODE" in
  a) test_a ;;
  b) test_b ;;
  both) test_a; test_b ;;
  *) echo "usage: $0 [a|b|both]"; exit 2 ;;
esac

echo "== result: $([ $FAILED -eq 0 ] && echo PASS || echo FAIL) =="
exit $FAILED
