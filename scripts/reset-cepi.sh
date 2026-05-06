#!/bin/bash
# Reset the cepi medical project database to a known state.
#
# Layers the medical seeds on top of a clean TodoERP base. Composes (does not
# duplicate) the upstream TodoERP reset.
#
# Order:
#   1. TodoERP/backend/scripts/reset-db.sh     (schema + base seed + Phase 1
#                                               migrations + permission seeds)
#   2. TodoERP/database/medical-seed/apply.sh  (entity_definitions + clinical
#                                               roles/permissions + ISIC
#                                               models + form_configs +
#                                               navs_configs)
#   3. (optional) seeder/run.sh                synthetic ~50 patients, ~150
#                                               episodes, ~120 images,
#                                               classifications, reminders.
#
# Usage:
#   bash scripts/reset-cepi.sh                 # base + medical (no fake data)
#   bash scripts/reset-cepi.sh --with-fake-data
#   bash scripts/reset-cepi.sh --with-invoicing-test-data --with-fake-data
set -e

WITH_FAKE=0
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --with-fake-data) WITH_FAKE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TODOERP="$ROOT/TodoERP"

echo "[reset-cepi] step 1: TodoERP base reset"
bash "$TODOERP/backend/scripts/reset-db.sh" "${PASSTHROUGH[@]}"

echo "[reset-cepi] step 2: medical seeds"
bash "$TODOERP/database/medical-seed/apply.sh"

if [ "$WITH_FAKE" = "1" ]; then
  echo "[reset-cepi] step 3: synthetic clinical dataset"
  bash "$TODOERP/database/medical-seed/seeder/run.sh"
fi

echo "[reset-cepi] done."
