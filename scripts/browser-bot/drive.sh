#!/usr/bin/env bash
# CLI del cepi browser-bot. Maneja las ventanas por su API HTTP.
#   ./drive.sh status
#   ./drive.sh shot <rol> [true]        # screenshot -> shots/<rol>.png
#   ./drive.sh text <rol>               # innerText visible
#   ./drive.sh console <rol>            # console/errores de la página
#   ./drive.sh goto <rol> <url|/ruta>
#   ./drive.sh click <rol> "<texto>"
#   ./drive.sh clicksel <rol> "<selector>"
#   ./drive.sh fill <rol> "<selector>" "<texto>" [true=submit]
#   ./drive.sh reload <rol>
#   ./drive.sh eval <rol> "<js>"        # ej: "() => localStorage.getItem('cepi.jwt')"
# Roles: primario derma1 derma2 residente super admin
H="${BOT:-http://localhost:8899}"
post() { curl -s -X POST "$H/act" -H 'Content-Type: application/json' -d "$1"; echo; }
cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  status)   curl -s "$H/status"; echo ;;
  shot)     post "{\"role\":\"$1\",\"do\":\"shot\",\"fullPage\":${2:-false}}" ;;
  text)     post "{\"role\":\"$1\",\"do\":\"text\"}" ;;
  console)  post "{\"role\":\"$1\",\"do\":\"console\"}" ;;
  goto)     post "{\"role\":\"$1\",\"do\":\"goto\",\"url\":\"$2\"}" ;;
  click)    post "{\"role\":\"$1\",\"do\":\"click\",\"text\":\"$2\"}" ;;
  clicksel) post "{\"role\":\"$1\",\"do\":\"click\",\"sel\":\"$2\"}" ;;
  fill)     post "{\"role\":\"$1\",\"do\":\"fill\",\"sel\":\"$2\",\"text\":\"$3\",\"submit\":${4:-false}}" ;;
  reload)   post "{\"role\":\"$1\",\"do\":\"reload\"}" ;;
  eval)     post "{\"role\":\"$1\",\"do\":\"eval\",\"fn\":\"$2\"}" ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
