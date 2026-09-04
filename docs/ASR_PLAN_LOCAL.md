# Plan (i) con modelo local — dictado del médico

**Proyecto:** CEPI Telemedicina · **Fecha:** 2026-07-28 · **Estado:** decisión de arquitectura
**Alcance:** escenario (i) de `docs/ASR_TRANSCRIPCION.md` §2.1 — un hablante, 60-180 s, español de Ecuador, vocabulario dermatológico, resultado → LLM → formulario prellenado que el médico revisa.
**Requisito duro:** el modelo corre en infraestructura que tú controlas. Nada de APIs cloud de terceros (LOPDP Ecuador).

---

## 1. Qué es Groq y por qué no sirve aquí

**Groq** (con "q") es una empresa de hardware de inferencia: fabrica sus propias LPU y vende una API cloud que ejecuta modelos abiertos a velocidades extremas. **No tiene nada que ver con Grok** (con "k"), el LLM de xAI — son dos compañías distintas y la confusión es frecuente.

El punto que decide todo: el modelo que Groq ejecuta para audio es **`whisper-large-v3-turbo`, que es abierto y con licencia MIT**. Si lo corres tú, obtienes **exactamente la misma calidad de transcripción, el mismo WER, las mismas alucinaciones**. Lo único que compras en Groq es velocidad de hardware (216x tiempo real, USD 0.04 por hora de audio) y cero operación.

**Conclusión:** la decisión local-vs-cloud **no cambia el modelo, solo cambia dónde corre y quién ve el audio**. No estás renunciando a calidad al rechazar la nube; estás cambiando USD 0.20/mes por USD 6-23/mes y por trabajo de operación. Todo el resto de este documento es sobre dónde poner el fierro.

---

## 2. El dilema en una tabla

Cuatro formas de "local" para un dictado de **90 segundos**. Costos mensuales asumiendo ~200 dictados/mes (5 h de audio).

| # | Ruta | Costo/mes | Latencia (90 s de audio) | Calidad en español | ¿Quién administra el fierro? | ¿Soberanía real? |
|---|---|---|---|---|---|---|
| **A** | **En el dispositivo** — navegador con `transformers.js` v4 + Whisper ONNX (WebGPU/WASM) | **USD 0** + 206 MB a 1.6 GB de descarga por dispositivo | Desktop con WebGPU y turbo: segundos *(no verificado)*. Desktop WASM + small: **~135 s**. Android/Capacitor: **no viable** | turbo: buena. small: borrador. base/tiny: destroza "queratosis actínica" | Nadie / el propio médico | **Sí, la más fuerte** — el audio nunca sale del dispositivo |
| **B** | **En el VPS actual** (1 core físico @2 GHz, 1140 MB libres, sin GPU) | **USD 0** | small int8 ≈ **16 s** *(estimado, factor 2.30x medido)*. turbo: **no entra en RAM** | small en derma: mala. Techo real = `canary-180m-flash` | Tú | Sí |
| **C1** | **VPS nuevo solo CPU, 8 GB** (Contabo Cloud VPS 4 / OVH VPS-2) | **USD 6.25 – 8.50** | turbo int8 **35-45 s**; small int8 **11-13 s** *(estimados)* | turbo: la mejor que da Whisper | Tú | Sí |
| **C2** | **VPS con GPU dedicada 24/7** | **USD 172 – 654** (piso realista de proveedor serio) | **1.5-3 s** | Máxima | Tú | Sí, pero absurdo: GPU al 0.06% de uso |
| **C3** | **GPU serverless** (RunPod / Modal / Beam / Baseten) | **USD 0.16 – 2.50** (los créditos gratis lo cubren) | 4-6 s tibio; 60-120 s en frío mal configurado | Máxima | El proveedor | **NO. Solo lo aparenta** — ver abajo |
| **D1** | **Tu máquina de desarrollo** (RTX 4060 Ti 16 GB) por túnel Tailscale | **USD 0 – 8.41** (solo electricidad) | **1.11 s de inferencia medidos**; 2-4 s extremo a extremo | Máxima: cabe `large-v3` completo | Tú | **Sí** |
| **D2** | **Mini-PC en la clínica** (8 núcleos, 16 GB, sin GPU) | **USD 19 – 23** (hw amortizado a 3 años + luz) | turbo int8 **11-15 s** *(extrapolado)* | Máxima (mismo modelo) | La clínica | **Sí, la más defendible ante auditoría** |
| — | *(referencia)* API cloud Groq | USD 0.20 | ~0.5 s | Idéntica (mismo modelo) | Nadie | **No** |

### La trampa de C3: la GPU serverless **aparenta** soberanía y no la tiene

Es el punto más importante de la tabla y hay que decirlo sin rodeos. En serverless tú empaquetas el contenedor, tú eliges los pesos abiertos, tú controlas la retención — y **el audio clínico igual sale de tu infraestructura, cruza internet y se descifra dentro del datacenter de un tercero, casi siempre en Estados Unidos**. Bajo LOPDP ese proveedor es un **encargado del tratamiento**: necesitas contrato de encargo y aplica el régimen completo de transferencia internacional. "El modelo es abierto" no es una defensa jurídica.

Lo que sí compras frente a Groq/Deepgram/AssemblyAI, y es real: controlas la retención (nada se persiste si no escribes a disco) y nadie entrena con tu audio. Pero son dos requisitos distintos:

- Si tu requisito es *"no le regalo mi audio a una API de ASR de terceros"* → serverless pasa.
- Si tu requisito es *"el dato clínico no sale de infraestructura que yo controlo"* → **serverless no pasa.**

Tú declaraste el segundo. Por eso C3 queda fuera, aunque sea la opción más barata de toda la tabla.

Y descartado sin discusión: **Vast.ai** (USD 59-95/mes, lo más barato del mercado) es un marketplace peer-to-peer — la máquina de un particular anónimo, en un país que no eliges, sin DPA. Indefendible para audio clínico.

---

## 3. Por qué el VPS actual no alcanza

Números medidos hoy en producción:

```
CPU:    AMD EPYC-Milan · 1 core físico × 2 threads @ 2 GHz · sin GPU · sin AVX-512
RAM:    1855 MB total · 1140 MB disponibles · 4 GB swap
Disco:  79 GB libres · Ubuntu 24.04 · Python 3.12.3
Otros:  ffmpeg NO instalado · PEP 668 activo
Corriendo ya: nginx + PostgreSQL + 4 servicios Node bajo PM2
```

### 3.1 La aritmética de RAM decide antes que la de CPU

Pico de RSS medido con `/usr/bin/time -v`, faster-whisper int8, audio de 90 s:

| Modelo | Pico de RAM | ¿Entra en 1140 MB? |
|---|---|---|
| `tiny` int8 | 411 MB | Sí, holgado |
| `base` int8 | 597 MB | Sí |
| `small` int8 | **787 MB** | Sí, con ~353 MB de margen — **justo** |
| `large-v3-turbo` int8 | **2043 MB** | **No.** Se iría al swap y el tiempo se multiplica por 10-50 |
| `large-v3` int8 | ~2950 MB | No |

Con whisper.cpp (C++ puro, mucho más frugal) el techo sube un poco: `base` usa ~388 MB de RAM y `small` ~852 MB. Pero `medium` ya son ~2.1 GB y `large` ~3.9 GB.

**El modelo techo del VPS actual es `whisper-small` int8, y va apretado.** Si quieres calidad decente en ese footprint, la única opción real es **`nvidia/canary-180m-flash`** en sherpa-onnx int8: 153.7 MB en disco, ~400 MB de RAM en runtime, WER en español de 3.17 (MLS) / 4.90 (Common Voice) — mejor que whisper-small por un margen enorme.

### 3.2 Cuánto tardaría un dictado de 90 s ahí

Para traducir mediciones de la máquina de desarrollo al VPS corrí un microbenchmark propio (GEMM float 512×512, un hilo, mismo binario `-march=x86-64-v3`):

- P-core del i7-14700F: **58.75 y 60.67 GFLOPS**
- vCPU del EPYC-Milan del VPS: **26.77 y 25.11 GFLOPS**
- **Factor de castigo: 2.30x por núcleo**, y encima con 2 threads contra 20 cores.

Aplicándolo a lo medido (small int8, 2 hilos, beam=1, VAD, 90 s → 7.01 s en P-cores):

| Modelo en el VPS actual | Tiempo para 90 s de dictado |
|---|---|
| `whisper-small` int8 | **≈ 16 s** (5.6x tiempo real) — entra, pero satura el único core |
| `whisper-large-v3-turbo` int8 | ≈ 58 s de cómputo… **pero no entra en RAM**, así que en la práctica son minutos con swap |
| `canary-180m-flash` int8 (sherpa-onnx) | **12-25 s** *(estimado, no medido)* |

### 3.3 El problema no son los 16 segundos, es lo que pasa mientras

Ese dictado ocupa **el 100% del único core físico durante 16 segundos**. En ese lapso nginx, PostgreSQL y los cuatro servicios Node de PM2 compiten por el mismo core. Dos médicos dictando a la vez ponen la app entera de rodillas. Sumado a que `small` en español médico te va a destrozar exactamente el vocabulario que importa — queratosis actínica, dermatoscopia, Breslow, imiquimod, hidradenitis supurativa — el veredicto es:

> **No pongas ASR en el VPS actual. Ni ahora, ni con optimizaciones. La respuesta correcta no es "proceso aparte", es "otra máquina".**

*(Detalle operativo: `apt install ffmpeg` no hace falta si usas faster-whisper — decodifica con PyAV, que trae FFmpeg dentro del wheel. Sí lo necesitarías con whisper.cpp `--convert`.)*

---

## 4. Recomendación

### MVP → **Ruta D1: tu máquina de desarrollo (RTX 4060 Ti) por túnel Tailscale**

Medido hoy en esa GPU con faster-whisper 1.2.1 + CTranslate2 4.8.1, audio de 90 s:

| Configuración | Tiempo | Factor |
|---|---|---|
| `large-v3-turbo` **int8_float16** | **1.11 s** | **81x tiempo real** ← el óptimo |
| `large-v3-turbo` float16 | 1.34 s | 67x |
| `small` float16 | 1.06 s | 85x |
| `large-v3` float16 | 4.20 s | 21x |

Extremo a extremo, incluyendo decode de audio, VAD, HTTP y el salto por el túnel: **2-4 segundos desde que el médico suelta el botón**. Cabe cómodamente dentro del `proxy_read_timeout` de 60 s de nginx, así que **no necesitas worker asíncrono, ni estado `pending`, ni polling del front** — que es exactamente el ahorro de 4-6 días de ingeniería que `docs/ASR_TRANSCRIPCION.md` §1 identificó.

Por qué esta y no otra:
- Ya aceptaste que el MVP corra en tu máquina. Encaja literal con el requisito.
- Costo marginal de la inferencia real: **1.3 centavos al mes** con 2000 dictados. Si la máquina ya está prendida para desarrollar, el costo es cero.
- 16 GB de VRAM te dejan correr `large-v3` completo si turbo no alcanza. Ninguna ruta bajo USD 400/mes te da esa opción.
- Cero hardware nuevo, cero compromiso. Si el piloto falla no perdiste nada.

### Producción → **Ruta D2: mini-PC x86 en la clínica, sin GPU**

USD 500-600 de hardware + USD 100 de UPS, amortizado a 3 años = **USD 19-23/mes con la luz incluida** (tarifa Ecuador 2026: USD 0.1283/kWh). Con 8 núcleos modernos, `large-v3-turbo` int8 hace 90 s de dictado en **11-15 s**, de sobra para un flujo donde el médico revisa un formulario después.

Es la única ruta, junto con D1, donde el audio **literalmente nunca sale del edificio**. Defendible ante cualquier auditoría LOPDP sin argumentos retorcidos. Y **no necesitas GPU**: para 200-2000 dictados al mes, CPU moderna alcanza. La GPU solo compra latencia sub-2-segundos.

### Además, y esto no lo pediste: **sube el VPS a 8 GB de RAM (USD 6.25/mes)**

No por CPU — ya vimos que faster-whisper no escala más allá de ~4 hilos. Lo haces **por RAM**, para tener un **escalón de degradación soberano** cuando la máquina de casa esté apagada o haya corte de luz. Con 8 GB corres `small` int8 en ~11-13 s, 100% dentro de tu infraestructura. Contabo Cloud VPS 4 (4 vCPU / 8 GB) son €5.50 = USD 6.25/mes.

> **Aviso caro:** si tu VPS actual está en Hetzner con precio viejo, **no lo escales verticalmente**. Cualquier rescale (arriba o abajo) dispara los precios de 2026 al instante — el CCX23 pasó de €31.49 a €85.99 en cinco meses. Crea instancia nueva y migra.

### Lo que descarto explícitamente, y por qué

- **Ruta A (navegador/on-device):** funciona en desktop, **no funciona en el APK de Capacitor**. Tres bloqueos que se multiplican: WebGPU en el WebView de Android es dudoso *(contradicción sin resolver entre MDN, caniuse y caniwebview — hay que verificarlo empíricamente)*; sin cross-origin isolation caes a WASM mono-hilo; y `whisper-base` expande a 400+ MB en inferencia, lo que mata el WebView en un teléfono de gama media. Además ni `transformers.js` ni `parakeet.js` exponen bien `hotwords`/`initial_prompt`, así que **pierdes la única palanca barata para sesgar el vocabulario dermatológico**. Déjala como modo opcional "transcribir en tu equipo" solo en navegador de escritorio, activado por feature-detection.
- **Plugin nativo de Capacitor (whisper.cpp o sherpa-onnx):** no existe ninguno adoptable. Búsqueda en npm hoy: cero paquetes. En GitHub solo repos de 0-1 estrellas. El equivalente maduro vive en React Native (`whisper.rn`, 798★) y Flutter. Escribirlo y mantenerlo son 2-4 semanas de NDK/Core ML más mantenimiento perpetuo. Desproporcionado para prellenar un formulario.
- **ASR nativo del SO** (`@capgo/capacitor-speech-recognition`, la única opción on-device lista hoy para Capacitor 8): en Android **no puedes auditar** que el audio no viaje — dependes de que el motor de Google respete `createOnDeviceSpeechRecognizer()`. Es justo el agujero LOPDP que quieres evitar. Y solo sesgas vocabulario con ~100 frases de `contextualStrings`.

---

## 5. Plan de implementación

### 5.0 Antes de escribir código: mide

**Esto ya está construido: `scripts/asr-bakeoff/`.** Ver su `README.md` para el
protocolo de grabación (qué tienen que contener los dictados para que la
medición signifique algo) y el flujo completo:

```bash
cd scripts/asr-bakeoff
./setup.sh                  # venv --copies + dependencias
# copiar los dictados a audio/
./draft_refs.py             # borradores de referencia con large-v3
# corregir refs/*.draft.txt verbatim y renombrarlos a .txt
./run.sh --grupo rapido
```

Compara `{large-v3-turbo, large-v3, small} × {GPU, CPU} × {beam, VAD,
timestamps, initial_prompt, glosario}` más los tres rivales abiertos que le
ganan a Whisper en español (Parakeet, Cohere Transcribe, Canary) vía
sherpa-onnx. Es reanudable y trae bootstrap pareado, así que además de rankear
te dice **si la diferencia es real o ruido de muestreo**, y cuántas muestras
más harían falta.

Media tarde de trabajo, y es lo único que te dice si `small` te alcanza o
necesitas `turbo`. Graba **20-30 dictados** (mismo micrófono, mismo ruido de
consultorio, mismo acento, misma jerga) — el README recomienda que sean
**simulados**, no de consulta real: para medir ASR da exactamente lo mismo y te
ahorra tener un corpus de datos de salud que no se borra nunca.

**Y la métrica que importa no es el WER global, sino cuántos campos de la ficha quedan correctos.** Un WER de 3.7% con todos los errores cayendo sobre términos dermatológicos es peor que un WER de 5% con errores en muletillas. El bake-off se acerca con `term_recall` y `term_halluc` (aciertos y alucinaciones sobre el glosario), que es lo más parecido que se puede medir sin tener todavía la extracción transcripción→ficha.

### 5.1 Servidor de inferencia — venv en la máquina de desarrollo

`/mnt/sda1` es NTFS/fuseblk: los symlinks fallan, hay que crear el venv con `--copies`.

```bash
cd /mnt/sda1/cepi/cepi-isic
python3 -m venv --copies .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -r requirements-asr.txt
```

Archivo nuevo **`/mnt/sda1/cepi/cepi-isic/requirements-asr.txt`** (separado del base, para que el VPS pueda desplegar cepi-isic sin arrastrar el stack de ASR):

```
faster-whisper==1.2.1
ctranslate2>=4,<5
# Solo para GPU (omitir en CPU): ctranslate2 reciente exige CUDA 12 + cuDNN 9
nvidia-cublas-cu12
nvidia-cudnn-cu12==9.*
```

En Linux, exporta `LD_LIBRARY_PATH` apuntando a esos paquetes **antes** de lanzar Python:

```bash
export LD_LIBRARY_PATH="$(dirname $(find /mnt/sda1/cepi/cepi-isic/.venv -name 'libcudnn_ops*.so*' | head -1)):$LD_LIBRARY_PATH"
```

> **Síntoma del fallback silencioso a CPU:** si en el log ves `The compute type inferred from the saved model is float16, but the target device or backend do not support efficient float16 computation` — estás corriendo en CPU sin saberlo.

### 5.2 El endpoint `/transcribe` en cepi-isic

Archivo nuevo **`/mnt/sda1/cepi/cepi-isic/asr.py`**. Sigue el mismo patrón que `/inspect`: acepta multipart directo **o** `{attachment_id, file_url, auth}` para que cepi-bot le pase la URL autenticada de TodoERP, igual que hace `cepi-bot/src/imageInspect.ts:36-48`.

```python
# cepi-isic/asr.py — POST /transcribe para el dictado del médico (escenario i)
import asyncio, ctypes, gc, os, tempfile, time, urllib.request
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

MODEL_ID    = os.environ.get("ASR_MODEL", "large-v3-turbo")
DEVICE      = os.environ.get("ASR_DEVICE", "cpu")            # "cuda" en la máquina de dev
COMPUTE     = os.environ.get("ASR_COMPUTE_TYPE", "int8")     # "int8_float16" en la 4060 Ti
CPU_THREADS = int(os.environ.get("ASR_CPU_THREADS", "4"))
BEAM        = int(os.environ.get("ASR_BEAM_SIZE", "1"))
IDLE_TTL    = int(os.environ.get("ASR_MODEL_TTL", "600"))    # s sin uso → descarga
MAX_BYTES   = int(os.environ.get("ASR_MAX_BYTES", str(25 * 1024 * 1024)))
MODEL_DIR   = os.environ.get("ASR_MODEL_DIR")                # caché offline

# ── Glosario dermatológico ecuatoriano ──────────────────────────────────────
# OJO: el límite real son 223 tokens (max_length//2 - 1), y en español médico
# el tokenizer parte mucho ("isotretinoína" ≈ 5-6 tokens). Caben ~60-90
# palabras, NO más. Los términos más raros van AL FINAL: la atención pesa más
# lo último. Cuéntalos de verdad con tokenizer.encode() antes de desplegar.
GLOSARIO_DERMA = (
    "dermatoscopia, dermatoscopía, fototipo Fitzpatrick, nevo melanocítico, "
    "nevus displásico, léntigo solar, queratosis actínica, queratosis seborreica, "
    "carcinoma basocelular, carcinoma espinocelular, melanoma de extensión superficial, "
    "índice de Breslow, biopsia incisional, criocirugía, psoriasis en placas, "
    "dermatitis atópica, dermatitis de contacto, rosácea, hidradenitis supurativa, "
    "acné noduloquístico, vitíligo, onicomicosis, pitiriasis versicolor, escabiosis, "
    "larva migrans, leishmaniasis cutánea, esporotricosis, "
    "clobetasol, tacrolimus, mupirocina, imiquimod, isotretinoína, metotrexato, "
    "hidroxicloroquina, dupilumab"
)
# initial_prompt: NO metas aquí el glosario (ver §5.3). Solo fija estilo.
PROMPT_ESTILO = "Dictado clínico en español. Puntuación y mayúsculas normales."

router = APIRouter()
_model = None
_last_used = 0.0
_lock = asyncio.Lock()   # CONCURRENCIA 1: un solo decode a la vez


def _load():
    from faster_whisper import WhisperModel
    return WhisperModel(
        MODEL_ID, device=DEVICE, compute_type=COMPUTE,
        cpu_threads=CPU_THREADS, num_workers=1,
        download_root=MODEL_DIR,
        local_files_only=os.environ.get("ASR_OFFLINE", "0") == "1",
    )


async def _get_model():
    global _model, _last_used
    if _model is None:
        _model = await asyncio.to_thread(_load)   # no bloquea el event loop
    _last_used = time.monotonic()
    return _model


async def reaper():
    """Descarga el modelo tras IDLE_TTL sin uso y devuelve el RSS al SO."""
    global _model
    while True:
        await asyncio.sleep(30)
        if _model is None or time.monotonic() - _last_used <= IDLE_TTL:
            continue
        if _lock.locked():
            continue
        async with _lock:
            _model = None
            gc.collect()
            try:
                ctypes.CDLL("libc.so.6").malloc_trim(0)   # glibc: baja el RSS de verdad
            except OSError:
                pass


def _run(model, path: str, language: str, hotwords: str, prompt: str | None):
    segments, info = model.transcribe(
        path,
        language=language or None,        # fijar "es" ahorra la detección de idioma
        task="transcribe",
        beam_size=BEAM,                   # 1 = greedy
        best_of=1,
        temperature=[0.0, 0.2, 0.4],      # recorta el fallback (el default llega a 1.0)
        vad_filter=True,                  # Silero VAD: recorta silencios
        vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200),
        condition_on_previous_text=False, # corta la propagación de alucinaciones
        without_timestamps=True,
        word_timestamps=False,
        hotwords=hotwords,                # SE REINYECTA EN CADA VENTANA DE 30 s
        initial_prompt=prompt,            # solo sesga la 1ª ventana (§5.3)
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )
    return "".join(s.text for s in segments).strip(), info


async def _transcribe_path(path: str, language: str, hotwords: str | None, prompt: str | None):
    model = await _get_model()
    t0 = time.monotonic()
    async with _lock:                                     # serializa los decodes
        text, info = await asyncio.to_thread(
            _run, model, path, language, hotwords or GLOSARIO_DERMA, prompt or PROMPT_ESTILO
        )
    return {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "duration_after_vad": round(info.duration_after_vad, 2),
        "elapsed": round(time.monotonic() - t0, 2),
        "model": MODEL_ID, "device": DEVICE, "compute_type": COMPUTE,
    }


@router.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("es"),
    hotwords: str | None = Form(None),
    prompt: str | None = Form(None),
):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "audio vacío")
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "audio demasiado grande")
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix) as fh:
        fh.write(raw); fh.flush()
        return await _transcribe_path(fh.name, language, hotwords, prompt)


class TranscribeByAttachment(BaseModel):
    attachment_id: str
    file_url: str
    auth: str | None = None
    api_key: str | None = None
    language: str = "es"
    hotwords: str | None = None
    prompt: str | None = None


@router.post("/transcribe/attachment")
async def transcribe_attachment(req: TranscribeByAttachment):
    """Mismo contrato que /inspect: cepi-bot pasa la URL autenticada de TodoERP."""
    r = urllib.request.Request(req.file_url)
    if req.auth:    r.add_header("Authorization", req.auth)
    if req.api_key: r.add_header("X-API-Key", req.api_key)
    with urllib.request.urlopen(r, timeout=30) as resp:
        raw = resp.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "audio demasiado grande")
    with tempfile.NamedTemporaryFile(suffix=".webm") as fh:
        fh.write(raw); fh.flush()
        out = await _transcribe_path(fh.name, req.language, req.hotwords, req.prompt)
    out["attachment_id"] = req.attachment_id
    return out
```

Y en **`/mnt/sda1/cepi/cepi-isic/app.py`** (hoy la línea 46 hace `app = FastAPI(title="cepi-isic", version="0.1.0")`), opt-in por entorno igual que `CEPI_MEDICAL=1`:

```python
import asyncio
from contextlib import asynccontextmanager

ASR_ENABLED = os.environ.get("CEPI_ASR", "0") == "1"

@asynccontextmanager
async def lifespan(app):
    task = None
    if ASR_ENABLED:
        import asr
        task = asyncio.create_task(asr.reaper())
    yield
    if task:
        task.cancel()

app = FastAPI(title="cepi-isic", version="0.1.0", lifespan=lifespan)
if ASR_ENABLED:
    import asr
    app.include_router(asr.router)
```

Smoke test:

```bash
cd /mnt/sda1/cepi/cepi-isic
CEPI_ASR=1 ASR_DEVICE=cuda ASR_COMPUTE_TYPE=int8_float16 ASR_MODEL=large-v3-turbo \
OMP_NUM_THREADS=8 ASR_CPU_THREADS=8 \
  .venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1

# en otra terminal
curl -sS -F file=@/tmp/dictado90.wav -F language=es http://localhost:8000/transcribe | jq
```

### 5.3 La configuración de faster-whisper, y la trampa más cara de todo el documento

**Los parámetros exactos, y por qué cada uno:**

| Parámetro | GPU (dev box) | CPU (mini-PC / VPS 8 GB) | Por qué |
|---|---|---|---|
| `compute_type` | `int8_float16` | `int8` | Medido: en CPU int8 da **1.54x de velocidad y -35% de RAM** sobre float32. En la 4060 Ti, `int8_float16` (1.11 s) le gana a `float16` (1.34 s) |
| `cpu_threads` | irrelevante | **4** | Medido: small a 2/4/8 hilos = 7.01 / **4.72** / 7.46 s. **Con 8 hilos es PEOR que con 4.** Pagar 8 vCPU es plata quemada |
| `num_workers` | 1 | 1 | Con lock de concurrencia 1 no aporta nada y multiplica la memoria |
| `beam_size` | **1** | **1** | El default de faster-whisper es 5. Greedy da ~1.3-1.6x gratis con degradación despreciable en audio limpio y cercano *(mídelo con tus audios)* |
| `best_of` | 1 | 1 | Irrelevante con temperature 0.0, importa si entra el fallback |
| `temperature` | `[0.0, 0.2, 0.4]` | idem | El default `[0.0…1.0]` reintenta hasta **6 decodes del mismo segmento** = 6x el peor caso |
| `vad_filter` | **True** | **True** | Doble ganancia: recorta 20-40% del audio en un dictado con pausas, **y mata las alucinaciones de silencio**. El default es `False`, hay que activarlo a mano |
| `vad_parameters` | `min_silence_duration_ms=500, speech_pad_ms=200` | idem | El default solo corta silencios de más de 2 s |
| `condition_on_previous_text` | **False** | **False** | El default `True` inyecta el texto de la ventana N como prompt de la N+1: **propaga y amplifica bucles de repetición** |
| `without_timestamps` | ~~True~~ **False** | ~~True~~ **False** | ⚠️ **Corregido — ver abajo.** El ahorro de tokens es real pero el riesgo es perder ventanas enteras de 30 s en silencio |
| `word_timestamps` | False | False | La alineación DTW es una pasada extra cara |
| `language` | `"es"` | `"es"` | Si lo dejas en `None` corre detección sobre los primeros 30 s: un encode gratis de tirar |

#### ⚠️ Dos correcciones medidas el 2026-07-28

Al construir `scripts/asr-bakeoff/` se probaron los parámetros de esta tabla
contra audio real. Dos de las recomendaciones de arriba resultaron peligrosas.
Ambas fallan **en silencio**: nada excepciona, nada avisa, y el resultado es una
transcripción incompleta que parece normal.

**1. `without_timestamps=True` puede perder el 80% del audio.** Si el modelo
emite fin-de-texto temprano dentro de una ventana, sin timestamps no queda a
dónde saltar: faster-whisper avanza la ventana **entera** de 30 s y ese audio
se pierde. Medido sobre un clip de 40 s, palabras transcritas sobre las dichas:

| | `large-v3-turbo` | `large-v3` |
|---|---|---|
| `without_timestamps=True`, `vad=True` ← lo que decía esta tabla | **19%** | **17%** |
| `True`, `vad=False` | 24% | 106% |
| `False`, `vad=True` | 19% | 103% |
| `False`, `vad=False` | 103% | 107% |

El ahorro son unos tokens de generación; la pérdida es la mitad de una nota
clínica. La asimetría no admite discusión: **`False`**.

**2. `initial_prompt=PROMPT_ESTILO` colapsó la transcripción a 4 palabras** — el
modelo completó la frase del prompt y emitió fin-de-texto, devolviendo
literalmente `"Dictado clínico en español."` donde había 50 palabras de audio.
Un `initial_prompt` corto y declarativo es una frase *terminable*, y a veces el
modelo la termina y da por terminada también la transcripción.

**Salvedad honesta:** ese audio es inglés forzado a `language="es"`, una
condición adversarial que dispara el fin-de-texto temprano. En dictado español
limpio la tasa de fallo puede ser mucho menor. Por eso las dos quedaron como
configs del bake-off (`turbo-nots`, `turbo+prompt`) y no como veredicto: lo
deciden los audios reales. Lo que sí cambia ya es el **default**, porque el
modo de falla es silencioso y asimétrico.

De paso, un tercer dato: el glosario de §5.2 son **226 tokens** y el techo son
223. `faster-whisper` trunca sin avisar, y trunca el final — justo donde §5.2
manda poner los términos más raros. `scripts/asr-bakeoff/glosario.py` lo
recorta a 214 y falla ruidosamente si alguien se pasa.

#### ⚠️ `initial_prompt` **NO** te sirve para el glosario. Usa `hotwords`.

Esto es lo que más gente hace mal y hay que entenderlo bien. Leyendo `faster_whisper/transcribe.py`:

- `initial_prompt` se mete en `all_tokens` **una sola vez** al inicio. Pero si pones `condition_on_previous_text=False`, el código ejecuta `prompt_reset_since = len(all_tokens)` al final de **cada** ventana de 30 s.
- **Resultado: con `condition_on_previous_text=False`, tu `initial_prompt` solo sesga los primeros 30 segundos.** En un dictado de 180 s, el glosario aplica al 17% del audio.
- En cambio **`hotwords` se pasa a `get_prompt()` en TODAS las iteraciones del bucle** — se reinyecta en cada ventana.

**Regla operativa: el glosario dermatológico va en `hotwords`. `initial_prompt` reservado para fijar estilo y puntuación de la primera frase.**

Dos restricciones más del código: (a) `hotwords` **no tiene efecto si pasas `prefix`** (la condición es `if hotwords and not prefix`), así que no uses ambos; (b) `hotwords` y el texto previo se concatenan en el mismo prompt y compiten por los 223 tokens — otra razón para `condition_on_previous_text=False`.

**Y el riesgo:** el contextual biasing reduce WER en vocabulario de dominio, pero con prompts largos aumentan los **errores de inserción por alucinación**: el modelo escupe términos del glosario que nadie dijo. Una "queratosis actínica" alucinada en una ficha clínica es peligrosa. Mitigaciones: glosario corto y por especialidad (no un vademécum), lista separada por comas y nunca una frase narrativa (el modelo continúa el estilo), medición A/B con y sin glosario sobre 20-30 dictados reales, marcado visual de campos de baja confianza, y revisión humana obligatoria — que ya es tu diseño.

Cuenta los tokens de verdad antes de desplegar:

```bash
.venv/bin/python -c "
from faster_whisper.tokenizer import Tokenizer
import ctranslate2, huggingface_hub, tokenizers
tk = tokenizers.Tokenizer.from_pretrained('openai/whisper-large-v3-turbo')
import asr
print(len(tk.encode(' ' + asr.GLOSARIO_DERMA).ids), 'tokens (máximo 223)')
"
```

### 5.4 La llamada desde cepi-bot

Archivo nuevo **`/mnt/sda1/cepi/cepi-bot/src/transcribe.ts`**, calcado de `imageInspect.ts`:

```ts
/**
 * Dictado del médico (escenario i de docs/ASR_TRANSCRIPCION.md §2.1).
 * Reenvía un attachment de audio a cepi-isic POST /transcribe/attachment,
 * pasando la URL autenticada de TodoERP igual que hace imageInspect.ts.
 */
import { TodoErpMcpClient } from './mcpClient.js';

const ISIC_URL = process.env.CEPI_ISIC_URL || 'http://localhost:8000';

export interface TranscribeResult {
  attachment_id: string;
  text: string;
  duration?: number;
  elapsed?: number;
  error?: string;
}

export async function transcribeAttachment(
  attachmentId: string, mcp: TodoErpMcpClient,
): Promise<TranscribeResult> {
  const fileUrl = `${mcp.apiUrl}/api/attachments/${attachmentId}/file`;
  const auth = mcp.jwt ? `Bearer ${mcp.jwt}` : '';
  try {
    const res = await fetch(`${ISIC_URL}/transcribe/attachment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachment_id: attachmentId, file_url: fileUrl, auth, language: 'es',
        ...(mcp.apiKey ? { api_key: mcp.apiKey } : {}),
      }),
    });
    if (!res.ok) {
      return { attachment_id: attachmentId, text: '', error: `HTTP ${res.status}` };
    }
    const j = await res.json() as any;
    return { attachment_id: attachmentId, text: j.text, duration: j.duration, elapsed: j.elapsed };
  } catch (e: any) {
    return { attachment_id: attachmentId, text: '', error: e?.message || String(e) };
  }
}
```

Cableado, siguiendo la convención de `CLAUDE.md` → *"Cuando agregás… un comando del bot"*:

1. **Regex** en `/mnt/sda1/cepi/cepi-bot/src/server.ts`, antes del fallthrough al LLM: `/^\/?dictado\s+([0-9a-f-]{36})$/i` → llama `transcribeAttachment()`.
2. El transcript **no se escribe directo**. Va al LLM de extracción y vuelve como **formulario prellenado** (`botForm`), que el médico revisa. Es el patrón que ya existe en `IntakeChat.vue:444 captureFicha()`.
3. **Redacción PII antes del LLM** — `cepi-bot/src/redact.ts`, frontera obligatoria de PAPER §13.3.1.
4. Línea en `/help` → `/mnt/sda1/cepi/cepi-bot/src/llm.ts`.
5. Test de regex → `/mnt/sda1/cepi/cepi-bot/tests/server_commands.test.ts`.

### 5.5 Captura de audio en el frontend

El transporte **ya existe y ya acepta audio sin tocar el servidor**: el `fileFilter` de multer en `TodoERP/backend/src/routes/attachmentsRouter.ts:42-55` es una **blacklist de ejecutables**, no una whitelist. `audio/webm`, `audio/mp4` y `audio/ogg` pasan tal cual. Y `uploadAttachment()` en `/mnt/sda1/cepi/cepi-frontend/src/api.js:352-366` acepta cualquier `Blob`.

Añade en **`/mnt/sda1/cepi/cepi-frontend/src/components/IntakeChat.vue`** (que es el chat vivo; `Chat.vue` es código muerto), junto a `onFile()` de la línea 566:

```js
// ── Dictado del médico (escenario i) ────────────────────────────────────────
const recording = ref(false);
let mediaRecorder = null, chunks = [];

async function startDictation() {
  if (busy.value || recording.value) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,           // mono: Whisper trabaja a 16 kHz mono igual
      sampleRate: 16000,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    },
  });
  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const file = new File([blob], `dictado-${Date.now()}.webm`, { type: 'audio/webm' });
    uploading.value = true;
    try {
      const a = await uploadAttachment(file);
      await send(`/dictado ${a.id}`, { _explicit: true });
    } catch (e) { error.value = 'Dictado falló: ' + (e.message || e); }
    finally { uploading.value = false; recording.value = false; }
  };
  mediaRecorder.start();
  recording.value = true;
}
function stopDictation() { if (recording.value) mediaRecorder?.stop(); }
```

Un dictado de 90 s en opus pesa ~0.5-1 MB — muy por debajo del límite de multer de **10 MB** (`attachmentsRouter.ts:37`, `UPLOAD_MAX_SIZE_MB` no está seteado en prod). El service worker no estorba: `cepi-frontend/public/sw.js:22` ignora todo lo que no sea GET.

En Android/Capacitor el interceptor de `cepi-frontend/src/native/index.js:15-28` reescribe la URL a `https://telemedicina.cepi.ec` y no toca el body, así que el `FormData` funciona igual.

*(Opcional, para más adelante: decodificar a WAV 16 kHz mono con `AudioContext` en el cliente. Reduce el tamaño de subida y elimina el decode del lado servidor — imprescindible solo si algún día vas por whisper.cpp o sherpa-onnx, que leen WAV directo y no traen FFmpeg.)*

### 5.6 El túnel (Tailscale)

WireGuard punto a punto: el coordination server ve claves públicas y metadata, **nunca el payload**. Es la única de las opciones de túnel que mantiene el audio cifrado extremo a extremo entre tus dos máquinas — `ngrok` free rota URLs **y termina TLS en su borde** (ve el audio en claro); Cloudflare Tunnel también termina TLS salvo gimnasia.

```bash
# En AMBAS máquinas (VPS y máquina de dev)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status          # anota el nombre del nodo de la máquina de dev
```

Bindea uvicorn **a la IP del tailnet, jamás a `0.0.0.0`**:

```bash
ASR_BIND=$(tailscale ip -4)
CEPI_ASR=1 ASR_DEVICE=cuda .venv/bin/uvicorn app:app --host "$ASR_BIND" --port 8000 --workers 1
```

Plan Personal: gratis para siempre, hasta 6 usuarios, dispositivos ilimitados. Y resuelve la IP dinámica sin port forwarding.

### 5.7 Despliegue

**En `/mnt/sda1/cepi/ecosystem.config.cjs`**, el bloque `cepi-isic` (que hoy tiene `env: { CEPI_ISIC_PORT: 8000 }`):

```js
env: {
  CEPI_ISIC_PORT: 8000,
  CEPI_ASR: '1',
  ASR_MODEL: 'large-v3-turbo',
  ASR_DEVICE: 'cuda',
  ASR_COMPUTE_TYPE: 'int8_float16',
  ASR_CPU_THREADS: '8',
  ASR_BEAM_SIZE: '1',
  ASR_MODEL_TTL: '600',
  ASR_MODEL_DIR: '/mnt/sda1/cepi/cepi-isic/.models',
  OMP_NUM_THREADS: '8',
},
max_memory_restart: '4G',   // sube de 1G: turbo int8 en CPU pica 2043 MB
```

```bash
pm2 restart ecosystem.config.cjs --only cepi-isic --update-env
pm2 logs cepi-isic --lines 50
```

En el VPS, **cepi-isic sigue sin desplegarse**. Solo apuntas el bot al tailnet:

```bash
ssh telemedicina
sudo -u cepi pm2 set cepi-bot:CEPI_ISIC_URL http://<nodo-tailscale-dev>:8000
sudo -u cepi pm2 restart cepi-bot --update-env
```

Y sube el timeout de nginx solo para la ruta del bot (`/etc/nginx/sites-available/telemedicina`) — en CPU un dictado puede pasarse de los 60 s por defecto:

```nginx
location /api/bot/ {
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    # ...
}
```

**Health-probe y cola.** No dejes que un dictado cuelgue detrás de nginx. En cepi-bot: probe cada 30 s a `GET ${CEPI_ISIC_URL}/health`, flag `asr_online` en memoria. Si está offline, el trabajo espera con la UI diciendo *"transcripción en cola, puedes escribir la ficha a mano"*. Y en cepi-isic, envuelve la adquisición del lock en `asyncio.wait_for()` y devuelve **429 con `Retry-After`** si no lo consigue — nunca un request colgado.

> **Regla dura: jamás caer a una API cloud en silencio.** Si algún día quieres esa opción, tiene que ser un toggle explícito por caso, con consentimiento.

Tests verdes antes de commit (`CLAUDE.md`): `npx vitest run` en `TodoERP/backend` y en `cepi-bot`.

---

## 6. Qué modelo exactamente, por ruta

| Ruta | Modelo (HuggingFace) | Formato | Disco | RAM / VRAM | Latencia 90 s | Licencia |
|---|---|---|---|---|---|---|
| **A** — navegador desktop, calidad | `onnx-community/whisper-large-v3-turbo` | ONNX (encoder fp16 + decoder q4) | **1608.4 MB** (1274.3 + 334.1) | GPU del navegador | segundos con WebGPU *(no verificado)* | MIT |
| **A** — navegador, variante liviana | `onnx-community/whisper-large-v3-turbo` en **q4f16** | ONNX | **563.5 MB** (370.0 + 193.5) | idem | idem | MIT |
| **A** — navegador, mínimo viable | `Xenova/whisper-base` | ONNX (fp32 + q4) | **206.1 MB** (82.5 + 123.6) | ~400 MB en inferencia | ~30 s WASM en Mac M3 | MIT |
| **B** — VPS actual (1140 MB) | **`nvidia/canary-180m-flash`** vía sherpa-onnx int8 | ONNX int8 | **153.7 MB** | ~400 MB RAM | 12-25 s *(estimado)* | **CC-BY-4.0** (atribución obligatoria) |
| **B** — alternativa Whisper en VPS actual | `ggml-org/whisper.cpp` → `ggml-base.bin` | GGML | 142 MiB | ~388 MB RAM | ~20-30 s *(estimado)* | MIT |
| **C1** — VPS nuevo 8 GB, CPU | `openai/whisper-large-v3-turbo` vía faster-whisper (alias `large-v3-turbo`) | CTranslate2 int8 | ~800 MB *(no verificado)* | **2043 MB pico medido** | **35-45 s** | MIT |
| **C1** — degradación en el mismo VPS | `Systran/faster-whisper-small` | CTranslate2 int8 | ~250 MB | **787 MB pico medido** | 11-13 s | MIT |
| **C2 / C3** — GPU dedicada o serverless | `openai/whisper-large-v3-turbo` | CTranslate2 fp16 | ~1.6 GB | **~1.6 GB VRAM** | 1.5-3 s | MIT |
| **D1** — tu 4060 Ti (**recomendado MVP**) | `openai/whisper-large-v3-turbo` | CT2 **int8_float16** | ~800 MB | **~1 GB VRAM** | **1.11 s medidos** | MIT |
| **D1** — si turbo no alcanza en calidad | `openai/whisper-large-v3` | CT2 float16 | ~3 GB | **4.5 GB VRAM** | **4.20 s medidos** | MIT / Apache-2.0 |
| **D2** — mini-PC clínica, CPU | `openai/whisper-large-v3-turbo` | CT2 int8, `cpu_threads=4` | ~800 MB | ~2 GB RAM | **11-15 s** *(extrapolado)* | MIT |

### Y si Whisper no te alcanza en calidad: dos alternativas que le ganan en español

Whisper dejó de ser la respuesta por defecto en 2026. WER en español del Open ASR Leaderboard (promedio FLEURS + Common Voice + MLS, snapshot 2026-07-24):

| Modelo | WER es | Licencia | Peso int8 | Nota |
|---|---|---|---|---|
| `CohereLabs/cohere-transcribe-03-2026` | **2.81** | Apache-2.0 | 1.7 GB (sherpa-onnx) | El mejor abierto en español. Cabe holgado en tu 4060 Ti (~4.1 GB fp16). **No autodetecta idioma** y rinde inconsistente con code-switching es↔en — que en dermatología es constante (peeling, láser, shaving, punch) |
| `nvidia/parakeet-tdt-0.6b-v3` | **3.71** | CC-BY-4.0 | **487 MB** | **No alucina en silencios** (arquitectura transducer, sin decoder autoregresivo). Acepta hotwords vía sherpa-onnx. Medido en CPU: **18.4x tiempo real** en un i7-12700K. Para dictado clínico con pausas, esta propiedad vale más que 0.4 puntos de WER |
| `openai/whisper-large-v3` | 4.15 | MIT | ~1.1 GB | El baseline. Alucina |

**Si te decides por Parakeet**, el runtime es **sherpa-onnx** (Apache-2.0, 13.8k★, sin PyTorch, C++ puro), que encaja perfecto con el perfil actual de cepi-isic. Dos letras chicas: las **hotwords solo funcionan con `modified_beam_search`** (el `greedy_search` por defecto las ignora en silencio), y **CC-BY-4.0 exige atribución visible** a NVIDIA en el producto.

> ⚠️ **Verificado el 2026-07-28, y hay que corregir esto: hoy las hotwords de Parakeet no se pueden usar.** El asset `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` **no incluye `bpe.model`**, y sin él sherpa cae a `modeling_unit="cjkchar"`: busca cada término del glosario como token entero en un `tokens.txt` que es BPE de subpalabras, no encuentra ninguno, y termina en `Encode hotwords failed, skipping`. No aborta — transcribe igual, sin glosario. `modified_beam_search` es necesario pero no suficiente.
>
> Dos trampas más de sherpa-onnx 1.13.4, ambas encontradas al construir el bake-off:
> - El default `model_type='transducer'` del wrapper de Python **no es un tipo válido**: cae al cargador genérico y muere con `'vocab_size' does not exist in the metadata` sobre Parakeet v3, que exporta esa metadata en el encoder y no en el decoder. Hay que pasar `model_type=""` (autodetección) explícitamente.
> - Cuando sherpa falla, **llama a `exit()` desde C++**: no lanza excepción, se lleva el proceso entero y con él lo que hubiera en el buffer de stdout. Un `try/except` alrededor no te protege.
>
> Y sobre **Canary**: ante audio que no coincide con su `src_lang` devuelve **cadena vacía**, no una transcripción mala (verificado sobre 4 clips, incluido el `test_wavs/en.wav` del propio modelo). Para dictado con code-switching —peeling, láser, shaving, punch— eso puede significar perder la nota entera en lugar de degradarla. Whisper en cambio traduce en silencio: menos catastrófico, más difícil de detectar.

> **Ojo con las variantes NC de NVIDIA:** `nvidia/canary-1b` (el original) y `nvidia/parakeet-tdt-1.1b` son **CC-BY-NC-4.0** — prohibido comercial. Los que sirven son `canary-1b-v2`, `canary-180m-flash` y `parakeet-tdt-0.6b-v2/v3`. Un dígito de diferencia en el nombre te deja con licencia no comercial.

### Lo que NO existe: no lo busques

**No hay ningún modelo ASR abierto con fine-tuning médico en español publicado a julio de 2026.** `google/medasr` es solo inglés y con licencia restringida. Y el hallazgo más importante es negativo: el estudio de Emory (medRxiv, 2026-07-14) fine-tuneó Whisper Large v3 sobre consultas médicas en español latinoamericano y **ninguna iteración superó al modelo vanilla**. Antes de gastar semanas en fine-tuning, agota las palancas baratas: `hotwords`, VAD, y normalización posterior en el LLM.

---

## 7. Plan B honesto

Si el hardware local no da latencia aceptable, la degradación **en este orden**, de menos mala a más mala:

**1. Modelo más chico, mismo flujo síncrono.** `large-v3-turbo` → `small` int8. Ganas 3x de velocidad y RAM. Pierdes justo donde duele: `small` en español médico corre a grosso modo 2-3x el WER de `large-v3`, y los errores caen exactamente sobre queratosis actínica, dermatoscopia, Breslow, imiquimod, hidradenitis supurativa. **Solo aceptable si el glosario de `hotwords` y la normalización del LLM absorben el daño — y eso lo mides, no lo asumes.**

**2. Cambia de familia antes de bajar de tamaño.** `nvidia/canary-180m-flash` pesa 154 MB (menos que `whisper-base` en sherpa-onnx) y tiene WER es de 3.17 (MLS) / 4.90 (MCV). `whisper-small` está **estrictamente dominado**: no hay razón para elegirlo en español en 2026. Si tienes que achicar, achica de familia, no de tamaño.

**3. Asíncrono con notificación.** El dictado se sube y se encola (`status: pending_asr`); el médico sigue con el paciente; cuando el transcript está listo llega una push y el formulario prellenado aparece en el chat. La infraestructura de push **ya existe** (`@capacitor-firebase/messaging` está en `cepi-frontend`). Costo: los 4-6 días de ingeniería que el diseño síncrono se ahorraba — worker, estado `pending`, polling o push, reconciliación en `IntakeChat.vue`. Pero es la degradación **honesta**: nunca un request colgado, nunca un spinner de 3 minutos.

**4. Dictado por partes.** Cortar en tramos de 45-60 s con un botón "siguiente sección" alineado a los grupos de la ficha (`ficha_grp_*`). Cada tramo se transcribe mientras el médico dicta el siguiente: la latencia percibida colapsa a la del último tramo. Bonus: cada tramo se puede mapear a un grupo del formulario, lo que hace la extracción **más precisa**, no menos. Contra: más UI, más estado, y el médico tiene que pensar en la estructura mientras dicta.

**5. Modo "transcripción en tu equipo" solo en desktop.** Feature-detection de `navigator.gpu` en el navegador de escritorio → `transformers.js` v4 con `whisper-large-v3-turbo` q4f16 (563 MB, cacheado permanentemente). Es un diferencial de privacidad real y elimina el servidor del camino. **No lo prometas en el APK Android** sin antes correr el test de 10 minutos: mete `console.log('webgpu', !!navigator.gpu, navigator.userAgent)` y `navigator.gpu && await navigator.gpu.requestAdapter()` en `cepi-frontend`, compila el APK y míralo por `chrome://inspect`. Las fuentes se contradicen (MDN dice "mirror", caniuse dice no, caniwebview dice no) y esa prueba determina toda la estrategia móvil.

**Lo que NO es Plan B:** caer a la nube en silencio. Si alguna vez quieres esa opción, es un toggle explícito por caso con consentimiento documentado, nunca un fallback automático.

**Y un riesgo específico de Ecuador:** los cortes de luz. Un UPS te da 15-30 minutos; Ecuador ha tenido cortes de varias horas. Por eso el diseño **no puede ser transcripción sincrónica obligatoria** — el patrón de cola + degradación no es opcional, es lo que hace que las rutas D1 y D2 sean viables.

---

## 8. Lo que ganas y lo que pierdes frente a la nube

### Calidad (WER)

**Empate exacto.** Corres `whisper-large-v3-turbo`, que es MIT. Groq corre `whisper-large-v3-turbo`. Mismos pesos, mismo WER, mismas alucinaciones.

Y de hecho **ganas dos cosas** que la nube no te da:

1. **`hotwords` / `initial_prompt`.** Puedes sesgar el modelo hacia tu vocabulario dermatológico ecuatoriano. Es la palanca más barata que existe para bajar el WER en términos de dominio, y solo la tienes del lado servidor.
2. **Reproducibilidad.** El modelo queda congelado y versionado en tu hardware. Puedes reproducir una transcripción de hace seis meses. Con una API no: si el proveedor cambia el checkpoint, no te enteras.

Si en algún momento quieres **más** calidad que la nube: `CohereLabs/cohere-transcribe-03-2026` (WER es **2.81** vs 4.15 de Whisper large-v3, Apache-2.0) cabe de sobra en tu 4060 Ti. Groq no te ofrece ese modelo.

### Latencia

| | Tiempo |
|---|---|
| Groq (216x tiempo real) | ~0.5 s + red |
| **Tu 4060 Ti (medido)** | **1.11 s de inferencia, 2-4 s extremo a extremo** |
| Mini-PC en la clínica | 11-15 s |
| VPS 8 GB CPU | 35-45 s |

**Pierdes poco en D1 y nada que el usuario note.** El flujo es "el médico dicta, revisa un formulario prellenado" — 3 segundos contra 0.5 es indistinguible. En D2 (11-15 s) empieza a notarse pero sigue siendo síncrono. En C1 (35-45 s) ya no: ahí necesitas asíncrono.

### Dinero

| Opción | 200 dictados/mes | 2000 dictados/mes |
|---|---|---|
| Groq | **USD 0.20** | **USD 2.00** |
| Tu máquina de dev (D1) | USD 0 – 8.41 | USD 0 – 8.41 |
| VPS 8 GB (C1) | USD 6.25 | USD 6.25 |
| Mini-PC clínica (D2) | USD 19 – 23 | USD 19 – 23 |

**El sobreprecio absoluto de la soberanía es de USD 6 a USD 23 al mes.** Menos que una consulta.

En múltiplos suena catastrófico (×30 a ×115), pero eso es un artefacto de dividir por 20 centavos. Y como casi todo el costo soberano es **fijo**, el múltiplo se derrumba 10x al pasar de 200 a 2000 dictados: con 2000, la misma mini-PC de USD 19/mes deja el sobreprecio en ×9. **Si la clínica crece, el argumento a favor de lo propio se fortalece, no se debilita.**

### Operación — aquí es donde de verdad pagas

Esto es lo que la comparación de precios esconde, y es el costo real:

| Pregunta | Groq | Tú (D1 / D2) |
|---|---|---|
| ¿Quién actualiza el modelo? | Nadie, el proveedor | **Tú.** Pinnea `faster-whisper==1.2.1` y `ctranslate2>=4,<5`. Sepas que faster-whisper lleva **cero commits en 2026** (último 2025-11-19) — es estable, pero no esperes features |
| ¿Quién vigila que el servicio siga vivo? | Nadie | **Tú.** PM2 con `Restart=always`, health-probe cada 30 s, alerta cuando `asr_online` pase a false |
| ¿Qué pasa un domingo a las 23:00? | Nada, hay SLA | **Se cae y nadie contesta.** Por eso la cola no es opcional: el trabajo espera y la UI dice *"transcripción en cola, puedes escribir la ficha a mano"* |
| ¿Corte de luz? | Irrelevante | UPS (15-30 min) + escalón de degradación al VPS de 8 GB con `small` int8 |
| ¿Se te fue el ISP residencial? | Irrelevante | Tailscale no rutea a una máquina inalcanzable. Mismo patrón de cola |
| ¿Custodia física ante auditoría? | El DPA del proveedor | **D1: floja** (desktop en una casa, sin rack cerrado, sin log de acceso, disco probablemente sin cifrar). **D2: sólida** (gabinete cerrado en la clínica) |
| ¿Superficie de mantenimiento nueva? | Cero | Un venv, un modelo en disco, un túnel, un health-probe, una cola, y un timeout de nginx |

**El resumen honesto:** cambias USD 6-23/mes y **una pieza de infraestructura nueva que alguien tiene que cuidar** por la garantía verificable de que el audio clínico nunca sale de una máquina que posees físicamente. Con LOPDP encima, ese cambio se defiende solo. Pero es trabajo real, no un cambio de variable de entorno — y por eso el punto §5.7 (health-probe + cola + degradación) **no es opcional**: es lo que convierte "una desktop en una casa" en algo que puedes poner delante de un médico.

### Una última cosa, y es la más importante

Con cualquiera de los tres mejores modelos el WER está entre 2.8% y 3.7% — una diferencia que el LLM downstream probablemente absorbe. **Elegir modelo es la parte fácil.** Lo que decide si el proyecto vive es lo que ya dice `docs/ASR_TRANSCRIPCION.md` §5.7: **medir si la ficha autollenada queda correcta**, campo por campo, y el flujo de revisión humana obligatoria. No gastes ahí tu presupuesto de decisión.

---

### Anexo: datos marcados como NO verificados

- Latencias del navegador con WebGPU (ruta A) — no medidas por nosotros.
- Soporte de WebGPU en el WebView de Capacitor/Android — **contradicción abierta entre MDN, caniuse y caniwebview.** Verificable en 10 minutos (§7, punto 5).
- Tamaño en disco del checkpoint CTranslate2 de `large-v3-turbo` (~800 MB).
- Latencias del VPS y del mini-PC: **extrapoladas** con el factor 2.30x medido por microbenchmark GEMM, no medidas directamente.
- WER de `whisper-large-v3-turbo` en español (4.15): el CSV oficial del leaderboard le asigna **exactamente los mismos tres números que a `large-v3`** — casi seguro un error de copiado. En inglés, donde sí están medidos por separado, turbo es peor (7.80 vs 7.33). Asume algo peor que 4.15.
- Los benchmarks públicos (FLEURS = Wikipedia leída, Common Voice = voluntarios, MLS = audiolibros) **no se parecen a un dermatólogo ecuatoriano dictando**. Un delta de 0.5 puntos de WER entre modelos puede invertirse por completo en tu dominio. Por eso §5.0 va primero.