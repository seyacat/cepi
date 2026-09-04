# Grabar la consulta, transcribirla y llenar la ficha automáticamente

### Documento de arquitectura y decisión — CEPI Telemedicina

**Fecha:** 2026-07-28 · **Autor:** arquitectura · **Estado:** propuesta rev. 2 (incorpora revisión factual y de producto)

> **⚠️ Superado en parte.** Este documento asume proveedores cloud. El usuario descartó esa vía y pidió modelo local. Ver:
> - `docs/ASR_OPCIONES_LOCALES.md` — las tres vías locales comparadas (teclado del sistema, ASR nativo on-device, servidor propio).
> - `docs/ASR_PLAN_LOCAL.md` — plan de implementación de la vía servidor.
>
> Todo lo de este documento sobre **pipeline transcript→ficha (§5), legal (§7) y métricas (§5.7) sigue vigente y es lo que más importa.**
> Dos correcciones concretas para la vía local: (a) el consejo de §6 sobre el `prompt` de vocabulario **no aplica a `faster-whisper`** — con
> `condition_on_previous_text=False`, `initial_prompt` solo sesga los primeros 30 s; el glosario va en **`hotwords`**, que se reinyecta en cada
> ventana; (b) Whisper dejó de ser el mejor modelo en español (Cohere Transcribe 03-2026, Canary y Parakeet le ganan) y `small` es **inservible**
> para uso clínico.

---

## 1. Resumen ejecutivo

La recomendación cambió respecto de la primera versión de este documento. **No empieces por grabar la conversación médico-paciente. Empieza por el dictado del médico.**

El plan es: **grabar en la PWA con `MediaRecorder`, subir el audio como attachment normal, transcribir de forma síncrona con Groq (`whisper-large-v3-turbo`, USD 0.04/h) y volcar el resultado a la ficha como un formulario prellenado que el médico revisa, corrige y guarda** — nunca como escritura directa. La captura es la única pieza que cambia por plataforma; el ASR y la extracción son idénticos en web, Android e iOS.

Por qué el dictado y no el *ambient scribe* completo:

- Es el producto que ya está definido. `docs/PAPER.md:1` describe *"el médico habla con el bot durante (o después de) la consulta"*. No hay una consulta sincrónica que grabar: **no existe una sola línea de WebRTC, Jitsi, LiveKit, Twilio o Daily en todo el repo**. `TodoERP/database/medical-seed/007_telemedicine.sql` modela turnos, especialidades y derivación asíncrona. Esto es telemedicina *store-and-forward* por chat.
- Un dictado de 90 s se transcribe en 2-3 s. **Cabe dentro de los 60 s de `proxy_read_timeout` de nginx**, y eso elimina el worker asíncrono, el estado `pending`, el polling del front y todo el patrón `await_isic`. Son 4-6 días de ingeniería que desaparecen, no USD 10/mes.
- Un hablante, sin diarización, elimina el consentimiento del paciente y del acompañante, la PII de terceros en el audio, el ruido de consultorio, los audios de 40 min, el chunking resiliente y la ola de demandas colectivas de §7.1. Media sección 7 se vuelve inaplicable.
- Es reversible: captura → attachment → extracción → formulario prellenado es idéntico en ambos escenarios. Si el piloto pide conversación completa, cambias de proveedor y agregas diarización.

Autohospedar Whisper en el VPS actual **no es viable** (1 core físico, 1.15 GiB libres, sin GPU) y frente a las APIs cloud nunca gana por precio: la única justificación del self-host es soberanía del dato, no ahorro. El costo del ASR es marginal en cualquier escenario: **200 dictados de 2 min cuestan USD 0.27/mes; 200 conversaciones de 15 min cuestan entre USD 9 y USD 34**. El trabajo real —y el riesgo real— no está en el ASR sino en el consentimiento (LOPDP Art. 8 y 26.a; COIP Art. 178 con matices), en la retención del audio, en la revisión humana obligatoria de una salida que alucina medicamentos, y en **medir si la ficha autollenada es correcta** — la métrica que decide si el proyecto vive y que este documento define en §5.7.

La pregunta que decide toda la arquitectura no es técnica y no se responde con un benchmark de WER: **¿el médico no quiere tipear, o el médico pierde información entre la consulta y la ficha?** La primera hipótesis la resuelve entera el dictado. La segunda exige el ambient scribe. Se responde con tres llamadas a médicos, no con dos días de ingeniería. Ver §8, pregunta 1.

---

## 2. Anatomía del problema: cinco piezas independientes

El error de encuadre más caro sería tratar esto como "una feature". Son cinco subsistemas con decisiones desacopladas:

```
[1] CAPTURA          [2] TRANSPORTE/       [3] ASR              [4] EXTRACCIÓN
    de audio      →      ALMACENAMIENTO  →    (audio→texto)  →     (texto→campos)
                                                                        ↓
                                                                 [5] CONFIRMACIÓN
                                                                     HUMANA
```

| Pieza | Qué decide | ¿Cambia por plataforma? | Estado hoy en el repo |
|---|---|---|---|
| **1. Captura** | `MediaRecorder` web vs plugin nativo; formato; constraints de audio; permisos | **SÍ — es la única** | No existe. Cero `getUserMedia`/`MediaRecorder` en todo `cepi-frontend/src` |
| **2. Transporte** | Dónde vive el blob, límites de tamaño, resiliencia, ciclo de vida | No | **Existe y sirve para archivos chicos**: `POST /api/attachments`. Sin reintento ni resume |
| **3. ASR** | Proveedor cloud vs self-host, modelo, diarización, sincronía | No | No existe |
| **4. Extracción** | Prompt, esquema de salida, coerción de valores | No | Parcialmente: `coercePatch()` ya resuelve el problema difícil |
| **5. Confirmación** | Gate sí/no vs formulario prellenado vs escritura directa | No | Existe el mecanismo (`pending_action`), está apagado |

**Consecuencia práctica:** puedes elegir el proveedor de ASR hoy y cambiarlo en tres meses sin tocar una línea del frontend, y puedes lanzar en PWA y agregar Android/iOS después sin rehacer nada aguas abajo. **No las decidas juntas.**

### 2.1 Antes de todo: cuál de los tres productos estás construyendo

Este es el punto que la primera versión del documento colapsó en uno solo. Hay **tres escenarios de captura distintos**, con tres diseños de consentimiento, tres perfiles de riesgo y tres arquitecturas:

| Escenario | Quién habla | Duración típica | Diarización | Consentimiento | Complejidad |
|---|---|---|---|---|---|
| **(i) Dictado del médico** | 1 hablante, cerca del micrófono, vocabulario controlado | 60-180 s | No hace falta | Solo LOPDP por el contenido (datos del paciente en la voz del médico) | **Baja** — síncrono, sin worker |
| **(ii) Nota de voz del paciente en el chat** | 1 hablante, el propio titular | 15-90 s | No hace falta | El paciente graba voluntariamente; consentimiento implícito por el acto, documentar igual | Baja |
| **(iii) Consulta presencial grabada** (teléfono sobre la mesa) | 2-4 hablantes, micrófono lejano, ruido | 15-40 min | Imprescindible | **Dos consentimientos documentados** + acompañantes | **Alta** — chunking, worker, retención |

Un cuarto escenario, la **teleconsulta sincrónica por video**, no existe hoy en el producto y tiene una trampa técnica propia (§2.4).

Este documento recomienda construir **(i)** primero, dejar **(ii)** como consecuencia gratuita del mismo pipeline, y tratar **(iii)** como una decisión de mes 3 condicionada al piloto.

### 2.2 Pieza 2 — transporte: ya está construido (para archivos chicos)

Este es el hallazgo más valioso de la investigación. El pipeline de subida que hoy usan las imágenes acepta audio **sin cambiar una línea de servidor**:

- `uploadAttachment(file)` en `/mnt/sda1/cepi/cepi-frontend/src/api.js:352-366` es un `multipart/form-data` con campo `file` y `Authorization: Bearer`. Acepta cualquier `Blob`/`File`.
- El `fileFilter` de multer en `/mnt/sda1/cepi/TodoERP/backend/src/routes/attachmentsRouter.ts:42-55` es una **blacklist de ejecutables**, no una whitelist. `audio/webm`, `audio/mp4` y `audio/ogg` pasan sin tocar nada.
- El service worker no estorba: `/mnt/sda1/cepi/cepi-frontend/public/sw.js:22` ignora todo lo que no sea GET, y las líneas 25-27 excluyen `/api` del cache.
- En la app nativa, el interceptor de `/mnt/sda1/cepi/cepi-frontend/src/native/index.js:15-28` reescribe la URL relativa a `https://telemedicina.cepi.ec` y no toca el body, así que el `FormData` funciona igual.

**Límites reales a respetar:**

| Capa | Límite | Archivo |
|---|---|---|
| nginx `client_max_body_size` | 50 MB | `/etc/nginx/sites-available/telemedicina` |
| multer `fileSize` | **10 MB** (`UPLOAD_MAX_SIZE_MB` no está seteado en prod) | `attachmentsRouter.ts:37` |
| Archivos por request | 10 | `attachmentsRouter.ts:105` |
| `express.json` (irrelevante para multipart) | 5 MB | `TodoERP/backend/src/app.ts:85`, `cepi-bot/src/server.ts:74` |
| `proxy_read_timeout` de `/api/` | **60 s (default de nginx)** — solo `/api/bot/` tiene 120 s | `/etc/nginx/sites-available/telemedicina` |
| Espacio en disco del VPS | 79 GB libres de 87 GB | `df -h /` en prod, 2026-07-28 |

**Aritmética de tamaños (Opus mono):**

| Contenido | Bitrate | Tamaño | ¿Pasa multer 10 MB? |
|---|---|---|---|
| Dictado 90 s | 24 kbps | **~270 KB** | Holgado |
| Dictado 3 min | 24 kbps | ~540 KB | Holgado |
| Consulta 15 min | 24 kbps | ~2.7 MB | Sí |
| Consulta 30 min | 32 kbps | ~7.2 MB | Justo |
| Consulta 15 min en WAV 16 kHz | 256 kbps | ~28.8 MB | **No** |

**El muro es multer, no nginx** — pero solo importa en el escenario (iii). Para el dictado no hay ningún límite cerca. Si algún día grabas consultas completas: setea `UPLOAD_MAX_SIZE_MB=40` en `/opt/cepi/TodoERP/backend/.env` y fuerza Opus desde el cliente. Con chunking (§2.3) el problema desaparece del todo.

**Detalle load-bearing:** el backend deriva la extensión con `path.extname(file.originalname)` (`attachmentsRouter.ts:74`) para renombrar a `<sha256><ext>`. Si el `File` llega sin extensión, el archivo queda sin ella en disco. Ponle nombre coherente con el `mimeType` que negocie `MediaRecorder` — y ten en cuenta que el nombre del `sha256` implica **deduplicación por contenido**: dos grabaciones idénticas colapsan al mismo archivo.

### 2.3 Lo que el transporte NO tiene: resiliencia

`uploadAttachment` es un POST monolítico **sin reintento ni resume**. Si se corta al 90% de un archivo de 7 MB en 3G, se pierde una consulta irrepetible. Y la cola offline no ayuda:

- `api.js:193-239` implementa el outbox sobre **`localStorage`** (clave `cepi.outbox`, JSON serializado). Cuota típica ~5 MB, y **no admite blobs**; guardarlos en base64 los infla 33% y revienta la cuota con un solo audio.
- El SW (`public/sw.js:22`) ignora todo lo que no sea GET → **no hay Background Sync**.
- El outbox solo encola el JSON del turno de chat, no archivos.

Para el **dictado (escenario i)** esto es tolerable: 270 KB con reintento simple y feedback claro alcanzan. Para el **escenario (iii)** es bloqueante, y la solución correcta es chunking:

1. Grabar con `MediaRecorder(..., { timeslice: 15000 })` y **subir chunk a chunk durante la consulta**. Cada chunk <1 MB elimina de un plumazo el muro de multer, el `proxy_read_timeout` de 60 s y el límite de duración.
2. Persistir los chunks pendientes en **IndexedDB** (no `localStorage`), con estado y backoff enganchado al evento `online`.
3. Concatenación server-side por `session_id` + `seq`. **Atención: `ffmpeg` NO está instalado en el VPS de prod** (`which ffmpeg` devuelve vacío, verificado 2026-07-28) y WebM/Opus no se concatena por bytes. O instalas ffmpeg, o transcribes chunk por chunk y concatenas texto.
4. Una entidad `recording_session` con `total_chunks` y `closed_at` para **detectar grabaciones truncadas**. Sin eso, transcribes media consulta y llenas la ficha con media consulta, sin que nadie lo note. Esto es un error silencioso con consecuencia clínica.
5. Política "subir solo por Wi-Fi" usando `navigator.connection.saveData` — el chunking la habilita.
6. `navigator.storage.persist()` al primer uso. Sin eso, **iOS Safari puede evictar el IndexedDB de una PWA tras ~7 días de inactividad** y Android lo hace bajo presión de disco. Si el audio es la única evidencia de la consulta, evictarlo es pérdida de dato clínico. Añade además un límite duro de minutos grabables sin conexión, y muéstralo.

### 2.4 Lo que NO existe: videollamada — y la trampa si algún día existe

Verificado: cero `WebRTC`, `RTCPeerConnection`, Jitsi, LiveKit, Twilio o Daily en todo `/mnt/sda1/cepi` (los únicos hits de "zoom" son el lightbox de imágenes). Si mañana se agrega video, **el diseño de captura de la sección 4 no sirve**:

- `getUserMedia({audio:true})` + `MediaRecorder` captura **solo el micrófono local**. La voz del paciente remoto llega por el altavoz y el cancelador de eco del navegador la **elimina activamente** del track local. Grabarías al médico hablando solo.
- Para grabar ambos lados hay que tomar el track remoto del `RTCPeerConnection` y mezclarlo vía `AudioContext` + `MediaStreamAudioDestinationNode`, o grabar en el SFU.
- **El corolario es una buena noticia:** con videollamada tienes **dos tracks separados = diarización perfecta y gratis**. Pagar `speaker_labels` y montar heurísticas de identidad de hablante sería un autogol. Si el roadmap incluye video, la decisión de diarización se pospone hasta entonces.

### 2.5 Lo que NO hay que reutilizar

El marcador `[adjunto: <nombre> · <uuid>]` que hoy inyecta `IntakeChat.vue:560` **no sirve para audio**. Con precisión:

- Quien dispara el quick-reply "¿Esta imagen es de la lesión o un formulario de consentimiento?" es **solo** `cepi-bot/src/server.ts:1722-1746`.
- El bloque de `cepi-bot/src/llm.ts:88-97` **no** hace eso: devuelve un acuse genérico (`Recibí el adjunto **${name}** (id: …). Cuando tengas un episodio activo, dime "guardar imagen en episodio <id>"…`) sin quick replies ni tratamiento de imagen. Además vive en el **adapter heurístico de fallback**, que no es el provider en uso: `ecosystem.config.cjs:61` fija `CEPI_LLM_PROVIDER: 'deepseek'` → `llmDeepSeek.ts`.
- **La rama de adjunto exige paciente activo:** `server.ts:1723` es `if (attachMatch && activePatientId)`. Sin paciente activo, el token cae al LLM. Un token `[audio:]` diseñado igual heredaría esa condición — decídelo explícitamente: para el dictado, lo correcto es exigir **episodio** activo, no solo paciente, porque el destino del patch es la ficha del episodio.

Hace falta un token propio (`[audio: <nombre> · <uuid>]`) con su propia rama en el `chatHandler` y su regex en `MessageContent.vue:54`.

---

## 3. Matriz de opciones de ASR

Precios verificados en páginas oficiales el 2026-07-28.

| Proveedor / modelo | USD/hora de audio | Diarización | WER español | Ubicación del dato | Esfuerzo |
|---|---|---|---|---|---|
| **Groq `whisper-large-v3-turbo`** | **$0.04** | **No tiene** | 12% agregado multilingüe; 9.7% en conversación médica ES (benchmark de terceros) | **US únicamente**. DPA/BAA sin verificar | **Trivial** — API compatible con OpenAI, **síncrona**, acepta `webm`/`mp4`/`ogg` directo |
| **Groq `whisper-large-v3`** | $0.111 | No tiene | 10.3% agregado | US únicamente | Trivial |
| **AssemblyAI Universal-3.5 Pro** (async) | $0.21 + $0.02 diariz. = **$0.23** | Incluida (`speaker_labels`), `utterances[]` agrupado | **3.98% en FLEURS** (audio limpio leído) / **9.1% en conversación médica ES** (medido por Speechmatics) | US o EU (self-serve). BAA estándar | **Bajo** — SDK TS, polling automático |
| **Speechmatics Medical Model (español)** | Página lista "desde $0.129/h" en el tier Pro; **el Medical Model no tiene precio público — hay que preguntarlo** | Incluida, y explícitamente entrenada para separar *clinician / patient / family* | **7.3% en conversación médica ES** — el mejor publicado, pero **es su propio benchmark** | Multi-región cloud + **on-prem** | Medio — proveedor nuevo, sin SDK en el repo |
| **ElevenLabs Scribe v2** | **$0.22** (diarización incluida) | Sí, hasta 32 hablantes, `num_speakers` | No publicado (2.2% AA-WER es **en inglés**) | US, EU, India. BAA **solo Enterprise** | **Bajo** |
| **Deepgram nova-3 multilingual** | $0.0092/min = $0.55 + $0.0020/min diariz. = **$0.67** | Sí (`diarize_model=latest`) | 9.8% en conversación médica ES (medido por Speechmatics) | US o EU. BAA **solo Enterprise** | **Muy bajo** |
| **OpenAI gpt-4o-transcribe-diarize** | **$0.36** (diarización incluida) | Sí, en el mismo modelo | 9.5% en conversación médica ES (medido por Speechmatics) | Multi-región (EU/US/…). BAA disponible | **Medio** — límite 25 MB obliga a ffmpeg, que no está en el VPS |
| **Azure AI Speech** (batch) | **$0.18 — diarización incluida sin cargo extra** | Sí, `maxSpeakers` 2-35 | 11.1% en conversación médica ES (medido por Speechmatics) | **Brazil South / Mexico Central / Chile Central** — única opción LATAM real | Medio |
| **AWS Transcribe estándar** | **Dato en disputa: $0.36/h según el ejemplo de la página oficial; $1.44/h si aplica la tabla escalonada tier 1 (0-250K min). Verificar con la calculadora en `sa-east-1` antes de usarlo.** Diarización incluida | Sí | 10.1% en conversación médica ES (medido por Speechmatics) | **sa-east-1 (São Paulo)** | Medio-alto (S3 + job + polling) |
| **Google Chirp 3** (dynamic batch) | **$0.18** ($0.96 en standard) | Sí | 10.4% en conversación médica ES (medido por Speechmatics) | us / eu multi-región | Medio-alto |
| **Self-host faster-whisper** (VPS 4 vCPU) | $0 marginal, ~$20-30/mes fijo | Requiere pyannote/sherpa-onnx aparte | ~**9.7%** en conversación médica ES | **Tu servidor** | **Alto** |

### 3.1 Cómo leer estos WER sin engañarte

La primera versión de este documento afirmaba que *"el único WER de español publicado por un proveedor es el de AssemblyAI"* y que *"ningún modelo médico comercial soporta español"*. **Las dos afirmaciones eran falsas**, y por la misma fuente que el propio documento citaba para el 9.7% de Whisper.

Speechmatics lanzó (2025-10-22) su **Medical Model en español**, batch y tiempo real, cloud y on-prem, con diarización incluida, y publicó un benchmark de **conversación médica en español**:

| Sistema | WER conversación médica ES |
|---|---:|
| **Speechmatics Medical** | **7.3%** |
| AssemblyAI | 9.1% |
| GPT-4o | 9.5% |
| Whisper | 9.7% |
| Deepgram | 9.8% |
| Amazon | 10.1% |
| Google | 10.4% |
| Microsoft | 11.1% |

Tres lecturas obligatorias de esta tabla:

1. **El 3.98% de AssemblyAI y el 9.7% de Whisper no son comparables.** El 3.98% es FLEURS: audio leído, limpio, un hablante. En conversación médica espontánea el **mismo** AssemblyAI da 9.1%. Comparar 3.98% contra 9.7% para justificar al proveedor caro es comparar dos problemas distintos. El factor de degradación real audio-limpio → conversación es ~2.3x.
2. **La dispersión entre proveedores es de 4 puntos; la dispersión entre escenarios de captura es de 5-6 puntos.** Elegir bien el escenario (dictado limpio cerca del micrófono) y el micrófono mueve el WER más que elegir bien el proveedor. Ver §4.4.
3. **Este benchmark es del propio Speechmatics.** No es prueba independiente. Trátalo como una hipótesis fuerte que tu benchmark propio debe confirmar, no como un hecho.

### 3.2 Descartados y por qué

- **AWS Transcribe Medical**: disponible **únicamente en inglés de EE.UU.** (doc oficial, literal). Además $4.50/h. Irrelevante.
- **Deepgram nova-3-medical**: English-only. Irrelevante.
- **Google `medical_conversation` / `medical_dictation`**: solo `en-US`, solo API V1, $4.68/h. Irrelevante.
- **AssemblyAI "Medical Mode"** (+$0.15/h): su documentación **no aclara si aplica a idiomas distintos del inglés — sin verificar, hay que preguntarlo**.
- **Groq queda descartado *para el escenario (iii)*, no para el (i).** No tiene diarización de ningún tipo, y montar pyannote aparte y alinear por timestamps cuesta más en ingeniería de lo que ahorra. Para dictado de un solo hablante es la mejor opción del mercado por relación esfuerzo/precio.

### 3.3 Costo mensual real: ASR **más** LLM de extracción

La primera versión costeaba solo el ASR. **El LLM de extracción no aparecía en ninguna tabla**, y en el escenario de conversación completa puede superarlo.

**ASR — escenario (i), dictado de ~2 min ⇒ 0.033 h:**

| Volumen | Horas/mes | Groq turbo $0.04/h | AssemblyAI sin diariz. $0.21/h |
|---|---:|---:|---:|
| 20 dictados/mes | 0.67 h | **$0.03** | $0.14 |
| 200 dictados/mes | 6.7 h | **$0.27** | $1.40 |
| 2000 dictados/mes | 67 h | **$2.68** | $14.00 |

**ASR — escenario (iii), consulta de ~15 min ⇒ 0.25 h:**

| Volumen | Horas/mes | Azure batch $0.18 | AssemblyAI $0.23 | ElevenLabs $0.22 | OpenAI $0.36 | Deepgram $0.67 |
|---|---:|---:|---:|---:|---:|---:|
| 20 consultas/mes | 5 h | $0.90 | $1.15 | $1.10 | $1.80 | $3.35 |
| 200 consultas/mes | 50 h | $9.00 | **$11.50** | $11.00 | $18.00 | $33.50 |
| 2000 consultas/mes | 500 h | $90 | **$115** | $110 | $180 | $335 |

**LLM de extracción** (transcript + prompt de sistema + esquema de ~50 campos + reintentos):

| Escenario | Tokens de entrada / consulta | 200/mes | 2000/mes |
|---|---:|---:|---:|
| Dictado 2 min (~450 tok de transcript) | ~4-5k | ~1M | ~10M |
| Conversación 15 min (~3.300 tok de transcript) | ~10-15k | ~2.5M | ~25M |

A precios de modelo económico (~$0.30/M entrada) eso es $0.30-$7.50/mes. A precios de modelo frontier (~$3/M entrada) es $3-$75/mes. **Con conversación completa, 2000 consultas y un modelo frontier, la extracción cuesta más que el ASR.** Verifica el precio del modelo que elijas antes de proyectar; si haces verificación en dos pasos, duplica.

**Lo que estas tablas siguen sin costear, y es lo que decide el proyecto:**

- **El tiempo del médico revisando.** Si revisar el formulario prellenado toma 7 min y llenarlo a mano tomaba 6, el ROI es negativo por mucho que el ASR cueste centavos. Instruméntalo desde el día 1 (§5.7).
- **Los backups.** El VPS tiene 79 GB libres, así que el almacenamiento no es problema. Pero `scripts/backup-db.sh` y los backups de `/opt/cepi/uploads` **ahora contendrán audio clínico**, lo que cambia el alcance del cifrado de backups y su política de retención. Si el audio se borra a los 14 días pero vive 6 meses en un backup, la política de retención es ficción.

**Lectura:** el costo del ASR no es un criterio de decisión en ningún escenario realista. Lo que sí decide es calidad en español conversacional, diarización, a dónde va el audio y **cuánto tarda el médico en revisar**.

### 3.4 Por qué el self-host queda descartado (por ahora)

Medición real del VPS el 2026-07-28:

- **CPU:** AMD EPYC-Milan, `nproc`=2 pero **1 core físico × 2 threads**, 1996 MHz. Bench: bucle Python de 8M iteraciones = 0.93 s (~0.5x un core de desktop moderno).
- **RAM:** MemTotal 1855 MB, **MemAvailable 1147 MB**. Ahí ya conviven `todoerp-backend` (~99 MB), `cepi-bot` (~101 MB), PM2 God (~80 MB) y Postgres (`shared_buffers` 160 MB).
- **GPU:** `lspci` solo devuelve un Virtio GPU de Red Hat. No hay `nvidia-smi`.
- **Disco:** 79 GB libres de 87 GB. No es la restricción.
- **`ffmpeg` no está instalado.** Cualquier diseño que requiera transcodificar o concatenar audio necesita instalarlo primero.
- **`cepi-isic` ni siquiera está desplegado**: en `/opt/cepi/cepi-isic/` no hay `.venv` y no figura en PM2.

Estimación con faster-whisper int8, `cpu_threads=2`: `tiny` ≈ 1.5-2.5x tiempo real, `base` ≈ 0.8-1.2x, `small` ≈ 0.3-0.4x. Traducido: **una consulta de 15 min tarda ~12-20 min con `base` y ~40 min con `small`**, saturando el único core y degradando el chat, el ERP y Postgres. Y `small` es el piso de calidad aceptable para contenido clínico en español.

Frente a Groq ($0.04/h) el self-host en CPU **nunca gana por precio**, ni saturando el VPS al 100%. Frente a AssemblyAI ($0.23/h) el break-even está en ~90-130 h de audio al mes — y a ese volumen el VPS ya no da abasto. **Self-host solo tiene sentido si la decisión es soberanía del dato, y entonces requiere subir el VPS a 4 vCPU dedicadas / 8 GB (~$40-60/mes) como mínimo.** La alternativa seria de soberanía no es el VPS actual: es el despliegue **on-prem de Speechmatics**, que sí tiene modelo médico en español.

---

## 4. Opciones por plataforma

### Opción A — PWA (recomendada para empezar)

**Cómo se captura:** `navigator.mediaDevices.getUserMedia({audio: {...constraints}})` + `MediaRecorder` con negociación de `mimeType` en runtime. Push-to-talk para dictados cortos, o botón grabar/detener con indicador persistente.

**Qué cambia en el repo:**

| Archivo | Cambio |
|---|---|
| `cepi-frontend/src/components/IntakeChat.vue:76-78` | Ampliar `accept="image/*"` → `accept="image/*,audio/*"`; añadir botón de micrófono junto al clip 📎 |
| `cepi-frontend/src/components/IntakeChat.vue:566-575` | `onFile` ya sirve; añadir `onAudioReady(blob)` que llame al mismo `uploadAttachment` |
| `cepi-frontend/src/components/IntakeChat.vue:560` | Emitir `[audio: <nombre> · <uuid>]` en vez de `[adjunto: …]` |
| `cepi-frontend/src/composables/useRecorder.js` | **Nuevo.** `getUserMedia` + `MediaRecorder` + `isTypeSupported()` + timeslice + watchdog + `AnalyserNode` para el medidor de nivel |
| `cepi-frontend/src/components/MessageContent.vue:54` | Añadir segmento `audio` al `SEG_RE`; reproducir vía `fetchAttachmentObjectUrl()` (`api.js:338-346`) — **no** puedes usar `<audio src="/api/attachments/:id/file">` porque el endpoint exige header `Authorization` |
| `cepi-bot/src/server.ts:1722` | Nueva rama antes de `attachMatch` para el token `[audio: …]`. **Ojo con la guarda `activePatientId` de la línea 1723**: para dictado exige episodio activo |
| `cepi-bot/src/transcribe.ts` | **Nuevo.** Llamada síncrona a Groq (compatible con la API de OpenAI). Sin worker en el escenario (i) |
| `/opt/cepi/TodoERP/backend/.env` | `UPLOAD_MAX_SIZE_MB=40` — solo hace falta si vas al escenario (iii) |

**Gotchas de plataforma:**

- **Formatos incompatibles y no negociables:** Chromium graba `audio/webm;codecs=opus`; **Safari solo escribe `audio/mp4` (AAC)** y nunca WebM. Llama siempre a `MediaRecorder.isTypeSupported()`. **Buena noticia:** Groq acepta `webm`, `mp4`, `m4a`, `ogg`, `wav`, `flac` y `mp3` directamente, así que **no necesitas ffmpeg en el VPS** — que es bueno, porque no lo hay.
- **`getUserMedia` exige contexto seguro.** Prod (`https://telemedicina.cepi.ec`) y ngrok están OK. `npm run dev` accedido por `http://<IP-LAN>:5174` **no permitirá el micrófono** — prueba por localhost o por el túnel.
- **Bugs de ciclo de vida en iOS Safari:** hay reportes de `onstop` y `ondataavailable` que no disparan (~40% de las veces en iOS 15), dejando un Blob vacío sin error. Usa `timeslice` para recibir chunks periódicos y un watchdog por timeout. **Verifica siempre `blob.size > 0` antes de subir**, y muestra un error accionable si es 0.
- **iOS suspende la captura al bloquear pantalla.** No hay grabación con pantalla apagada en web en iOS. Punto. Ver §4.4 para la consecuencia de producto.
- **PWA instalada en iOS rompe la Web Speech API** (no `MediaRecorder`, que sí funciona). Irrelevante para esta opción porque no usamos Web Speech.
- **La cola offline no cubre archivos** (§2.3). Para dictado, un reintento simple con feedback visible alcanza; para consultas largas, IndexedDB + chunking.
- **Safari re-pregunta el permiso de micrófono** de forma intermitente en SPA/PWA. Diseña la UI para que un re-prompt no destruya el estado de la grabación en curso.

**Esfuerzo:** **~2 días** para el escenario de dictado síncrono (captura + UI de grabación con medidor de nivel + reproducción + token `[audio:]` + llamada síncrona a Groq). **4-6 días** si además necesitas el worker asíncrono y el polling del escenario (iii).

---

### Opción B — Android (Capacitor 8, ya existe el wrapper)

**Cómo se captura:** **exactamente igual que la PWA**. Capacitor 8 sí maneja `getUserMedia` dentro del WebView: `BridgeWebChromeClient.onPermissionRequest` intercepta `android.webkit.resource.AUDIO_CAPTURE` y lanza el prompt de `RECORD_AUDIO`. No hace falta ningún plugin.

**Qué cambia en el repo:**

| Archivo | Cambio |
|---|---|
| `cepi-frontend/android/app/src/main/AndroidManifest.xml:34` | **BLOQUEANTE.** Hoy declara **solo** `android.permission.INTERNET`. Añadir `RECORD_AUDIO` y `MODIFY_AUDIO_SETTINGS`. El runtime request falla silenciosamente si el permiso no está en el manifest |
| `cepi-frontend/android/app/build.gradle` | Bump de `versionCode` y `versionName`. **Cuidado con la línea base:** en `HEAD` (c45153b) son `versionCode 1` / `versionName "1.0"`. El working tree tiene `2` / `"1.0.1"` **sin commitear**, junto con el bloque `signingConfigs.release` que lee `keystore.properties` — commitea ese diff antes de partir de él |
| Todo lo demás | **Cero cambios.** El código web es idéntico |

**Gotchas:**

- **El permiso del manifest es un cambio NATIVO.** El código web se puede distribuir por OTA (Capgo, `updateUrl https://telemedicina.cepi.ec/api/ota/latest`), pero el manifest no. **El primer release con audio va sí o sí por APK/Play Store**, no por OTA.
- **La Web Speech API no existe en el Android System WebView** (bug Chromium 40417848, abierto desde 2015). Si alguna vez piensas en dictado on-device sin backend, necesitas plugin nativo. Para nuestro diseño (grabar → subir → transcribir en servidor) es irrelevante.
- **Grabar en background** requiere un foreground service de tipo `microphone` + permiso `FOREGROUND_SERVICE_MICROPHONE` + **declaración en Play Console con video demostrativo**. No lo hagas en v1. Con dictados de 90 s no hace ninguna falta.
- Firma: el keystore está en `android/cepi-release.keystore` (git-ignored, válido hasta 2053). El build es 100% manual, sin CI: `npm run android:aab`, `ANDROID_HOME=$HOME/Android/Sdk`, **JDK 21 obligatorio** (con 17 falla con `invalid source release: 21`).
- Si en el futuro quieres plugin nativo, usa la familia **@capgo** (`@capgo/capacitor-audio-recorder` 8.2.6, `@capgo/capacitor-speech-recognition` 8.1.10) que declara `peer @capacitor/core >=8`. **No** uses `@capacitor-community/speech-recognition` 7.0.1 ni `capacitor-voice-recorder` 7.0.6: siguen en la línea 7.

**Esfuerzo:** **1 día** sobre la Opción A ya hecha (dos líneas de manifest + bump + build + prueba en dispositivo real). Cuesta lo mismo en cualquier escenario, así que va en el mismo release que la Opción A.

---

### Opción C — iOS (no existe, hay que crearlo)

**Estado actual:** **no hay carpeta `ios/`** en el repo. `package.json` ya tiene el script `ios:sync` pero **no tiene `@capacitor/ios` instalado**. El procedimiento está documentado en `cepi-frontend/NATIVE.md`.

**Cómo se captura:** igual que A y B (`MediaRecorder` en WKWebView). Safari graba `audio/mp4`.

**Qué hace falta:**

| Requisito | Costo / detalle |
|---|---|
| **Mac con Xcode 26+** | Hardware. No se puede generar `ios/` desde Linux |
| **Cuenta Apple Developer** | **USD 99/año**, trámite de ~1-2 semanas si es cuenta de organización (requiere D-U-N-S; los PDFs de trámite ya están en `docs/`) |
| `npm i @capacitor/ios@^8` → `npx cap add ios` | Crea `ios/`, corre `pod install`. Solo en Mac |
| `Info.plist`: `NSMicrophoneUsageDescription` | Obligatorio. El texto debe describir el uso completo ("grabamos audio para transcribir la consulta médica"), no "necesitamos el micrófono" (guideline 5.1.1(ii)) |
| CocoaPods, `platform :ios, '15.0'`, `GoogleService-Info.plist`, APNs `.p8` en Firebase | Para push |

**Gotchas:**

- **Apple guideline 2.5.14** exige consentimiento explícito **y** una indicación visual/audible clara mientras grabas.
- **Guideline 1.4.1**: las apps médicas tienen escrutinio reforzado.
- **Guideline 5.1.3**: prohíbe usar datos de salud para publicidad/marketing/data mining y **prohíbe guardar datos de salud en iCloud**.
- **Guideline 2.5.4**: declarar `UIBackgroundModes: audio` sin reproducir audio audible en background es causa de rechazo. Para *grabar* en background hay que justificarlo en revisión.
- En WKWebView el micrófono **se mutea poco después de ir a background**.
- La Web Speech API está expuesta en WKWebView pero **no funciona** (WebKit bug 239816) — tu feature-detection te mentirá. Irrelevante para nuestro diseño.

**La razón real para posponer iOS no es el trámite: es la pantalla bloqueada.** En iOS, la captura se suspende al bloquear pantalla. Con **dictado de 90 s** eso es irrelevante — el médico tiene el teléfono en la mano y Safari alcanza indefinidamente, así que **los USD 99/año no se justifican nunca por esta feature**. Con **consulta de 30 min** es bloqueante: el médico no puede guardar el teléfono, hay que forzar `Wake Lock`, la pantalla queda encendida media hora y el equipo se calienta. Si algún día haces el escenario (iii) en iPhone, necesitas app nativa; no por el App Store, sino por física.

**Esfuerzo:** **3-5 días de ingeniería** + **2-4 semanas de calendario** por el trámite de la cuenta y la primera revisión de App Store.

### 4.4 Calidad de captura: lo más barato que puedes hacer por el WER

El documento original comparaba proveedores con tres decimales y no mencionaba el micrófono. **Un lavalier de USD 15 mueve el WER más que cambiar de proveedor** (§3.1: 4 puntos de dispersión entre proveedores, 5-6 puntos entre escenarios de captura). Lo mínimo:

1. **Constraints explícitas**, porque los defaults varían por navegador:
   ```js
   audio: { echoCancellation: true, noiseSuppression: true,
            autoGainControl: false, channelCount: 1, sampleRate: 16000 }
   ```
   Para **dictado** cercano, `autoGainControl: false` evita que el AGC bombee el ruido de fondo entre frases. Para **consulta a distancia** (escenario iii) el AGC mal configurado destruye la voz lejana del paciente; hay que probarlo empíricamente, no asumirlo.
2. **Selección de `deviceId`** con `enumerateDevices()`, recordada por usuario. Con lavalier o auricular conectado, el default del sistema no siempre es el correcto.
3. **Medidor de nivel en vivo con `AnalyserNode`** que avise "audio muy bajo" o "clipping" **mientras grabas**. Son ~20 líneas de código y evitan el peor fallo de UX posible: descubrir después de 20 minutos que el archivo está vacío o inaudible. **Esto va en el día 1, no en el trimestre.**
4. **Prueba de micrófono al primer uso**: graba 5 s, reprodúcelos, muestra el nivel.
5. **Verificación post-grabación**: `blob.size` mínimo esperado según duración; si el ratio no cuadra, avisa antes de subir.

**Consumo de datos:** Opus a 24 kbps ≈ **10.8 MB/hora**. Irrelevante para un dictado (270 KB) y para el médico en general; relevante si el **paciente** manda notas de voz con un plan prepago de 1-3 GB. Con chunking, la política "subir solo por Wi-Fi" es trivial de implementar.

### 4.5 Resumen comparativo de plataformas

| | PWA | Android | iOS |
|---|---|---|---|
| Código de captura | `MediaRecorder` | **el mismo** | **el mismo** |
| Cambio nativo requerido | ninguno | 2 líneas de manifest | proyecto completo desde cero |
| ¿Distribuible por OTA? | sí (es la web) | **no** (manifest = APK nuevo) | no |
| Costo externo | $0 | $0 (keystore ya existe) | **$99/año + Mac** |
| Esfuerzo | ~2 días (dictado) / 4-6 (conversación) | +1 día | +3-5 días + trámite |
| Bloqueante | ninguno | `RECORD_AUDIO` ausente | no existe `ios/` |
| ¿Sirve para dictado de 90 s? | sí | sí | **sí, con Safari — no hace falta la app** |
| ¿Sirve para consulta de 30 min? | sí | sí | **no sin app nativa** (pantalla bloqueada) |

---

## 5. Cómo llena la IA la ficha

### 5.1 Arquitectura del pipeline: síncrona para dictado, asíncrona para conversación

`POST /api/bot/chat` es 100% síncrono: hace spawn del MCP (`mcpClient.ts:56`) + hasta 5 tool calls (`agent.ts:20`) + llamada al LLM, todo dentro del request. `location /api/` de nginx no declara `proxy_read_timeout` → **60 s por defecto**; `/api/bot/` sí tiene 120 s.

**Escenario (i), dictado — flujo síncrono, sin worker:**

```
1. Front graba 90 s → uploadAttachment(blob)                [api.js:352-366]
2. Front manda "[audio: nota.webm · <uuid>]" al chat        [IntakeChat.vue:560, adaptado]
3. Bot lee el archivo, llama a Groq (2-3 s), obtiene texto  [transcribe.ts, nuevo]
4. Responde en el mismo request con el transcript
5. (Fase 2) El LLM extrae campos y se abre un FORMULARIO
   PRELLENADO, no se escribe nada                           [fichaGroupFormFilled, flowV1.ts:401-421]
6. El médico revisa, corrige y pulsa Guardar → ahí se persiste
```

Un dictado de 90 s en Groq turbo tarda ~2-3 s. Con el LLM de extracción encima, el round-trip completo queda en 8-15 s: **cabe holgado en los 120 s de `/api/bot/`**. Aun así, pon un timeout duro de 45 s del lado del bot y degradación explícita ("no pude transcribir, reintenta" con el audio ya guardado como attachment), porque el request es del usuario y no puedes dejarlo colgado.

**Escenario (iii), conversación — obligatoriamente asíncrono.** Ninguna transcripción de más de 1-2 min de audio cabe en un round-trip. El patrón a copiar ya está escrito y probado en el repo:

```
3'. Bot crea entidad `consultation_audio` con
    transcription_status='pending' y responde INMEDIATO     [server.ts, rama nueva]
4'. Worker setInterval hace SELECT ... WHERE status='pending'
    → llama al ASR → UPDATE status='done'
    [tickClinicalImageProcessor en clinicalImageProcessor.ts:110-131;
     el setInterval está en startClinicalImageProcessor, línea 139]
5'. Front hace polling (patrón `await_isic` de flowV1.ts:725)
```

**Nota sobre el acceso al binario:** no existe tool MCP para leer bytes de un attachment (`TodoERP/mcp/src/tools.ts:234-246` solo tiene `attachments.list` y `attachments.delete`). El patrón correcto es el de `cepi-bot/src/imageInspect.ts:34-49`: construir la URL autenticada `${mcp.apiUrl}/api/attachments/<id>/file` con `Bearer ${mcp.jwt}` y pasársela al servicio que descarga. Si el ASR corre desde el worker de TodoERP, este lee el archivo del disco directamente (`UPLOAD_DIR=/opt/cepi/uploads`) y lo sube — más simple.

### 5.2 Dónde guardar el transcript, y por cuánto tiempo

**No lo metas en `session.turns`.** El history completo se re-envía al LLM en cada `llm.step()` (`llmDeepSeek.ts:57`), así que un transcript de 20 min se paga de nuevo en cada turno siguiente. En el chat va solo el resumen o un marcador.

**Y no lo dejes permanente en el episodio.** La primera versión de este documento proponía un campo `transcript` permanente con `pii:true` **y** borrado del audio a los 14 días. Eso es el peor de los dos mundos: te quedas con el texto sensible para siempre y sin la fuente para verificarlo. Peor: si el médico corrige la ficha pero no el transcript, el expediente contiene **dos versiones contradictorias de la misma consulta**, y la contradictoria es la que nadie revisó.

**Decisión: el transcript no es expediente.** Es un artefacto temporal con el mismo TTL que el audio (14 días). Lo único que persiste es **la ficha firmada**. Es el patrón de Abridge (*"las transcripciones no forman parte del expediente permanente"*) y simplifica retención, PII y contradicción de un solo golpe.

Implementación:

1. **Entidad propia `consultation_audio`** con `audio_attachment_id`, `transcript` (textarea), `transcription_status`, `episode_id`, `created_at`, `expires_at`. `syncColumnsForEntity()` en `TodoERP/backend/src/services/columnSyncService.ts` materializa cada campo escalar como columna real; `reconcileColumnsOnStartup()` (línea 486) crea la columna al bootear. Cero migración manual.
2. **Márcala `pii: true`.** Hoy **ningún campo del episodio tiene `pii:true`** — todos están en Paciente (`001_medical_definitions.sql:34-60`). Un transcript contiene nombres, cédulas y teléfonos dichos en voz alta. Marcarlo activa la capa R4 (`TodoERP/backend/src/services/entities/redact.ts`, requiere `pii:read:<slug>`) y hay que añadir su clave a `PII_KEYS` en `cepi-bot/src/redact.ts:10-15`.
3. **Un job de borrado** que elimine audio + transcript a los 14 días, en cascada, y que también cubra los chunks si existen.

**Edición del transcript.** Decisión explícita para v1: **el médico no edita el transcript**. Edita la ficha, que es lo que cuenta. Si corrige algo que el ASR entendió mal, la corrección vive en el campo de la ficha, y el par `(transcript, patch_guardado)` es exactamente el corpus que necesitas para §5.7. Permitir editar el transcript agregaría preguntas sin respuesta (¿se guarda el original?, ¿el diff?, ¿quién editó?) a cambio de poco valor: nadie relee un transcript que ya volcó a la ficha.

**Asocia la grabación al `episode_id` al INICIAR, no al terminar.** Si el médico cierra la app a mitad, el audio queda huérfano y sin trazabilidad de a qué consulta pertenece — y un audio clínico huérfano es lo peor que puedes tener desde el punto de vista de LOPDP.

### 5.3 Campos reales del episodio que la IA debe llenar

Entidad `episode`, id `12000000-0000-0000-0000-000000000000`, tabla `entity_episode`, definida en `/mnt/sda1/cepi/TodoERP/database/medical-seed/001_medical_definitions.sql:67-177`. Los grupos de ficha viven en `cepi-bot/src/flowV1.ts:149-255` (`FICHA_FIELD_DEFS`) y `:263-291` (`FICHA_GROUP_SPEC`).

**Extraer (alta confianza — narrativa dictada):**

| Grupo | Campos | Tipo |
|---|---|---|
| `g_3_1` | `motivo_consulta` (e005), `anamnesis` (e006) | textarea |
| `g_3_2` | `tiempo_evolucion` (e052) | text |
| `g_3_3` | `curso` (e053) | select `[progresivo, regresivo, continuo, intermitente]` |
| `g_3_4` | `sintomas_presente` (e054) | **boolean** |
| `g_3_4` | `picor` (e055), `dolor` (e056) | select `[leve, moderado, severo]` |
| `g_3_5` | `causa_aparente_presente` (e057, **boolean**), `causa_aparente` (e058, text) | mixto |
| `g_3_6` | `patologia_asociada_presente` (e059, **boolean**), `patologia_asociada` (e060, text) | mixto |
| `g_3_7` | `tratamientos_previos_presente` (e061, **boolean**), `tratamientos_previos` (e062, text) | mixto |

La distinción boolean/select no es cosmética: determina si el campo cae en `BOOL_FIELDS` o en `SELECT_OPTIONS` al pasar por `coercePatch()` (§5.4). `e054 sintomas_presente` es **boolean**, no un select de intensidad.

**Extraer (examen dictado en voz alta — confianza media):**

| Grupo | Campos |
|---|---|
| `g_4_1` | `lesion_macula`, `lesion_papula`, `lesion_placa`, `lesion_vesicula`, `lesion_ampolla`, `lesion_tumor`, `lesion_nodulo`, `lesion_ulcera` (e070-e077, bool), `lesion_otra` (e078, text) |
| `g_4_2` | `caract_eritema`, `caract_descamacion`, `caract_exudacion`, `caract_liquenificacion`, `caract_otra` (e080-e084) |
| `g_4_3` | `topo_unica`, `topo_bilateral`, `topo_confluente`, `topo_circular`, `topo_borde`, `topo_multiples`, `topo_simetrico`, `topo_agrupadas`, `topo_lineal` (e090-e098, bool), `topo_otra` (e099) |
| `g_4_4` | `gravedad_extension`, `gravedad_intensidad`, `gravedad_funcionalidad` (e110-e112, number 0-3) |
| `g_4_5` | `patron_inflam_epidermica`, `patron_inflam_dermica`, `patron_necrosis`, `patron_tumor`, `patron_color` (e120-e124), `notas_examen` (e130) |
| `g_4_6` | `regiones_afectadas` (e162, CSV del body map) |

**Extraer (cierre):**

| Grupo | Campos |
|---|---|
| `g_5` | `diagnostico` (e160), `diagnostico_letra` (e161) — select `[A, B, C]` |
| `g_6` | `estudios_complementarios_presente` (e140), `estudios_complementarios_resumen` (e141) |
| `g_7` | `tratamiento_resumen` (e150), `plan` (e012), `proximo_control_fecha` (e014), `proximo_control_motivo` (e015) |

**Del paciente, si el médico los menciona** (`target: 'patient'`): `g_2_1` `antecedentes_personales_presente` + `antecedentes_personales`; `g_2_2` `antecedentes_familiares_presente` + `antecedentes_familiares`; `ocupacion`.

**NUNCA extraer:**

| Campo | Razón |
|---|---|
| `blink_benigna`, `blink_lonely`, `blink_irregular`, `blink_nervios_cambios`, `blink_known_clues` (e170-e174) | Es un cuestionario dirigido al médico, no al paciente |
| `blink_total` (e175), `blink_resultado` (e176) | **Autocalculados** en `flowV1.ts:1008-1018` |
| `gravedad_total` (e113) | **Autocalculado** en `flowV1.ts:993-1000` |
| `imagenes_lesion`, `imagen_consentimiento` | Son CSV de attachment ids; `flowV1.ts:546` los filtra para que no se escriban como columnas |
| `responsable_actual_id`…`medico_primario_id` (e200-e208) | Telemedicina, no clínico |
| `estado` (e020), `fecha` (e003), `medico_id` (e002) | Los pone el sistema |

### 5.4 Coerción obligatoria

Los valores en lenguaje natural rompen los `CHECK` de Postgres (el LLM produce "hombre", "negro", "severa"). **La solución ya existe**: `coerceFichaValue(key, value)` y `coercePatch(data)` en `cepi-bot/src/flowV1.ts:343-378`, con `SELECT_OPTIONS` + `BOOL_FIELDS` derivados de la ficha y un diccionario `SYNONYMS` (`:322-339`). Los valores no mapeables **se descartan en vez de fallar el guardado**. `agent.ts:92-96` ya lo aplica a todo `entities.update`/`create` que emita el LLM. **Cualquier pipeline de transcript debe pasar por ahí.**

Añade una consecuencia medible: **cuenta y registra los valores descartados por `coercePatch()`**. Un valor descartado silenciosamente es un campo que el médico creerá que dictó y que no quedó en la ficha. Es un modo de fallo invisible que solo se detecta si lo instrumentas.

### 5.5 Patrón de confirmación humana — el punto no negociable

El `confirmation gate` del proyecto (PAPER §13.3.1, D-Aux-1) existe pero **está apagado**: `cepi-bot/src/server.ts:309` → `const CONFIRM_GATE_ENABLED = process.env.CEPI_CONFIRM_GATE === '1'`, y esa variable no está en `ecosystem.config.cjs`. Las escrituras inferidas se ejecutan de inmediato.

**Para transcript → ficha, el gate sí/no no es suficiente.** Un "¿confirmas?" sobre 25 campos extraídos es una pregunta que nadie puede responder con criterio. El patrón correcto, y que además ya está implementado en el repo:

> **La extracción abre un formulario `ficha_grp_*` PRELLENADO, no un `pending_action`.**

- `fichaGroupFormFilled()` en `flowV1.ts:401-421` ya sabe prellenar un grupo leyendo la entidad destino. Se extiende para prellenar desde el patch propuesto por el LLM.
- El médico ve los campos con los valores propuestos, edita lo que esté mal, y pulsa Guardar.
- El submit del formulario **ya está exento del gate por diseño** (`flowV1.ts:610-613`, y `CLAUDE.md` lo documenta): *"los envíos de formularios de la ficha ya son una acción explícita del usuario"*.
- Esto convierte la revisión en un acto real en vez de un tap de "sí".

**La regla "solo por formulario" hay que imponerla en código, no por prompt.** Hay una contradicción real y explotable: con `CONFIRM_GATE_ENABLED = false`, el LLM **igual puede escribir la ficha directo** vía `entities.update`, que `agent.ts:88-96` ejecuta sin confirmación alguna (solo le pasa `coercePatch`). Meter un transcript de 20 min —o incluso de 2— en el prompt aumenta muchísimo la superficie para un `entities.update` espontáneo que nadie revisa. Mitigación obligatoria antes de encender la extracción:

- **Bloquear `entities.update` sobre `entity_definition = episode` en la rama de transcripción**, en el bucle de `agent.ts`, no en el prompt de sistema. Un prompt no es un control de acceso.
- Registrar cada intento bloqueado. Si el LLM insiste, es señal de que el prompt de extracción está mal encuadrado.

**Requisitos de UI encima de eso:**

1. **Estado borrador explícito.** La nota nunca entra al expediente sin firma. Es el patrón universal (Nuance DAX: *"the clinician edits and signs off"*; Abridge: *"the clinician always reviews and approves"*).
2. **Resaltar visualmente los campos de mayor riesgo**: medicación, dosis, alergias, examen físico, números. La evidencia dice que **los errores de medicación son los más frecuentes** en scribes ambientales, y hay casos documentados de **exámenes físicos completos alucinados que nunca ocurrieron**.
3. **Marcar los campos sin anclaje en la transcripción** con un color distinto, y **no prellenar** los que vengan de segmentos con `confidence` bajo (§7.4). Un borrador pulido y bien formateado es *más* peligroso que uno visiblemente crudo (automation bias).
4. **Anclaje texto↔audio** mientras el audio exista: click en el campo → salta al segmento. Convierte la revisión de un acto de fe en una verificación. Groq devuelve `timestamp_granularities` a nivel de palabra y segmento con `response_format=verbose_json`, así que el dato para anclar es gratis desde el día 1 — guárdalo aunque la UI llegue después.
5. **Auditoría**: quién revisó, cuánto tiempo, qué editó. `executePendingActionResult` (`server.ts:321-446`) ya deja nota de chatter `🤖 Acción ejecutada por el agente` — reusar ese mecanismo.

### 5.6 PII antes de mandar el transcript al LLM

**Aquí hay un hueco real.** La redacción actual (`cepi-bot/src/redact.ts`) tiene dos limitaciones que la hacen inútil para un transcript:

1. Es **key-based sobre JSON**: `PII_KEYS` (`:10-15`) tapa el *valor* de claves como `nombre`, `cedula`, `telefono`. Un transcript es texto libre — no hay ninguna clave que tapar. `redactPiiInJson()` hace `JSON.parse` → falla → **devuelve el string intacto** (`:42-48`).
2. Solo se aplica a turnos `role:'tool'` (`agent.ts:68-70`). Un transcript llegaría como `role:'user'` y **va literal al prompt de DeepSeek**.

Esto es intencional según PAPER §18 D-4 ("PII inbound permitida, PII outbound prohibida"), pero **un dictado es un salto de escala frente a un mensaje tecleado**, y una conversación de 20 minutos lo es aún más.

**Mitigación mínima antes de lanzar** — un `redactTranscript(text)` nuevo con:

- Regex de cédula ecuatoriana (10 dígitos con dígito verificador módulo 10).
- Regex de teléfono EC (`09\d{8}`, `0[2-7]\d{7}`, `+593…`).
- Regex de email.
- Sustitución de los valores conocidos del paciente activo (nombre, apellidos, cédula ya están en la entidad `patient`) por `<PACIENTE>` antes de mandar al LLM, y sustitución inversa al recibir el patch.

NER de nombres genéricos es deseable pero no bloqueante para v1 si haces la sustitución por valores conocidos. **Esto no existe en ningún archivo del repo hoy.** El dictado reduce el problema (el médico no suele recitar la cédula del paciente en voz alta) pero no lo elimina.

### 5.7 Cómo se mide si la ficha autollenada es correcta

Este es el hueco más grave del documento original después del encuadre del escenario. **WER no es la métrica del producto.** Un WER de 7% con 100% de aciertos en `motivo_consulta` y 40% de error en dosis es un producto peligroso con una buena métrica.

Lo bueno: **se puede instrumentar gratis**, porque el formulario prellenado ya captura el antes y el después. Lo urgente: **hay que persistir el par `patch_propuesto` / `patch_guardado` desde el día 1**, aunque la extracción todavía no esté encendida. El corpus de correcciones es irrecuperable a posteriori.

| Métrica | Definición | Meta inicial |
|---|---|---|
| **Precisión por campo** | Campos propuestos que el médico dejó intactos / campos propuestos | ≥80% global |
| **Tasa de alucinación** | Campos propuestos que el médico **borró** (valor a vacío) / campos propuestos | <2% global, **0% en medicación** |
| **Tasa de omisión** | Campos que el médico llenó a mano y el modelo no propuso / campos llenados | <25% |
| **Edit distance** | Distancia de Levenshtein normalizada en campos libres (`anamnesis`, `motivo_consulta`) | <0.3 |
| **Tiempo de revisión** | Apertura del formulario → submit | **< tiempo de llenado manual** |
| **Descartes de `coercePatch`** | Valores propuestos que la coerción tiró | monitorear, sin meta |

Reglas de medición:

- **Estratifica por criticidad, siempre.** Reporta `medicación / diagnóstico / examen físico` aparte del agregado. Un 90% global no dice nada si el 10% restante son dosis.
- **"Editado sí/no" no alcanza** en campos libres. Un médico que reescribe media anamnesis y otro que corrige una tilde cuentan igual en un booleano.
- **Ground truth por doble llenado ciego** en 20-30 consultas del piloto: el médico llena la ficha a mano *sin ver* la propuesta, y después se comparan. Sin esto solo mides "¿el médico aceptó?", contaminado exactamente por el automation bias que describe §5.5.3.
- **Criterio de apagado definido de antemano.** Por ejemplo: *si menos del 60% de los campos prellenados sobreviven sin edición, o si aparece una sola alucinación en medicación, se apaga la extracción y queda solo el transcript.* Escríbelo antes de encender, no después de la primera queja.

### 5.8 Modos de fallo del pipeline

El documento original no describía **ni un solo modo de fallo** del worker. Mínimo exigible antes de producción, tanto en la vía síncrona como en la asíncrona:

| Fallo | Mitigación |
|---|---|
| El ASR devuelve 5xx o timeout | Backoff exponencial, **máximo 3 reintentos**, luego `status='failed'` con mensaje visible al médico y el audio intacto |
| Reintento duplicado | **Idempotencia por `sha256` del archivo** (el backend ya renombra a `<sha256><ext>`, así que la clave existe). Sin esto, un audio reintentado se paga dos veces y puede duplicar el patch |
| Job atascado en `pending` | Timeout duro (5 min) → `failed`. Dead-letter con alerta |
| Audio vacío o inaudible | Verificación de `blob.size` en el cliente + duración mínima; si el transcript vuelve con <10 palabras para 5 min de audio, marcar como sospechoso y **no extraer** |
| Grabación truncada | `recording_session.total_chunks` vs chunks recibidos (§2.3). Nunca extraigas de una sesión no cerrada |
| El LLM devuelve JSON inválido | Un reintento con el error en el prompt; si falla, mostrar el transcript sin extracción. Nunca fallar en silencio |
| El médico cierra la app a mitad | La grabación ya está asociada al `episode_id` desde el inicio (§5.2); al reabrir, ofrecer retomar |
| Borrado / ARCO | Supresión en cascada sobre audio, chunks, transcript y `recording_session`, no solo sobre la fila principal. §7.5 cita el régimen sancionatorio; esto es operativizarlo |

### 5.9 Gobernanza

`docs/PAPER.md:1091` tiene la decisión **D-6 cerrada: "Grabaciones de voz si se agrega dictado → No en v1."** Por la regla paper-first de `CLAUDE.md`, **habilitar audio exige reabrir y actualizar esa decisión en el paper antes de tocar código.** La actualización debe declarar explícitamente **cuál de los tres escenarios de §2.1** queda habilitado; abrir D-6 "para audio" en general es abrir la puerta a que alguien implemente el escenario (iii) sin el trabajo legal de §7.

---

## 6. Recomendación escalonada

### Semana 1 (~2 días) — Dictado del médico, transcripción síncrona, sin extracción

**Elige: PWA + Groq `whisper-large-v3-turbo`, síncrono, un hablante, sin diarización.**

Por qué Groq y no AssemblyAI para este paso: la API es compatible con la de OpenAI y **síncrona**, acepta `webm`/`mp4` directamente (no necesitas el ffmpeg que el VPS no tiene), un dictado de 90 s vuelve en 2-3 s, y cuesta $0.04/h. Eso elimina el worker asíncrono, el estado `pending`, el polling del front y todo el patrón `await_isic`: **4-6 días de ingeniería que no se escriben**. Y la compatibilidad con la API de OpenAI significa que migrar a `speaches` self-hosted más adelante es un cambio de `base_url`.

**Caveat que hay que cerrar antes de tocar audio de pacientes reales:** Groq procesa **solo en EE.UU.** y su DPA/BAA no está verificado. Si el trabajo legal de §7.3 no cierra a tiempo, el plan B es **AssemblyAI sin diarización a $0.21/h** (mismo esfuerzo de integración, BAA estándar, región EU seleccionable, latencia de ~10-20 s que aún cabe en los 120 s de `/api/bot/`). No cambia nada más del plan.

Entregable:

1. Actualizar PAPER §18 D-6, declarando que se habilita **solo** el escenario (i) de §2.1.
2. `useRecorder.js` + botón de micrófono en `IntakeChat.vue`, con **medidor de nivel `AnalyserNode`**, constraints explícitas de §4.4, indicador de grabación persistente y botón de descartar.
3. Token `[audio: … · uuid]` + rama en `server.ts` (con guarda de episodio activo, no solo paciente).
4. `transcribe.ts`: llamada síncrona a Groq con `language='es'`, `response_format='verbose_json'` (para timestamps y `confidence` por segmento) y el **`prompt` de vocabulario** — máximo 224 tokens en Groq, así que prioriza: fármacos dermatológicos frecuentes en Ecuador, términos derma, nombres de la clínica. **Esto es la mayor palanca de WER local y es gratis: va en la semana 1, no en el trimestre.**
5. Reproducción del audio en `MessageContent.vue`.
6. El transcript se muestra en el chat y se guarda en `consultation_audio` (`pii:true`) con `expires_at` a 14 días. **Nada se escribe en la ficha todavía.**
7. **Persistir `patch_propuesto` desde ya**, aunque no se use, y el esqueleto de la tabla de métricas de §5.7.
8. Consentimiento mínimo: aviso al médico de que está grabando su propia voz con datos del paciente, y política de retención visible.

**Esta semana ya entrega valor real:** el médico dicta, obtiene el texto, y lo copia a mano donde quiera. Y te da el corpus para el paso siguiente.

### Semanas 2-3 — Extracción a formulario prellenado + Android

Aquí está todo el valor y todo el riesgo.

1. **Extracción.** Prompt de sistema nuevo (override por `CEPI_AGENT_SYSTEM`, o extender `DEFAULT_SYSTEM_PROMPT` en `llmDeepSeek.ts:16-35`, que ya tiene una sección "Captura de datos por TEXTO LIBRE") que emita un patch JSON con las claves de §5.3. Pasar por `coercePatch()` sí o sí.
2. **`fichaGroupFormFilled` prellenado desde el patch**, con resaltado de campos de riesgo y marcado de baja confianza.
3. **Bloqueo en código de `entities.update` sobre `episode`** fuera del formulario (§5.5). No negociable.
4. **Instrumentación completa de §5.7**, incluido el doble llenado ciego en 20-30 consultas y el criterio de apagado escrito.
5. **`redactTranscript()`** con regex de cédula/teléfono/email + sustitución de valores conocidos del paciente.
6. **Modos de fallo de §5.8**: backoff, límite de reintentos, idempotencia por sha256, timeout duro.
7. **Android**: dos líneas en `AndroidManifest.xml`, bump de `versionCode` (partiendo de `1`/`1.0` de `HEAD`, no del working tree sin commitear), build del AAB firmado. **1 día**, y cuesta lo mismo en cualquier escenario.

### Mes 2 — Consolidación y decisión

1. **Lee las métricas.** Si la precisión por campo no llega a 80%, o si el tiempo de revisión no baja del tiempo de llenado manual, el problema no es el proveedor de ASR: es el prompt de extracción o la hipótesis de producto. Aplica el criterio de apagado.
2. **Anclaje texto↔audio** en el formulario de revisión, mientras el audio exista.
3. **Dataset de correcciones**: el par `patch_propuesto`/`patch_guardado` ya se está guardando desde la semana 1. Es la palanca de mayor retorno (en dictado médico griego, Whisper large-v2 bajó de 26.41% a 14.90% WER con fine-tuning). **Ojo con §7.5: usar transcripciones anonimizadas para entrenar requiere autorización previa de la SPDP.**
4. **Benchmark propio, solo si las métricas apuntan al ASR.** Graba 10-15 dictados reales con acento quiteño/guayaquileño, transcríbelos a mano como ground truth, y corre Groq turbo vs Groq large-v3 vs AssemblyAI vs Speechmatics. Presupuesta 1-2 días. **Nadie publica WER de español ecuatoriano.**

### Mes 3 en adelante — Conversación completa, **solo si el piloto lo pide**

Si y solo si el piloto demuestra que el médico pierde información entre la consulta y la ficha (y no simplemente que no quiere tipear):

1. Reabrir D-6 en el paper para habilitar el escenario (iii).
2. **Consentimiento por sesión** montado sobre la entidad `consent` existente, con las modificaciones de §7.1.
3. **Chunking resiliente** + IndexedDB + `recording_session` + `navigator.storage.persist()` (§2.3).
4. **`ffmpeg` en el VPS** si vas a concatenar server-side.
5. **Worker asíncrono** + polling (`await_isic`).
6. **Proveedor con diarización**: bake-off entre **Speechmatics Medical español** (mejor WER publicado en el escenario correcto, con diarización clinician/patient/family entrenada, y opción on-prem — pide el precio, no es público) y **AssemblyAI** (BAA estándar, SDK TS, $0.23/h). Azure batch entra si la respuesta a §8.3 es "el audio no sale de Sudamérica".
7. **Identidad de hablante, no solo diarización** (§7.4).
8. **iOS solo si hay demanda medida** *y* estás en el escenario (iii): con dictado, Safari alcanza indefinidamente.
9. **Reevaluar self-host** solo si el volumen supera ~500 h/mes *y* aparece un requisito de soberanía. Entonces: VPS de 4 vCPU dedicadas / 8 GB + `speaches` (Docker, API compatible con OpenAI) + `faster-whisper small int8` + VAD, o el on-prem de Speechmatics.

---

## 7. Riesgos y requisitos legales

Esta sección aplica **entera** al escenario (iii). Al escenario (i), el dictado, le aplican §7.2, §7.3, §7.4 y §7.5, y de §7.1 solo la parte de LOPDP — no la penal.

### 7.1 Consentimiento — el riesgo más subestimado

**COIP Art. 178 (Violación a la intimidad)**: *"La persona que, sin contar con el consentimiento o la autorización legal, acceda, intercepte, examine, retenga, **grabe**, reproduzca, difunda o publique datos personales, mensajes de datos, **voz, audio y vídeo** … de otra persona por cualquier medio, será sancionada con pena privativa de libertad de **uno a tres años**."*

**Matiz que la primera versión de este documento omitió, y que cambia el encuadre del riesgo:** el mismo artículo continúa con una excepción — *"No son aplicables estas normas para la persona que divulgue grabaciones de audio y vídeo en las que interviene personalmente, ni cuando se trata de información pública…"*. Como **el médico es participante de la consulta**, la excepción es directamente relevante. Afirmar sin más que grabar la consulta *"es potencialmente un delito"* sobredimensiona el riesgo penal.

Lo que **no** cambia: el riesgo LOPDP sigue intacto y es el que importa. Y con **dictado del médico solo**, el riesgo penal desaparece por completo — no hay voz de terceros grabada.

**LOPDP Art. 26.a**: los datos sensibles requieren *consentimiento explícito … especificándose claramente sus fines*. Art. 8: libre, específico, informado e inequívoco, y **la revocación debe tener un procedimiento tan sencillo como el otorgamiento**. Si consiente con un tap, se revoca con un tap.

**Norma Técnica de Telesalud (AM 00044-2025, RO 153 II Sup., 28-X-2025) §7.2.2** exige **dos consentimientos documentados y guardados en el registro de salud**: primero autorización para el uso de medios telemáticos, luego consentimiento para el tratamiento de datos personales y sensibles, *"que se integrará en el flujo de trabajo del servicio"*. Es una especificación de UX escrita en el Registro Oficial.

**El consentimiento como máquina de estados, no como checkbox.** Lo que falta diseñar no es el texto legal sino el camino de producto:

```
no_preguntado ──→ consentido ──→ revocado_a_mitad
      │                │
      ↓                ↓
  rechazado        completado
```

- **El default es NO grabar.** El llenado manual tiene que seguir siendo un camino de primera clase, no un castigo.
- **`rechazado`**: la app sigue funcionando igual, sin fricción ni recordatorios. Un flujo que insiste convierte el consentimiento en no-libre y lo invalida (Art. 8).
- **`revocado_a_mitad`**: revocar significa **borrar lo grabado hasta ahí**, no solo dejar de grabar. Es lo que exige el Art. 8, y es un requisito de implementación, no una política.
- **Acompañante que no consiente mientras el paciente sí**: la única salida real es **no grabar**. No hay forma de excluir selectivamente una voz de un micrófono ambiental. Escríbelo en el flujo y no pretendas resolverlo con tecnología.

**Ya existe una entidad `consent` en el repo** (`TodoERP/database/medical-seed/001_medical_definitions.sql:256-266`, id `18000000-0000-0000-0000-000000000000`). Úsala en vez de inventar "guardar en el registro del paciente". Lo que le falta:

| Campo actual | Problema | Cambio necesario |
|---|---|---|
| `c002 tipo` — options `["lopdp","imagen_clinica","investigacion","cirugia"]` | No cubre el caso | Añadir `"grabacion_audio"` y `"telemedicina"` — la Norma §7.2.2 exige **dos** consentimientos distintos |
| `c004 firmado_at` — `type: "date"` | **Un `date` no sirve para estampar evidencia por sesión** | Pasar a timestamp |
| `c006 revocado_at` — `type: "date"` | Idem, y la revocación necesita hora exacta para saber qué borrar | Pasar a timestamp |
| `c001` cuelga solo de `patient_id` | No se puede auditar el consentimiento verbal contra la consulta concreta | Añadir `episode_id` (relationship, opcional) |
| — | No hay registro de quién tomó el consentimiento | Añadir `tomado_por_user_id` |

**Diseño requerido (escenario iii):**

1. Consentimiento amplio por escrito la primera vez (grabación + transcripción con IA + identidad del encargado y país + plazo de conservación + derecho a revocar).
2. Consentimiento verbal **por sesión**, con la app mostrando el guion al médico y un botón que estampa evidencia (timestamp + usuario + episodio) en la entidad `consent`.
3. Indicador de grabación **persistente y visible** + botón de pausa de un tap.
4. "Descartar esta grabación" visible durante y después, que borra de verdad.
5. El guion debe cubrir a **acompañantes/familiares** presentes — su voz también se graba y bajo COIP 178 también son "otra persona", y respecto de ellos el médico participante no tiene la excepción que sí lo cubre a él.

**Lección de litigio ajeno:** en EE.UU. hay una ola de demandas colectivas 2025-2026 contra Sharp HealthCare, Sutter Health y MemorialCare por scribes ambientales (Washington et al v. Sutter Health, N.D. Cal., 8-IV-2026), por grabar sin consentimiento de todas las partes. **Todos esos sistemas tenían BAA firmado con Abridge.** El consentimiento es un problema de producto, no de contrato. Ninguna de esas demandas habría existido con dictado del médico.

### 7.2 Retención del audio

**No hay respuesta perfecta.** Guardarlo te expone; borrarlo te deja ciego ante alucinaciones — la investigación de AP criticó a Nabla precisamente porque borra el audio y eso hace imposible contrastar la transcripción contra la fuente, perjudicando especialmente a pacientes sordos.

Lo que hace el mercado:

- **Nabla y Heidi**: no guardan audio en absoluto (*"No audio is ever kept"*). **Ojo: el default de retención de transcripciones de Heidi es "never delete"** — los defaults de los vendors no están alineados con minimización.
- **Abridge**: audio y transcripción borrados a los 30 días (Kaiser Permanente declaró 14). Las transcripciones **no** forman parte del expediente permanente.
- **Suki**: 30 días para audio y transcripción; la nota final se retiene por la duración del contrato.

**Recomendación: ventana de 14 días para audio *y* transcript, borrado automático irrevocable, con la nota firmable dentro de esa ventana.** Retención distinta y más larga solo para la ficha, que sí es expediente. Que audio y transcript compartan TTL evita el peor de los dos mundos descrito en §5.2.

**Para el escenario (i), dictado, considera un TTL aún más corto o cero.** Si el audio es solo la voz del médico dictando y la ficha ya quedó firmada, conservarlo aporta poco: no hay voz de paciente que preservar como evidencia. Borrarlo al transcribir es defendible y elimina de un golpe media docena de obligaciones. El único argumento para conservarlo unos días es el anclaje texto↔audio de §5.5.4 durante la revisión.

**Consecuencia si el audio se considera parte del expediente:** hereda la tabla del MSP — **15 años** (Hospital de Especialidades/General) o **10 años** (Centro de Salud/Subcentro). Guardar 15 años de audio crudo es una superficie de riesgo y un costo de almacenamiento enormes. La Norma de Telesalud sí reconoce *"videos, audios y textos en los expedientes"*, así que el diseño defensivo es **no vincular el audio al expediente**.

**Los backups son parte de la política de retención.** Si el audio se borra a los 14 días de `/opt/cepi/uploads` pero vive 6 meses en un backup sin cifrar, la política es ficción y el incumplimiento es constatable. Define el TTL del backup y su cifrado en la misma decisión.

**LOPDP Art. 12.4 y Art. 51.9**: tienes que **informar al titular el tiempo de conservación y declararlo en el Registro Nacional**. Decide y publica la política de retención **antes** de lanzar — es la clase de incumplimiento que la SPDP puede constatar sin investigar nada.

### 7.3 Transferencia internacional

**LOPDP Art. 34**: *"No se considerará transferencia o comunicación en el caso de que el encargado acceda a datos personales para la prestación de un servicio al responsable."* Reforzado por la Norma SPDP-SPD-2026-0004-R Art. 23: *"el encargo de tratamiento **no constituye una transferencia** ni comunicación de datos personales."*

**Lectura (defendible, no certeza — sin verificar con pronunciamiento de la SPDP):** contratar a un proveedor de ASR **como encargado** probablemente evita todo el régimen de transferencia internacional. Esto difiere del GDPR.

**Ruta conservadora, que es la que recomiendo:**

1. Contrato de encargo con las cláusulas del Art. 34 (finalidad limitada, prohibición de subencargo no autorizado, destrucción/devolución al fin del contrato).
2. **Exige lista de subprocesadores.** El Art. 34 prohíbe literalmente que el encargado comunique los datos *"ni siquiera para su conservación a otras personas"* — y todo proveedor de ASR usa AWS/GCP por debajo.
3. **Exige "no entrenamiento con tus datos" por escrito.** Es la cláusula que más se olvida y la que más importa con proveedores de modelos.
4. Cláusulas tipo RIPD como refuerzo (el Art. 24 lo llama buena práctica).
5. Consentimiento explícito informado del riesgo (Art. 60.2 LOPDP).
6. Declararlo en el Registro Nacional (Art. 51.5 exige identificar destinatarios **incluyendo encargados**).

**Aplicado a Groq**, que es el proveedor de la semana 1: procesa **solo en EE.UU.**, y su DPA/BAA **no está verificado**. Antes de mandarle audio de pacientes reales hay que conseguir el DPA firmado con las cláusulas de arriba. Si no aparece en un plazo razonable, el plan B es AssemblyAI (BAA estándar, región EU seleccionable) al mismo esfuerzo de integración.

**No intentes la vía de "garantías adecuadas"**: el Art. 21.6 de la norma exige que el destinatario *"acepte y se someta voluntariamente a la jurisdicción … de los jueces, tribunales y cortes ecuatorianos"*. Ningún proveedor estadounidense firma eso.

**Si el requisito es soberanía estricta**, las opciones con procesamiento en Sudamérica son **Azure (Brazil South, Chile Central, Mexico Central)** y **AWS (sa-east-1 São Paulo)**; la opción de soberanía total es el **on-prem de Speechmatics**. Ningún proveedor cloud procesa en Ecuador.

**Sanciones:** 0.7%-1% del **volumen de negocio** (facturación menos IVA, no utilidad) por infracción grave. El régimen ya no es teórico: a **principios de diciembre de 2025** la SPDP multó a LIGAPRO con USD 259.644,01 y a la FEF con USD 194.856,16 por consentimiento inválidamente obtenido, **con orden de borrar los datos** — la medida correctiva es peor que la multa.

**Notificación de brecha: 5 días de término a la SPDP y también a ARCOTEL** (Art. 43). Mucha gente olvida ARCOTEL. El encargado tiene 2 días para avisarte — ponlo en el DPA.

**Trampa contraintuitiva:** LOPDP Art. 31.3 — *"Todo tratamiento de datos de salud **anonimizados** deberá ser **autorizado previamente** por la Autoridad"*, con protocolo técnico + informe de la Autoridad Sanitaria. **Anonimizar no te libera, te mete en un trámite.** Esto impacta directamente el punto de fine-tuning del Mes 2: usar transcripciones anonimizadas para evaluar o entrenar modelos requiere ir a la SPDP antes.

### 7.4 Alucinación, equidad e idioma

**Evidencia publicada, no hipótesis** (Koenecke et al., *"Careless Whisper: Speech-to-Text Hallucination Harms"*, ACM FAccT '24):

- **~1% de las transcripciones** contenían frases u oraciones **completamente alucinadas** que no existían en el audio.
- **38% de esas alucinaciones incluían daños explícitos**.
- Whisper alucina **más** con hablantes que tienen pausas largas — **personas con afasia y trastornos del habla**. Es un problema de equidad, no solo de calidad: el modelo falla más justo en los pacientes más vulnerables.
- Los autores advierten explícitamente sobre el uso en **notas de pacientes en entornos médicos**.

En scribes ambientales completos (ASR + LLM), los estudios 2025-2026 reportan 1-3% de tasa de error, con **los errores de medicación como los más frecuentes** (comisión y omisión, en todas las plataformas) y el **examen físico como el área de mayor riesgo**.

**Idioma mezclado y kichwa — decisión explícita, no un renglón.** Ningún proveedor de la matriz de §3 soporta kichwa. Las consecuencias hay que decidirlas, no descubrirlas:

1. **Fija `language='es'`.** La autodetección salta de idioma a mitad de audio y produce basura peor que un error consistente.
2. Con `es` fijo, los tramos en kichwa se transcriben **fonéticamente o se alucinan**. No hay tercera opción.
3. **Usa el `confidence` por segmento** (Groq lo devuelve con `response_format=verbose_json`; AssemblyAI en `utterances[]`) con un umbral: **por debajo del umbral, no extraigas campos de ese segmento**. Márcalo en la UI como "no transcrito con confianza".
4. **Declara explícitamente que v1 no cubre consultas en kichwa**, en la documentación y en la UI. Escribirlo es mucho mejor que fallar en silencio con un paciente indígena — que es exactamente el sesgo de equidad que Koenecke documenta.

**Reglas no negociables:**

1. La nota nunca entra al expediente sin firma humana deliberada.
2. Nunca autocompletar diagnósticos, códigos o prescripciones sin confirmación explícita.
3. Resaltar medicación, dosis, alergias y examen físico para revisión forzada.
4. Advertir al médico que el ASR degrada con habla pausada — revisar con más cuidado.
5. No extraer de segmentos con confianza baja.

**Advertencia específica:** toda la evidencia publicada de alucinación es **en inglés**. No hay datos para español ecuatoriano, ni para vocabulario clínico local, ni para code-switching con kichwa. Los benchmarks de §3.1 son de conversación médica en español genérico y del propio vendedor. Por eso las métricas de producto de §5.7 —tasa de alucinación por campo, estratificada por criticidad— no son opcionales, y valen más que cualquier WER publicado.

### 7.5 Otras obligaciones activadas

- **EIPD obligatoria** (LOPDP Art. 42.b) si hay tratamiento a gran escala de categorías especiales. La Norma SPDP-SPD-2026-0005-R define un Modelo Técnico de Gran Escala: 6 variables, ≥6 puntos = gran escala. **Corre el MTGE sobre tu proyección de volumen antes de escalar.**
- **DPO obligatorio** en el mismo supuesto (Art. 48.3), con 90 días de plazo para designarlo y registrarlo.
- **Registro Nacional** con los 9 campos del Art. 51, incluyendo destinatarios y tiempo de conservación. No registrarlo o no actualizarlo es infracción grave.
- **Derechos ARCO operativizados.** Un pedido de supresión debe borrar audio, chunks, transcript, `recording_session` y backups dentro del plazo legal. Cítalo en §5.8 y constrúyelo, no solo lo declares.
- **Corrección importante de premisa:** en Ecuador **la historia clínica no es propiedad del paciente**. El Manual del MSP, norma 10: *"La información consignada en la historia clínica **es propiedad del establecimiento de salud**."* El paciente es *titular de los datos* (ARCO+) y tiene derecho a su epicrisis (Ley Orgánica de Salud Art. 7.f). No construyas el pitch sobre "la historia clínica es tuya".
- Si CEPI presta el servicio como telesalud y hay una entidad extranjera involucrada, la Norma de Telesalud exige **domiciliarse en Ecuador y acreditarse ante la ACESS**, y el establecimiento es **corresponsable** del tratamiento y la seguridad de los datos.

---

## 8. Preguntas abiertas

Cuatro, ordenadas por cuánto cambian la arquitectura.

1. **¿El médico no quiere tipear, o el médico pierde información entre la consulta y la ficha?** Es *la* pregunta, y la primera versión de este documento la contestó implícitamente en la dirección más cara. Si es lo primero, el **dictado la resuelve entera** y todo el escenario (iii) —diarización, consentimiento por sesión, chunking, ffmpeg, retención de audio de terceros, la ola de demandas de §7.1— es trabajo que nunca hay que hacer. Si es lo segundo, el valor está justamente en capturar lo que el paciente dice literalmente, y hay que ir al ambient scribe. **Se responde con tres llamadas a médicos, no con dos días de benchmark de WER.** Respóndela antes de la semana 1.

2. **¿El audio se conserva o se descarta al transcribir?** Si se conserva, ¿cuántos días? Esto decide si hace falta un job de borrado, si el anclaje texto↔audio es posible, si hay que declarar el plazo en el Registro Nacional (y en los backups), y si el audio hereda la conservación de 10-15 años del expediente. **Mi recomendación es 14 días para el escenario (iii) y borrado inmediato para el dictado, pero es una decisión de negocio y de riesgo, no técnica.**

3. **¿Es aceptable que el audio de la consulta salga de Ecuador hacia un proveedor de EE.UU.?** Un "no" descarta Groq/AssemblyAI/ElevenLabs/Deepgram y deja **Azure (Brazil/Chile/Mexico, $0.18/h con diarización incluida)**, **AWS sa-east-1** o el **on-prem de Speechmatics**. Un "sí con consentimiento explícito y DPA firmado" hace todo lo demás mucho más simple y barato. Sub-pregunta operativa e inmediata: **¿Groq firma un DPA con las cláusulas de §7.3?** Si la respuesta tarda, arranca con AssemblyAI sin diarización y no pierdas la semana.

4. **¿Qué volumen mensual esperas en 6 meses?** 20, 200 o 2000 consultas cambian poco el costo de API (de centavos a ~$115 de ASR más el LLM de extracción, que a ese volumen puede ser mayor) pero cambian mucho si cruzas el umbral de "tratamiento a gran escala" — que dispara **EIPD obligatoria y DPO registrado ante la SPDP en 90 días**. Corre el MTGE de la Norma SPDP-SPD-2026-0005-R sobre la proyección antes de escalar, no después.

*(La pregunta de iOS ya no está abierta: con dictado, Safari alcanza indefinidamente y los USD 99/año no se justifican por esta feature. Vuelve a abrirse solo si el piloto lleva al escenario (iii), donde la pantalla bloqueada de iOS sí es bloqueante.)*

---

**Sources:** [AssemblyAI pricing](https://www.assemblyai.com/pricing) · [AssemblyAI benchmarks](https://www.assemblyai.com/docs/pre-recorded-audio/benchmarks) · [Groq speech-to-text docs](https://console.groq.com/docs/speech-to-text) · [Speechmatics Spanish medical model](https://www.speechmatics.com/company/articles-and-news/speechmatics-medical-model-launches-in-spanish) · [Speechmatics pricing](https://www.speechmatics.com/pricing) · [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) · [Deepgram pricing](https://deepgram.com/pricing) · [Deepgram diarization docs](https://developers.deepgram.com/docs/diarization) · [Azure Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/) · [AWS Transcribe pricing](https://aws.amazon.com/transcribe/pricing/) · [COIP Art. 178](https://www.unodc.org/cld/es/legislation/ecu/codigo_organico_penal/libro_primero/articulo_178/articulo_178.html) · [SPDP sanciones LigaPro/FEF](https://www.primicias.ec/deportes/futbol/superintendencia-datos-sanciona-ligapro-fef-infracciones-tratamiento-datos-personales-110763/)