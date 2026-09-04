#!/usr/bin/env bash
# Prepara el entorno del bake-off.
#
#   ./setup.sh          con soporte GPU (default)
#   ./setup.sh --cpu    sin las libs de CUDA (mini-PC, VPS)
set -euo pipefail
cd "$(dirname "$0")"

CON_GPU=1
[[ "${1:-}" == "--cpu" ]] && CON_GPU=0

if ! command -v ffmpeg >/dev/null; then
  echo "falta ffmpeg:  sudo apt install ffmpeg" >&2
  exit 1
fi

# --copies es obligatorio, no una preferencia: /mnt/sda1 es NTFS (fuseblk) y los
# symlinks del venv se rompen ahí.
if [[ ! -d .venv ]]; then
  echo "== venv (--copies por NTFS) =="
  python3 -m venv --copies .venv
fi

echo "== dependencias =="
./.venv/bin/pip install -q --upgrade pip
if [[ $CON_GPU == 1 ]]; then
  ./.venv/bin/pip install -q -r requirements.txt
else
  grep -v '^nvidia-' requirements.txt | ./.venv/bin/pip install -q -r /dev/stdin
fi

echo "== verificación =="
./run.sh -c '
import numpy, jiwer, num2words, sherpa_onnx
from faster_whisper import WhisperModel
print("  sherpa-onnx", sherpa_onnx.__version__ if hasattr(sherpa_onnx,"__version__") else "?")
try:
    import ctranslate2
    print("  ctranslate2", ctranslate2.__version__,
          "| CUDA:", ctranslate2.get_cuda_device_count(), "dispositivo(s)")
except Exception as e:
    print("  ctranslate2 NO cargó:", e)
'

echo "== presupuesto de tokens del glosario =="
./run.sh glosario.py

echo
echo "Listo. Siguiente paso:"
echo "  1. copiá los dictados a audio/            (README §1)"
echo "  2. ./draft_refs.py                        borradores de referencia"
echo "  3. corregí refs/*.draft.txt y renombralos a .txt"
echo "  4. ./run.sh --grupo rapido"
echo
echo "Para los modelos de sherpa (parakeet / cohere / canary):"
echo "  ./fetch-model.sh parakeet-tdt-0.6b-v3"
