#!/usr/bin/env bash
# Lanza bakeoff.py con el entorno CUDA armado.
#
#   ./run.sh --grupo rapido
#   ./run.sh --listar
#   ./run.sh -c 'import ctranslate2; print(ctranslate2.__version__)'
#
# Por qué existe este wrapper: ctranslate2 hace dlopen de libcublas.so.12 y
# libcudnn en tiempo de ejecución y NO las busca donde las deja pip. Sin
# LD_LIBRARY_PATH apuntando a los paquetes nvidia-*-cu12 del venv, falla con
# "Library libcublas.so.12 is not found" aunque nvidia-smi funcione perfecto.
set -euo pipefail
cd "$(dirname "$0")"

[[ -x .venv/bin/python ]] || { echo "corré ./setup.sh primero" >&2; exit 1; }

# `nvidia` es un namespace package: su __file__ es None, así que el
# os.path.dirname(nvidia.__file__) que sugiere media internet revienta.
# submodule_search_locations es la forma que sí funciona.
NV_LIBS=$(.venv/bin/python - <<'PY'
import glob, importlib.util, os
spec = importlib.util.find_spec("nvidia")
dirs = []
for raiz in (spec.submodule_search_locations or []) if spec else []:
    dirs += glob.glob(os.path.join(raiz, "*", "lib"))
print(os.pathsep.join(sorted(set(dirs))))
PY
)
[[ -n "$NV_LIBS" ]] && export LD_LIBRARY_PATH="${NV_LIBS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# los pesos viven en models/hf/, que está en .gitignore junto con el audio
export HF_HOME="${HF_HOME:-$PWD/models/hf}"

case "${1:-}" in
  -c)   shift; exec .venv/bin/python -c "$@" ;;      # snippet suelto
  *.py) exec .venv/bin/python "$@" ;;                # otro script del directorio
  *)    exec .venv/bin/python bakeoff.py "$@" ;;     # el bake-off
esac
