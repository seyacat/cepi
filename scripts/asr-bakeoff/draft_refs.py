#!/usr/bin/env python3
"""
Borradores de referencia, para no transcribir 30 dictados a mano desde cero.

    ./draft_refs.py

Corre el modelo más grande que entre en tu GPU sobre cada audio de audio/ y
escribe `refs/<nombre>.draft.txt` con un segmento por línea y su timestamp en
comentario, para que puedas ir corrigiendo mientras escuchás.

**El borrador NO es una referencia.** `bakeoff.py` solo lee `.txt`, nunca
`.draft.txt`, y avisa fuerte si encuentra borradores sin corregir. La razón no
es burocrática: si evaluás contra la salida de Whisper, estás midiendo *cuánto
se parece cada modelo a Whisper*, y Whisper gana por definición. El número
saldría precioso y no significaría nada.

Tres decisiones deliberadas de este script:

- **Sin `hotwords`.** Si el borrador viniera sesgado por el glosario, la
  referencia heredaría ese sesgo y el A/B de hotwords se mediría contra sí
  mismo. Es el error más fácil de cometer acá y el más difícil de detectar
  después.
- **Sin VAD.** El VAD recorta audio; para un borrador preferís que sobre texto
  (lo borrás) a que falte (no te enterás de que falta).
- **`beam_size=5`.** Acá la latencia no importa, la calidad sí.

Corregí **verbatim**: lo que se dijo, no lo que debería ir en la ficha. Si el
médico dijo "eeeh" y se corrigió, va tal cual. El WER mide reconocimiento; la
limpieza es trabajo del LLM y se evalúa aparte.
"""

from __future__ import annotations

import argparse
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)

import backends                                          # noqa: E402

EXT_AUDIO = (".wav", ".flac", ".mp3", ".m4a", ".ogg", ".opus", ".webm", ".aac")

CABECERA = """\
# BORRADOR — corregí a mano y renombrá a {stem}.txt
#
# Verbatim: escribí lo que se DIJO, no lo que debería quedar en la ficha.
# Las muletillas, repeticiones y autocorrecciones van tal cual.
# Números y unidades: como los dictó (el normalizador ya iguala "3 mm" y
# "tres milímetros", no pierdas tiempo unificándolos).
# Las líneas que empiezan con # se ignoran.
"""


def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--audio-dir", default=os.path.join(AQUI, "audio"))
    p.add_argument("--refs-dir", default=os.path.join(AQUI, "refs"))
    p.add_argument("--modelo", default="large-v3")
    p.add_argument("--device", default="cuda")
    p.add_argument("--compute-type", default="float16")
    p.add_argument("--sobrescribir", action="store_true",
                   help="rehace borradores que ya existen")
    a = p.parse_args()

    os.makedirs(a.refs_dir, exist_ok=True)
    audios = sorted(f for f in os.listdir(a.audio_dir)
                    if f.lower().endswith(EXT_AUDIO))
    if not audios:
        raise SystemExit(f"{a.audio_dir} está vacío — ver README §1")

    from faster_whisper import WhisperModel
    print(f"cargando {a.modelo} en {a.device}/{a.compute_type}…", flush=True)
    model = WhisperModel(a.modelo, device=a.device, compute_type=a.compute_type)

    hechos = saltados = 0
    for f in audios:
        stem = os.path.splitext(f)[0]
        final = os.path.join(a.refs_dir, stem + ".txt")
        borrador = os.path.join(a.refs_dir, stem + ".draft.txt")

        if os.path.exists(final):
            print(f"  = {stem}: ya hay referencia corregida")
            saltados += 1
            continue
        if os.path.exists(borrador) and not a.sobrescribir:
            print(f"  = {stem}: ya hay borrador (--sobrescribir para rehacer)")
            saltados += 1
            continue

        audio = backends.cargar_audio(os.path.join(a.audio_dir, f))
        segmentos, _ = model.transcribe(
            audio, language="es", beam_size=5,
            temperature=[0.0, 0.2, 0.4],
            vad_filter=False,
            condition_on_previous_text=False,
            without_timestamps=False,
            hotwords=None,          # deliberado — ver el docstring
        )
        lineas = [CABECERA.format(stem=stem)]
        for s in segmentos:
            m, seg = divmod(int(s.start), 60)
            lineas.append(f"# [{m:02d}:{seg:02d}]")
            lineas.append(s.text.strip())
        with open(borrador, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lineas) + "\n")
        dur = len(audio) / backends.SR
        print(f"  + {stem} ({dur:.0f} s) → {os.path.basename(borrador)}")
        hechos += 1

    print(f"\n{hechos} borradores nuevos, {saltados} saltados.")
    if hechos:
        print("\nAhora, y esto no se puede saltear:")
        print("  1. Escuchá cada audio y corregí su .draft.txt verbatim")
        print("  2. mv refs/X.draft.txt refs/X.txt")
        print("  3. ./run.sh --grupo rapido")


if __name__ == "__main__":
    main()
