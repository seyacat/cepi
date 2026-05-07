#!/bin/bash
# End-to-end smoke check for the cepi stack. Hits every service from outside
# and prints a one-line status per check. Returns non-zero if any fails.
set -u

PASS=0; FAIL=0
trap 'echo; echo "Resumen: $PASS pasados, $FAIL fallidos"; [ "$FAIL" -eq 0 ]' EXIT

check () {
  local label="$1" url="$2" expect="${3:-}"
  if out=$(curl -fsS --max-time 5 "$url" 2>&1); then
    if [ -z "$expect" ] || echo "$out" | grep -q "$expect"; then
      echo "  ✓ $label  ($url)"
      PASS=$((PASS+1)); return
    fi
  fi
  echo "  ✗ $label  ($url) — falló"
  FAIL=$((FAIL+1))
}

echo "[smoke] cepi stack"
check "TodoERP backend"   http://localhost:3001/health   '"ok":true'
check "cepi-bot"          http://localhost:3002/health   '"ok":true'
check "TodoERP frontend"  http://localhost:5173          ''
check "cepi-frontend"     http://localhost:5174          ''
# cepi-isic is optional (Python venv must be set up)
if curl -fsS --max-time 2 http://localhost:8000/health > /dev/null 2>&1; then
  check "cepi-isic"        http://localhost:8000/health   '"ok":true'
else
  echo "  ⊝ cepi-isic     (no levantado — opcional)"
fi

# Login + chat round-trip
echo "[smoke] auth + chat"
JWT=$(bash "$(dirname "$0")/dev-token.sh" 2>/dev/null || true)
if [ -n "$JWT" ]; then
  echo "  ✓ login admin → JWT (${#JWT} chars)"
  PASS=$((PASS+1))
  if curl -fsS --max-time 5 -H "Authorization: Bearer $JWT" \
       -H "Content-Type: application/json" \
       -d '{"message":"/help"}' \
       http://localhost:3002/api/bot/chat | grep -q "Comandos del bot"; then
    echo "  ✓ /help round-trip"; PASS=$((PASS+1))
  else
    echo "  ✗ /help round-trip"; FAIL=$((FAIL+1))
  fi
else
  echo "  ✗ login admin"; FAIL=$((FAIL+1))
fi
