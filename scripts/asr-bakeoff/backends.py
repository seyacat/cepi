"""
Backends de ASR para el bake-off: faster-whisper y sherpa-onnx.

Contrato: todos reciben un `np.float32` mono a 16 kHz ya decodificado y
devuelven texto. El audio se decodifica UNA vez por archivo y se reparte entre
backends, para que la latencia medida sea inferencia pura y comparable — si cada
backend decodificara su propio audio estarías comparando ffmpeg, no modelos.

Firmas verificadas contra sherpa-onnx 1.13.4 instalado (2026-07-28):

  from_transducer(encoder, decoder, joiner, tokens, num_threads, sample_rate,
                  feature_dim, decoding_method, max_active_paths, hotwords_file,
                  hotwords_score, modeling_unit, bpe_vocab, provider, ...)
  from_nemo_canary(encoder, decoder, tokens, src_lang, tgt_lang, num_threads,
                   sample_rate, feature_dim=128, decoding_method, provider, ...)
  from_cohere_transcribe(encoder, decoder, tokens, num_threads, language,
                         use_punct, use_itn, decoding_method, provider, ...)
  OfflineRecognizer.create_stream(hotwords: str | None)

Nota importante: **solo el transducer acepta hotwords.** Canary y Cohere no
tienen el parámetro. Si tu decisión depende del glosario, el A/B de hotwords
solo aplica a faster-whisper y a Parakeet.
"""

from __future__ import annotations

import glob
import os
import subprocess
import sys
from dataclasses import dataclass, field

import numpy as np

from glosario import GLOSARIO, GLOSARIO_SHERPA, PROMPT_ESTILO

SR = 16_000


# ═══════════════════════════════════════════════════════════════════════════
# Audio
# ═══════════════════════════════════════════════════════════════════════════

def cargar_audio(path: str) -> np.ndarray:
    """Decodifica cualquier formato a float32 mono 16 kHz vía ffmpeg."""
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-",
    ]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg falló con {path}:\n{p.stderr.decode(errors='replace')}")
    return np.frombuffer(p.stdout, dtype=np.float32).copy()


# ═══════════════════════════════════════════════════════════════════════════
# Config
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Config:
    """Una fila del bake-off. `id` es lo que aparece en el reporte."""
    id: str
    backend: str                      # "fw" | "sherpa"
    modelo: str                       # alias fw, o directorio del modelo sherpa
    descripcion: str = ""
    # faster-whisper
    device: str = "cuda"
    compute_type: str = "int8_float16"
    cpu_threads: int = 0
    beam: int = 1
    vad: bool = True
    prompt: bool = False              # initial_prompt — ojo, ver abajo
    timestamps: bool = True           # = not without_timestamps — ojo, ver abajo
    # sherpa
    tipo_sherpa: str = "transducer"   # transducer | canary | cohere | whisper
    num_threads: int = 4
    provider: str = "cpu"
    # común
    hotwords: bool = False
    extra: dict = field(default_factory=dict)

    @property
    def clave_modelo(self) -> tuple:
        """Configs con la misma clave comparten instancia cargada en memoria."""
        if self.backend == "fw":
            return ("fw", self.modelo, self.device, self.compute_type, self.cpu_threads)
        # en sherpa las hotwords entran por create_stream, salvo max_active_paths
        return ("sherpa", self.modelo, self.tipo_sherpa, self.num_threads,
                self.provider, self.hotwords)


# ═══════════════════════════════════════════════════════════════════════════
# faster-whisper
# ═══════════════════════════════════════════════════════════════════════════

class FasterWhisper:
    def __init__(self, cfg: Config):
        from faster_whisper import WhisperModel
        self.model = WhisperModel(
            cfg.modelo,
            device=cfg.device,
            compute_type=cfg.compute_type,
            cpu_threads=cfg.cpu_threads,
            num_workers=1,
        )

    def transcribir(self, audio: np.ndarray, cfg: Config) -> str:
        segmentos, _ = self.model.transcribe(
            audio,
            language="es",
            beam_size=cfg.beam,
            best_of=1,
            temperature=[0.0, 0.2, 0.4],
            vad_filter=cfg.vad,
            vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
            condition_on_previous_text=False,
            # without_timestamps=False por defecto, y esto contradice a
            # ASR_PLAN_LOCAL.md §5.3 a propósito.
            #
            # Con without_timestamps=True, si el modelo emite fin-de-texto
            # temprano no queda ningún timestamp al que saltar: faster-whisper
            # avanza la ventana ENTERA de 30 s y ese audio se pierde. En
            # silencio. Medido acá sobre el mismo clip de 40 s (palabras
            # transcritas sobre las dichas):
            #
            #                          turbo   large-v3
            #   sin_ts=True  vad=True   19%      17%   ← lo que pide el plan
            #   sin_ts=True  vad=False  24%     106%
            #   sin_ts=False vad=True   19%     103%
            #   sin_ts=False vad=False 103%     107%
            #
            # El ahorro de without_timestamps=True son unos tokens de
            # generación. El riesgo es perder cuatro quintos de un dictado sin
            # que nada falle ni avise. La asimetría no admite discusión.
            #
            # AVISO: ese audio es inglés forzado a language="es", una condición
            # adversarial que dispara el fin-de-texto temprano. En dictado
            # español limpio la tasa de fallo puede ser mucho menor — por eso
            # existe la config `turbo-nots`, para que lo decidan TUS audios.
            without_timestamps=not cfg.timestamps,
            word_timestamps=False,
            # initial_prompt está APAGADO por defecto y no es un descuido.
            # Medido en esta máquina (large-v3-turbo, int8_float16, VAD on):
            #   sin prompt ................. 50 palabras, transcripción normal
            #   con PROMPT_ESTILO ............ 4 palabras: "Dictado clínico en
            #                                  español." — el modelo COMPLETA el
            #                                  prompt y emite fin-de-texto
            #   con prompt + hotwords ....... 20 palabras, y en inglés
            # Un initial_prompt corto y declarativo es una frase que el modelo
            # puede "terminar", y a veces termina ahí toda la transcripción.
            # Se deja como config (`turbo+prompt`) para que lo decida tu audio.
            initial_prompt=PROMPT_ESTILO if cfg.prompt else None,
            hotwords=GLOSARIO if cfg.hotwords else None,
        )
        # el generador es perezoso: si no se consume acá, la latencia medida es 0
        return "".join(s.text for s in segmentos).strip()

    def liberar(self):
        del self.model


# ═══════════════════════════════════════════════════════════════════════════
# sherpa-onnx
# ═══════════════════════════════════════════════════════════════════════════

def _buscar(directorio: str, *patrones: str) -> str:
    """
    Los nombres de archivo cambian entre releases de sherpa-onnx
    (encoder.onnx, encoder.int8.onnx, encoder-epoch-99-avg-1.int8.onnx...),
    así que se resuelven por glob en vez de hardcodearlos.
    """
    for pat in patrones:
        hits = sorted(glob.glob(os.path.join(directorio, pat)))
        if hits:
            # preferí int8 si existe: es lo que vas a desplegar
            int8 = [h for h in hits if "int8" in os.path.basename(h)]
            return (int8 or hits)[0]
    raise FileNotFoundError(
        f"no encontré {patrones} en {directorio}\n"
        f"    contenido: {sorted(os.listdir(directorio)) if os.path.isdir(directorio) else 'NO EXISTE'}"
    )


def _resolver_dir(esperado: str) -> str:
    """
    configs.py nombra los modelos corto ("parakeet-tdt-0.6b-v3"); los releases
    de sherpa-onnx los extraen largo ("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3
    -int8"). En vez de obligarte a hacer un symlink después de cada descarga,
    se busca por subcadena. Si hay varios, gana el int8 — que es lo que vas a
    desplegar.
    """
    if os.path.isdir(esperado):
        return esperado
    raiz, nombre = os.path.split(esperado)
    candidatos = [d for d in sorted(glob.glob(os.path.join(raiz, "*")))
                  if os.path.isdir(d) and nombre in os.path.basename(d)]
    if not candidatos:
        raise FileNotFoundError(
            f"no encontré ningún modelo que contenga '{nombre}' en {raiz}/\n"
            f"    bajalo con:  ./fetch-model.sh {nombre}")
    int8 = [c for c in candidatos if "int8" in os.path.basename(c)]
    return (int8 or candidatos)[0]


class Sherpa:
    def __init__(self, cfg: Config):
        import sherpa_onnx

        d = _resolver_dir(cfg.modelo)
        if d != cfg.modelo:
            print(f"  ({os.path.basename(d)})")

        if cfg.provider == "cuda":
            print("  ! provider=cuda: la rueda de PyPI es CPU-only. Si no la "
                  "instalaste desde el índice de k2-fsa, sherpa cae a CPU en "
                  "silencio y la latencia que midas será de CPU.", file=sys.stderr)

        tokens = _buscar(d, "tokens.txt")
        comun = dict(num_threads=cfg.num_threads, provider=cfg.provider, debug=False)

        if cfg.tipo_sherpa == "transducer":
            bpe = glob.glob(os.path.join(d, "bpe.model"))
            if cfg.hotwords and not bpe:
                # Verificado sobre sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8,
                # que NO trae bpe.model: sin él sherpa usa modeling_unit=
                # "cjkchar" y busca cada término como token entero en
                # tokens.txt — que es BPE de subpalabras. No encuentra ninguno,
                # escupe un "Cannot find ID for token" por término y termina en
                # "Encode hotwords failed, skipping". NO aborta: transcribe
                # igual, sin glosario. Si no leés stderr, creerías que las
                # hotwords no sirven cuando en realidad nunca se aplicaron.
                print("  ! Este modelo no trae bpe.model, así que las hotwords "
                      "NO se van a aplicar (sherpa las descarta y sigue). Vas "
                      "a ver un muro de 'Cannot find ID for token' y después "
                      "'Encode hotwords failed, skipping'. Los resultados de "
                      "esta config son idénticos a los de la config sin "
                      "hotwords: no midas nada con ellos.", file=sys.stderr)
            self.rec = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=_buscar(d, "*encoder*.onnx"),
                decoder=_buscar(d, "*decoder*.onnx"),
                joiner=_buscar(d, "*joiner*.onnx"),
                tokens=tokens,
                # las hotwords SOLO funcionan con modified_beam_search; con el
                # greedy_search por defecto se ignoran sin avisar
                decoding_method="modified_beam_search" if cfg.hotwords else "greedy_search",
                max_active_paths=cfg.extra.get("max_active_paths", 4),
                hotwords_score=cfg.extra.get("hotwords_score", 1.5),
                modeling_unit="bpe" if bpe else "cjkchar",
                bpe_vocab=bpe[0] if bpe else "",
                # model_type="" = autodetectar por la metadata del ONNX.
                # NO se puede omitir: el default del wrapper de Python es
                # 'transducer', que sherpa no reconoce como tipo válido, cae al
                # cargador genérico y muere con "'vocab_size' does not exist in
                # the metadata" sobre parakeet-tdt-0.6b-v3 — que exporta esa
                # metadata en el encoder, no en el decoder. Y no lanza
                # excepción: llama a exit() desde C++ y se lleva el proceso.
                model_type="",
                **comun,
            )
        # Canary tiene un comportamiento que conviene conocer antes de elegirlo:
        # ante audio que no coincide con src_lang devuelve **cadena vacía**, no
        # una transcripción mala. Verificado sobre 4 clips en inglés, incluido
        # el test_wavs/en.wav que trae el propio modelo: con src_lang="es" los
        # cuatro dieron "", con src_lang="en" los cuatro transcribieron bien.
        # Whisper en cambio traduce en silencio, que es peor de detectar pero
        # también menos catastrófico. Para dictado con code-switching (peeling,
        # láser, shaving, punch) esto es un riesgo concreto: mirá la columna
        # "Vacías" del reporte.
        elif cfg.tipo_sherpa == "canary":
            self.rec = sherpa_onnx.OfflineRecognizer.from_nemo_canary(
                encoder=_buscar(d, "*encoder*.onnx"),
                decoder=_buscar(d, "*decoder*.onnx"),
                tokens=tokens,
                src_lang="es", tgt_lang="es",
                feature_dim=128,          # Canary usa 128, no los 80 habituales
                **comun,
            )
        elif cfg.tipo_sherpa == "cohere":
            self.rec = sherpa_onnx.OfflineRecognizer.from_cohere_transcribe(
                encoder=_buscar(d, "*encoder*.onnx"),
                decoder=_buscar(d, "*decoder*.onnx"),
                tokens=tokens,
                language="es",            # Cohere NO autodetecta: hay que fijarlo
                use_punct=True, use_itn=True,
                **comun,
            )
        elif cfg.tipo_sherpa == "whisper":
            self.rec = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=_buscar(d, "*encoder*.onnx"),
                decoder=_buscar(d, "*decoder*.onnx"),
                tokens=tokens,
                language="es", task="transcribe",
                **comun,
            )
        else:
            raise ValueError(f"tipo_sherpa desconocido: {cfg.tipo_sherpa}")

        self.usa_hotwords = cfg.hotwords and cfg.tipo_sherpa == "transducer"

    def transcribir(self, audio: np.ndarray, cfg: Config) -> str:
        s = (self.rec.create_stream(hotwords=GLOSARIO_SHERPA)
             if self.usa_hotwords else self.rec.create_stream())
        s.accept_waveform(SR, audio)
        self.rec.decode_stream(s)
        return s.result.text.strip()

    def liberar(self):
        del self.rec


# ═══════════════════════════════════════════════════════════════════════════

def crear(cfg: Config):
    if cfg.backend == "fw":
        return FasterWhisper(cfg)
    if cfg.backend == "sherpa":
        return Sherpa(cfg)
    raise ValueError(f"backend desconocido: {cfg.backend}")
