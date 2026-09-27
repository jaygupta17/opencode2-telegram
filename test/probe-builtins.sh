#!/usr/bin/env bash
# Isolated verification probe for built-in command APIs + custom command catalog.
# Usage: bash test/probe-builtins.sh
set -u
T=/tmp/opencode/probe-home; P=49203
R="http://127.0.0.1:$P"
A=(curl -s -m 20 -u opencode:probe)
JQ() { python3 -c "$1"; }

rm -rf "$T"; mkdir -p "$T/proj" "$T/.config/opencode/commands"
printf 'Review \$ARGUMENTS for bugs and missing tests.\n' > "$T/.config/opencode/commands/review.md"

env HOME="$T" XDG_CONFIG_HOME="$T/.config" OPENCODE_PASSWORD=probe \
  opencode serve --hostname 127.0.0.1 --port $P >"$T/serve.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 60); do
  "${A[@]}" "$R/api/info" >/dev/null 2>&1 && break; sleep 0.5
done
echo "serve up"; "${A[@]}" "$R/api/location" >/dev/null; "${A[@]}" "$R/api/plugin" >/dev/null; sleep 2

echo "== 1. command.list (custom review.md visible?)"
"${A[@]}" "$R/api/command" | head -c 400; echo

SID=$("${A[@]}" -X POST "$R/api/session" -H 'content-type: application/json' \
  -d "{\"title\":\"probe\",\"location\":{\"directory\":\"$T/proj\"}}" \
  | JQ 'import json,sys; d=json.load(sys.stdin); print((d.get("data") or d)["id"])')
echo "== session: $SID"

echo "== 2. command compact (acceptance)"
"${A[@]}" -X POST "$R/api/session/$SID/command" -H 'content-type: application/json' \
  -d '{"name":"compact","text":""}' -w '\nHTTP %{http_code}\n' | tail -3

echo "== 3. command init (acceptance)"
"${A[@]}" -X POST "$R/api/session/$SID/command" -H 'content-type: application/json' \
  -d '{"name":"init","text":""}' -w '\nHTTP %{http_code}\n' | tail -3
"${A[@]}" -X POST "$R/api/session/$SID/interrupt" >/dev/null; sleep 2

echo "== 4. command review (custom, with args)"
"${A[@]}" -X POST "$R/api/session/$SID/command" -H 'content-type: application/json' \
  -d '{"name":"review","text":"src/app.ts"}' -w '\nHTTP %{http_code}\n' | tail -3
"${A[@]}" -X POST "$R/api/session/$SID/interrupt" >/dev/null; sleep 2

echo "== 5. real edit turn -> wait for completion"
"${A[@]}" -X POST "$R/api/session/$SID/prompt" -H 'content-type: application/json' \
  -d '{"text":"Create a file hello.txt with exactly the content: hi. Then reply done."}' >/dev/null
for i in $(seq 1 90); do
  OUT=$("${A[@]}" "$R/api/session/$SID" | JQ 'import json,sys; d=json.load(sys.stdin); s=(d.get("data") or d); print(s.get("outcome") or "")' 2>/dev/null)
  [ -n "$OUT" ] && { echo "outcome: $OUT"; break; }
  sleep 2
done
ls -la "$T/proj"

echo "== 6. messages (last ids)"
"${A[@]}" "$R/api/session/$SID/message" | JQ '
import json,sys
d=json.load(sys.stdin); msgs=d.get("data") if isinstance(d,dict) else d
for m in (msgs or [])[-4:]:
    print((m.get("type") or m.get("role")), m.get("id"))
'

LAST_A=$("${A[@]}" "$R/api/session/$SID/message" | JQ '
import json,sys
d=json.load(sys.stdin); msgs=d.get("data") if isinstance(d,dict) else d
ids=[m["id"] for m in (msgs or []) if (m.get("type") or m.get("role"))=="assistant"]
print(ids[-1] if ids else "")')
LAST_ANY=$("${A[@]}" "$R/api/session/$SID/message" | JQ '
import json,sys
d=json.load(sys.stdin); msgs=d.get("data") if isinstance(d,dict) else d
print(msgs[-1]["id"] if msgs else "")')
echo "last assistant: $LAST_A | last any: $LAST_ANY"

echo "== 7. revert stage (assistant msg)"
"${A[@]}" -X POST "$R/api/session/$SID/revert/stage" -H 'content-type: application/json' \
  -d "{\"messageID\":\"$LAST_A\"}" -w '\nHTTP %{http_code}\n' | tail -4

echo "== 8. revert commit"
"${A[@]}" -X POST "$R/api/session/$SID/revert/commit" -w '\nHTTP %{http_code}\n' | tail -2
ls -la "$T/proj"

echo "== 9. did hello.txt come back? (redo semantics check: re-prompt)"
echo "(files above)"
echo "PROBE DONE"
