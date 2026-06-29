#!/usr/bin/env bash
# Arranca el cepi browser-bot (debugger multi-perfil).
# Debe correr en un entorno con DISPLAY (tu sesión gráfica), NO en el sandbox
# del agente. Ejemplos:
#   bash scripts/browser-bot/start.sh                      # foreground
#   nohup bash scripts/browser-bot/start.sh >/tmp/cepi-bot.log 2>&1 &   # service
#   ROLES=primario,derma1 bash scripts/browser-bot/start.sh
cd "$(dirname "$0")"
if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then
  echo "AVISO: no hay DISPLAY/WAYLAND_DISPLAY — Chrome necesita entorno gráfico." >&2
fi
exec node bot.cjs "$@"
