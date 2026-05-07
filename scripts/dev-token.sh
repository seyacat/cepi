#!/bin/bash
# Print an admin JWT for the seeded admin user. Saves typing in dev / smoke
# tests when calling cepi-bot or TodoERP API directly.
set -e
HOST="${HOST:-http://localhost:3001}"
EMAIL="${EMAIL:-admin@erp.com}"
PASSWORD="${PASSWORD:-Admin123!}"

curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  "$HOST/api/auth/login" | grep -oE '"token":"[^"]+"' | sed -E 's/"token":"([^"]+)"/\1/'
