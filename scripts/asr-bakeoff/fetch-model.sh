#!/usr/bin/env bash
# Baja un modelo de sherpa-onnx desde los releases de k2-fsa.
#
#   ./fetch-model.sh                          lista lo que hay para español
#   ./fetch-model.sh parakeet-tdt-0.6b-v3     baja y extrae en models/
#   ./fetch-model.sh cohere-transcribe        idem
#
# Resuelve el nombre exacto del asset consultando la API de GitHub en vez de
# hardcodear URLs: los nombres cambian entre releases y un 404 silencioso te
# deja depurando el modelo equivocado.
set -euo pipefail
cd "$(dirname "$0")"

REPO=k2-fsa/sherpa-onnx
TAG=asr-models
DEST=models
mkdir -p "$DEST"

listar() {
  python3 - "$REPO" "$TAG" <<'PY'
import json, sys, urllib.request

repo, tag = sys.argv[1], sys.argv[2]

def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json"})
    import os
    if os.environ.get("GITHUB_TOKEN"):
        req.add_header("Authorization", "Bearer " + os.environ["GITHUB_TOKEN"])
    return json.load(urllib.request.urlopen(req, timeout=30))

rel = get(f"https://api.github.com/repos/{repo}/releases/tags/{tag}")
assets, page = [], 1
while True:
    lote = get(f"https://api.github.com/repos/{repo}/releases/{rel['id']}"
               f"/assets?per_page=100&page={page}")
    if not lote:
        break
    assets += lote
    page += 1
for a in assets:
    print(a["name"], a["browser_download_url"], sep="\t")
PY
}

if [[ $# -eq 0 ]]; then
  echo "Assets relevantes para español (patrón → lo que le pasás a este script):"
  echo
  listar | grep -Ei 'parakeet|cohere|canary|whisper.*(small|turbo|large)' \
         | cut -f1 | sort | sed 's/^/  /'
  echo
  echo "Si la lista sale vacía, la API de GitHub te está limitando por IP."
  echo "Exportá GITHUB_TOKEN=... y reintentá, o bajalo a mano desde:"
  echo "  https://github.com/$REPO/releases/tag/$TAG"
  exit 0
fi

PATRON="$1"
LINEA=$(listar | grep -i "$PATRON" | grep -Ei '\.tar\.bz2$|\.tar\.gz$' | head -1 || true)
if [[ -z "$LINEA" ]]; then
  echo "sin coincidencias para '$PATRON'. Corré ./fetch-model.sh sin argumentos." >&2
  exit 1
fi

NOMBRE=$(cut -f1 <<<"$LINEA")
URL=$(cut -f2 <<<"$LINEA")
DIR="${NOMBRE%.tar.*}"

if [[ -d "$DEST/$DIR" ]]; then
  echo "ya estaba: $DEST/$DIR"
else
  echo "bajando $NOMBRE…"
  curl -fL --progress-bar -o "$DEST/$NOMBRE" "$URL"
  tar -xf "$DEST/$NOMBRE" -C "$DEST"
  rm -f "$DEST/$NOMBRE"
fi

echo
echo "extraído en: $DEST/$DIR"
ls "$DEST/$DIR" | sed 's/^/  /'
echo
echo "No hace falta renombrarlo: backends.py resuelve el directorio por"
echo "subcadena, así que configs.py lo va a encontrar igual."
