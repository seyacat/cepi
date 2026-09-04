"""
La matriz del bake-off.

No es un producto cartesiano: cada config existe para contestar UNA pregunta.
Si agregás una, escribí en `descripcion` qué decisión desbloquea — si no
desbloquea ninguna, no la agregues, cada config son N transcripciones más.

Grupos:
  gpu       lo que corre en tu 4060 Ti hoy (ruta D1 del plan)
  ablacion  A/B de un solo parámetro contra el baseline de GPU
  cpu       lo que correría en el mini-PC de la clínica (D2) o en el VPS
  rivales   los modelos que le ganan a Whisper en español según el leaderboard
"""

from __future__ import annotations

import os

from backends import Config

MODELOS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# El baseline contra el que se compara todo. Es la config que recomienda
# ASR_PLAN_LOCAL.md §5.3 para la ruta D1.
BASELINE = "turbo"

CONFIGS: list[Config] = [

    # ── GPU: la ruta recomendada para el MVP ─────────────────────────────────
    Config(
        id="turbo", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="int8_float16", beam=1, vad=True,
        descripcion="BASELINE. Ruta D1 del plan §5.3 con dos cambios "
                    "deliberados: sin initial_prompt y CON timestamps. Los dos "
                    "parámetros del plan se miden aparte (turbo+prompt, "
                    "turbo-nots) porque en la prueba de humo perdían audio.",
    ),
    Config(
        id="large-v3", backend="fw", modelo="large-v3",
        device="cuda", compute_type="float16", beam=1, vad=True,
        descripcion="Techo de calidad de Whisper. ¿Justifica 4x la latencia y "
                    "4.5 GB de VRAM sobre turbo?",
    ),

    # ── Ablación: un parámetro por vez contra el baseline ────────────────────
    Config(
        id="turbo+hot", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="int8_float16", beam=1, vad=True,
        hotwords=True,
        descripcion="LA PREGUNTA CARA. ¿El glosario baja el WER sin subir "
                    "term_halluc? Mirá las DOS columnas, no solo el WER.",
    ),
    Config(
        id="turbo-beam5", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="int8_float16", beam=5, vad=True,
        descripcion="¿El greedy que propone el plan degrada de verdad? "
                    "beam=5 es el default de faster-whisper.",
    ),
    Config(
        id="turbo-novad", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="int8_float16", beam=1, vad=False,
        descripcion="Sin VAD. Si esta config alucina en los silencios y el "
                    "baseline no, el VAD ya se pagó solo.",
    ),
    Config(
        id="turbo-fp16", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="float16", beam=1, vad=True,
        descripcion="¿int8_float16 cuesta calidad? Fue 1.11 s vs 1.34 s en el "
                    "benchmark; falta saber si transcribe igual.",
    ),
    Config(
        id="turbo-nots", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="int8_float16", beam=1, vad=True,
        timestamps=False,
        descripcion="without_timestamps=True, como pide el plan §5.3. En la "
                    "prueba de humo perdió el 80% del audio: sin timestamp al "
                    "que saltar, un fin-de-texto temprano se lleva la ventana "
                    "de 30 s entera. Si acá la columna Palabras te da bajo, "
                    "el parámetro se descarta y punto.",
    ),
    Config(
        id="turbo+prompt", backend="fw", modelo="large-v3-turbo",
        device="cuda", compute_type="int8_float16", beam=1, vad=True,
        prompt=True,
        descripcion="initial_prompt para fijar estilo, como propone el plan "
                    "§5.2. CUIDADO: en la prueba de humo colapsó la salida a "
                    "las 4 palabras del propio prompt. Si acá te da un WER "
                    "absurdo o transcripciones cortísimas, es eso — y la "
                    "recomendación del plan hay que retirarla.",
    ),

    # ── CPU: lo que de verdad se despliega en la clínica ─────────────────────
    Config(
        id="turbo-cpu4", backend="fw", modelo="large-v3-turbo",
        device="cpu", compute_type="int8", cpu_threads=4, beam=1, vad=True,
        descripcion="Ruta D2 (mini-PC sin GPU). cpu_threads=4 es el óptimo "
                    "medido: con 8 es PEOR.",
    ),
    Config(
        id="small-cpu4", backend="fw", modelo="small",
        device="cpu", compute_type="int8", cpu_threads=4, beam=1, vad=True,
        descripcion="Escalón de degradación del VPS. El plan sostiene que es "
                    "inservible clínicamente — este es el número que lo prueba "
                    "o lo desmiente con TU audio.",
    ),

    # ── Rivales: los que le ganan a Whisper en español ───────────────────────
    Config(
        id="parakeet", backend="sherpa",
        modelo=os.path.join(MODELOS, "parakeet-tdt-0.6b-v3"),
        tipo_sherpa="transducer", num_threads=4,
        descripcion="WER es 3.71 y NO alucina en silencios (transducer, sin "
                    "decoder autoregresivo). 487 MB. CC-BY-4.0: exige "
                    "atribución visible a NVIDIA.",
    ),
    Config(
        id="parakeet+hot", backend="sherpa",
        modelo=os.path.join(MODELOS, "parakeet-tdt-0.6b-v3"),
        tipo_sherpa="transducer", num_threads=4, hotwords=True,
        extra={"hotwords_score": 1.5, "max_active_paths": 4},
        descripcion="Hotwords en Parakeet. VERIFICADO QUE NO FUNCIONA con el "
                    "release actual: el asset sherpa-onnx-nemo-parakeet-tdt-"
                    "0.6b-v3-int8 no trae bpe.model, y sin él sherpa descarta "
                    "el glosario entero ('Encode hotwords failed, skipping') "
                    "y transcribe sin él. Se deja para volver a probar cuando "
                    "el release incluya bpe.model.",
    ),
    Config(
        id="cohere", backend="sherpa",
        # el asset de sherpa se llama sherpa-onnx-cohere-transcribe-14-lang-
        # int8-2026-04-01: el nombre corto tiene que ser subcadena de ESE, no
        # del nombre del modelo en HuggingFace (cohere-transcribe-03-2026)
        modelo=os.path.join(MODELOS, "cohere-transcribe"),
        tipo_sherpa="cohere", num_threads=4,
        descripcion="WER es 2.81, el mejor abierto. Apache-2.0. Ojo: rinde "
                    "inconsistente con code-switching es/en, que en derma es "
                    "constante (peeling, láser, shaving, punch). El build de "
                    "sherpa es el 14-lang de 2026-04-01, que puede no ser "
                    "idéntico al 03-2026 del leaderboard.",
    ),
    Config(
        id="canary-180m", backend="sherpa",
        modelo=os.path.join(MODELOS, "canary-180m-flash"),
        tipo_sherpa="canary", num_threads=2,
        descripcion="154 MB: el único candidato que entra en el VPS de 1 GB. "
                    "WER es 3.17. Si aguanta, el VPS deja de ser un callejón. "
                    "OJO: ante audio que no es del src_lang devuelve CADENA "
                    "VACÍA, no una mala transcripción (verificado). En derma, "
                    "con code-switching constante, mirá la columna Vacías.",
    ),
]

GRUPOS: dict[str, list[str]] = {
    "gpu":      ["turbo", "large-v3"],
    "ablacion": ["turbo", "turbo+hot", "turbo-beam5", "turbo-novad",
                 "turbo-fp16", "turbo+prompt", "turbo-nots"],
    # las dos configs que replican al pie de la letra ASR_PLAN_LOCAL.md §5.3;
    # si `turbo` les gana por goleada, el plan hay que corregirlo
    "plan": ["turbo", "turbo+prompt", "turbo-nots"],
    "cpu":      ["turbo-cpu4", "small-cpu4"],
    # parakeet+hot queda fuera a propósito: con el release actual las hotwords
    # se descartan, así que sus resultados serían un duplicado de `parakeet`
    "rivales":  ["turbo", "parakeet", "cohere", "canary-180m"],
    "rapido":   ["turbo", "turbo+hot", "large-v3"],
    "todo":     [c.id for c in CONFIGS],
}

POR_ID = {c.id: c for c in CONFIGS}


def resolver(nombres: list[str]) -> list[Config]:
    """Acepta ids de config y nombres de grupo, mezclados. Preserva el orden."""
    out: list[Config] = []
    for n in nombres:
        for cid in GRUPOS.get(n, [n]):
            if cid not in POR_ID:
                raise SystemExit(
                    f"config desconocida: {cid!r}\n"
                    f"  configs: {', '.join(POR_ID)}\n"
                    f"  grupos : {', '.join(GRUPOS)}")
            if cid not in [c.id for c in out]:
                out.append(POR_ID[cid])
    return out
