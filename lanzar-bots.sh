#!/usr/bin/env bash
# lanzar-bots.sh — arranca el browser-bot de testing (6 ventanas Chrome, una por
# rol, auto-logueadas) con un solo comando. Idempotente: si ya está corriendo,
# no relanza. Debe correr en tu sesión gráfica (con DISPLAY), NO en el sandbox.
#
#   ./lanzar-bots.sh              # 6 roles contra localhost:5174
#   ROLES=primario,super ./lanzar-bots.sh   # subconjunto
#
# La API queda en http://localhost:8899 y el agente la maneja por curl.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8899}"
LOG="${LOG:-/tmp/cepi-bot.log}"

if curl -sf -m 3 "http://localhost:${PORT}/status" >/dev/null 2>&1; then
  echo "✔ El bot ya está corriendo en http://localhost:${PORT}  (nada que hacer)"
  echo "  Para reiniciarlo:  pkill -f browser-bot/bot.cjs  &&  ./lanzar-bots.sh"
  exit 0
fi

echo "▶ Lanzando browser-bot…  (log: ${LOG})"
nohup bash scripts/browser-bot/start.sh > "${LOG}" 2>&1 &

# Espera a que la API responda (hasta ~15s).
for _ in $(seq 1 15); do
  if curl -sf -m 2 "http://localhost:${PORT}/status" >/dev/null 2>&1; then
    n=$(curl -sf -m 2 "http://localhost:${PORT}/status" | grep -o '"role"' | wc -l | tr -d ' ')
    echo "✔ Bot listo — ${n} ventana(s). API: http://localhost:${PORT}"
    exit 0
  fi
  sleep 1
done

echo "⚠ El bot no respondió a tiempo. Revisá el log: ${LOG}" >&2
exit 1
