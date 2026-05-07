#!/bin/bash
# One-shot CLI for cepi-bot: pipes a message through /api/bot/chat using
# the admin JWT and prints the response (compact). Maintains session_id
# in $TMPDIR/cepi-session for multi-turn conversations.
#
# Usage:
#   scripts/dev-chat.sh "pacientes"
#   scripts/dev-chat.sh "/help"
#   scripts/dev-chat.sh --new "activar paciente <uuid>"   # starts a new session
set -e
TMPSID="${TMPDIR:-/tmp}/cepi-session"

if [ "$1" = "--new" ]; then
  rm -f "$TMPSID"
  shift
fi

MESSAGE="$1"
[ -z "$MESSAGE" ] && { echo "usage: $0 [--new] '<message>'"; exit 1; }

JWT="$(bash "$(dirname "$0")/dev-token.sh")"
SID="$(cat "$TMPSID" 2>/dev/null || true)"
PAYLOAD="{\"message\": $(printf '%s' "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
[ -n "$SID" ] && PAYLOAD="$PAYLOAD, \"session_id\": \"$SID\""
PAYLOAD="$PAYLOAD}"

RESP="$(curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $JWT" \
  -d "$PAYLOAD" http://localhost:3002/api/bot/chat)"

echo "$RESP" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(json.dumps({k:r[k] for k in ("text","session_id","active_patient_id","active_episode_id","pending_action") if k in r}, indent=2, ensure_ascii=False))'

NEW_SID="$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))')"
[ -n "$NEW_SID" ] && echo "$NEW_SID" > "$TMPSID"
