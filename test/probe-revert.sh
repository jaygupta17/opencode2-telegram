#!/usr/bin/env bash
# Probe 2: clean edit turn -> revert stage/commit (no interrupts).
set -u
T=/tmp/opencode/probe2-home; P=49204
R="http://127.0.0.1:$P"
A=(curl -s -m 20 -u opencode:probe)
JQ() { python3 -c "$1"; }

rm -rf "$T"; mkdir -p "$T/proj" "$T/.config/opencode"
env HOME="$T" XDG_CONFIG_HOME="$T/.config" OPENCODE_PASSWORD=probe \
  opencode serve --hostname 127.0.0.1 --port $P >"$T/serve.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 60); do "${A[@]}" "$R/api/info" >/dev/null 2>&1 && break; sleep 0.5; done
"${A[@]}" "$R/api/location" >/dev/null; "${A[@]}" "$R/api/plugin" >/dev/null; sleep 2

SID=$("${A[@]}" -X POST "$R/api/session" -H 'content-type: application/json' \
  -d "{\"title\":\"probe2\",\"location\":{\"directory\":\"$T/proj\"}}" \
  | JQ 'import json,sys; d=json.load(sys.stdin); print((d.get("data") or d)["id"])')
echo "session: $SID"

"${A[@]}" -X POST "$R/api/session/$SID/prompt" -H 'content-type: application/json' \
  -d '{"text":"Create a file hello.txt containing exactly: hi. Then reply done."}' >/dev/null
for i in $(seq 1 90); do
  OUT=$("${A[@]}" "$R/api/session/$SID" | JQ 'import json,sys; d=json.load(sys.stdin); s=(d.get("data") or d); print(s.get("outcome") or "")' 2>/dev/null)
  [ -n "$OUT" ] && { echo "outcome: $OUT"; break; }
  sleep 2
done
echo "-- files after turn:"; ls "$T/proj"

LAST_A=$("${A[@]}" "$R/api/session/$SID/message" | JQ '
import json,sys
d=json.load(sys.stdin); msgs=d.get("data") if isinstance(d,dict) else d
ids=[m["id"] for m in (msgs or []) if (m.get("type") or m.get("role"))=="assistant"]
print(ids[-1] if ids else "")')
echo "-- last assistant msg: $LAST_A"

echo "-- stage with assistant message:"
"${A[@]}" -X POST "$R/api/session/$SID/revert/stage" -H 'content-type: application/json' \
  -d "{\"messageID\":\"$LAST_A\"}" -w '\nHTTP %{http_code}\n' | tail -4
echo "-- stage with files=false (metadata revert?):"
"${A[@]}" -X POST "$R/api/session/$SID/revert/stage" -H 'content-type: application/json' \
  -d "{\"messageID\":\"$LAST_A\",\"files\":false}" -w '\nHTTP %{http_code}\n' | tail -4
echo "-- revert state on session:"
"${A[@]}" "$R/api/session/$SID" | JQ 'import json,sys; d=json.load(sys.stdin); s=(d.get("data") or d); print(json.dumps(s.get("revert"))[:400])'

echo "-- clear stage:"
"${A[@]}" -X DELETE "$R/api/session/$SID/revert" -w '\nHTTP %{http_code}\n' | tail -2
echo "-- files after clear:"; ls "$T/proj"

echo "-- stage again + commit:"
"${A[@]}" -X POST "$R/api/session/$SID/revert/stage" -H 'content-type: application/json' -d "{\"messageID\":\"$LAST_A\"}" >/dev/null
"${A[@]}" -X POST "$R/api/session/$SID/revert/commit" -w '\nHTTP %{http_code}\n' | tail -2
echo "-- files after commit (hello.txt should be gone):"; ls "$T/proj"
echo "PROBE2 DONE"
