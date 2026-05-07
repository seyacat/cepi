#!/usr/bin/env bash
# Loop Claude Code on a paper checklist until it reports done.
# Usage: scripts/run-until-done.sh <path/to/paper.md> [--max N]
set -euo pipefail

PAPER="${1:-}"
MAX="${MAX:-50}"
if [[ -z "$PAPER" ]]; then
  echo "usage: $0 <paper.md> [--max N]" >&2
  exit 2
fi
if [[ ! -f "$PAPER" ]]; then
  echo "no existe: $PAPER" >&2
  exit 2
fi
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max) MAX="$2"; shift 2 ;;
    *) echo "arg desconocido: $1" >&2; exit 2 ;;
  esac
done

command -v claude >/dev/null || { echo "claude CLI no encontrado en PATH" >&2; exit 127; }
command -v jq >/dev/null     || { echo "jq no encontrado en PATH" >&2; exit 127; }

SESSION=""
STATUS_PROMPT=$(cat <<EOF
Revisá el checklist activo en $PAPER y respondé EXCLUSIVAMENTE con JSON válido en una sola línea, sin texto adicional, sin code fences:
{"done": true|false, "pending": <int>, "next": "<descripcion corta del proximo item o null>"}
done=true solo si TODOS los \`[ ]\` del checklist activo están marcados \`[x]\`.
EOF
)
WORK_PROMPT="Continuá ejecutando los items pendientes del checklist de $PAPER sin pedir confirmación intermedia. Marcá \`[x]\` los que completes."

ask() {
  local prompt="$1"
  local args=(-p "$prompt" --output-format json --permission-mode acceptEdits)
  if [[ -n "$SESSION" ]]; then
    args+=(--resume "$SESSION")
  fi
  claude "${args[@]}"
}

extract_inner_json() {
  # Toma el .result del envoltorio de claude -p --output-format json
  # y devuelve el último objeto JSON {"done":...} que aparezca.
  jq -r '.result' <<<"$1" \
    | grep -oE '\{[^{}]*"done"[^{}]*\}' \
    | tail -n1
}

i=0
while (( i < MAX )); do
  i=$((i+1))
  echo "── iter $i: consultando estado ──"
  RESP=$(ask "$STATUS_PROMPT")
  SESSION=$(jq -r '.session_id // empty' <<<"$RESP")
  INNER=$(extract_inner_json "$RESP" || true)
  if [[ -z "$INNER" ]]; then
    echo "respuesta sin JSON {done:...}; corto por seguridad."
    echo "$RESP" | jq -r '.result' || echo "$RESP"
    exit 1
  fi
  DONE=$(jq -r '.done' <<<"$INNER")
  PENDING=$(jq -r '.pending // "?"' <<<"$INNER")
  NEXT=$(jq -r '.next // ""' <<<"$INNER")
  echo "  done=$DONE pending=$PENDING next=$NEXT"

  if [[ "$DONE" == "true" ]]; then
    echo "✓ checklist completo en $PAPER (iter $i)"
    exit 0
  fi

  echo "── iter $i: pidiendo continuar ──"
  WRESP=$(ask "$WORK_PROMPT")
  SESSION=$(jq -r '.session_id // empty' <<<"$WRESP")
done

echo "✗ alcanzado MAX=$MAX iteraciones sin terminar" >&2
exit 1
