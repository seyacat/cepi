# Dictado con ASR local — las tres vías comparadas

### Documento de decisión — CEPI Telemedicina

**Fecha:** 2026-07-28 · **Contexto:** el usuario descartó las APIs cloud de terceros y pidió que el modelo sea local. Este documento compara las tres formas de conseguirlo.

**Alcance:** escenario (i) de `docs/ASR_TRANSCRIPCION.md` — **dictado del médico**. Un hablante, cerca del micrófono, 60-180 s, español de Ecuador, vocabulario dermatológico. No cubre grabar la conversación médico-paciente.

**Documentos relacionados:**
- `docs/ASR_TRANSCRIPCION.md` — análisis original con las opciones cloud, el diseño del pipeline transcript→ficha, y todo el trabajo legal (LOPDP, consentimiento, retención, alucinación).
- `docs/ASR_PLAN_LOCAL.md` — plan de implementación detallado de la vía C, con código del endpoint `/transcribe`, configuración de `faster-whisper`, el túnel y el despliegue.
- `scripts/asr-bakeoff/` — **el banco de pruebas**, construido y verificado. Todo lo que estos tres documentos afirman sobre calidad viene de leaderboards públicos sobre audio genérico; ninguno midió español ecuatoriano dictado por un dermatólogo en tu micrófono. El bake-off es lo que convierte las recomendaciones de acá en una decisión. Ya encontró tres errores en el plan: ver `ASR_PLAN_LOCAL.md` §5.3.

---

## 1. Resumen ejecutivo

Las tres vías no son alternativas excluyentes: son **tres escalones del mismo camino**, y conviene recorrerlos en orden.

| | Vía | Dónde corre el ASR | Costo | Esfuerzo | ¿El audio sale del dispositivo? |
|---|---|---|---|---|---|
| **A** | Dictado del teclado | Gboard / teclado iOS | $0 | ~0 días | **Sí en Android** (salvo Pixel 6+). No en iOS |
| **B** | ASR nativo on-device | Motor del sistema operativo | $0 | 2-5 días | **No** — demostrable y logueable |
| **C** | Modelo propio en servidor | Tu hardware | $0-25/mes | 3-6 días | Sale del teléfono, no de tu infraestructura |

**Recomendación:** empieza por **A** esta semana para validar la hipótesis de producto sin construir nada, y construye **C** en paralelo sobre la RTX 4060 Ti. **B** es el destino final para Android si el piloto funciona, pero es el que más ingeniería nativa cuesta y el que menos control de vocabulario te da.

La corrección más importante de este documento frente al análisis anterior: **Whisper ya no es la respuesta por defecto en 2026**, y **Whisper `small` no sirve para uso clínico** aunque quepa en el VPS.

---

## 2. Los números medidos

Todo lo de esta sección lo medí hoy, no está estimado. Audio de 90 s, `int8` en CPU y `float16` en GPU, `beam_size=1`, VAD activo, `faster-whisper` 1.2.1 / CTranslate2 4.8.1.

### 2.1 CPU limitada a 2 hilos (i7-14700F)

| Modelo | Tiempo | Factor | RAM pico |
|---|---:|---:|---:|
| `tiny` | 1.2 s | 77× | 371 MB |
| `base` | 2.3 s | 40× | 430 MB |
| `small` | 6.8 s | 13× | **791 MB** |
| `medium` | 23.3 s | 3.9× | 2815 MB |
| `large-v3-turbo` | 31.7 s | 2.8× | **2045 MB** |

### 2.2 GPU RTX 4060 Ti (16 GB)

| Modelo | Dictado 90 s | Consulta 15 min | Factor |
|---|---:|---:|---:|
| `large-v3-turbo` **int8_float16** | **1.11 s** | — | **81×** ← el óptimo |
| `large-v3-turbo` float16 | 1.6 s | **13.7 s** | 58-65× |
| `large-v3` float16 | 3.6-4.2 s | — | 21-25× |

La 4060 Ti transcribe un dictado de 90 s **más rápido de lo que tardas en soltar el botón**. Con 16 GB de VRAM te sobra para `large-v3` completo, que es lo mejor que puedes correr.

Extremo a extremo —decode de audio, VAD, HTTP y el salto por el túnel— son **2-4 s desde que el médico suelta el botón**. Cabe dentro del `proxy_read_timeout` de 60 s de nginx, así que **no necesitas worker asíncrono, ni estado `pending`, ni polling del frontend**.

### 2.3 Extrapolación al VPS de producción

Hay dos mediciones del castigo de CPU del VPS frente a tu i7, con metodologías distintas:

| Método | Factor | Qué mide |
|---|---:|---|
| Bucle de Python, 8M iteraciones (0,930 s vs 0,301 s) | 3,09× | Despacho del intérprete — mal proxy |
| **GEMM float 512×512, un hilo** (26,8 GFLOPS vs 58,8 GFLOPS) | **2,30×** | **Multiplicación de matrices — lo que hace CTranslate2** |

**El bueno es el de GEMM.** Whisper en int8 es esencialmente GEMM vectorizado, no despacho de intérprete.

| Modelo | Estimado en el VPS | RAM | ¿Entra en 1140 MB? |
|---|---:|---:|:---:|
| `tiny` | ~3 s | 371 MB | ✅ |
| `base` | ~5 s | 430 MB | ✅ |
| `small` | **~16 s** | 791 MB | ✅ justo |
| `medium` | ~54 s | 2815 MB | ❌ |
| `large-v3-turbo` | ~73 s | 2045 MB | ❌ |

> ⚠️ Estos tiempos son **piso optimista**. El factor de 2,30× es por core y en un hilo; los 2 "cores" del VPS son 2 hilos sobre **1 core físico**, mientras que mis 2 hilos cayeron en 2 cores físicos. El número real de `small` está entre **16 y 31 s**. Medirlo exige correr el benchmark en producción, y la decisión tomada fue no tocarla.

**Conclusión de CPU:** el VPS aguanta técnicamente hasta `small`. Hay dos problemas mayores, y están en las secciones siguientes: el modelo no sirve (§3.1), y esos 16-31 s ocupan **el 100% del único core** mientras nginx, PostgreSQL y los cuatro servicios de PM2 compiten por él. Dos médicos dictando a la vez ponen la app de rodillas.

---

## 3. Qué modelo — Whisper dejó de ser la respuesta por defecto

Este es el hallazgo que cambia la decisión. En 2026 hay tres modelos abiertos que superan a Whisper en español, y son más rápidos y más chicos.

| Modelo | WER español | Velocidad | Tamaño / RAM | Licencia | Notas |
|---|---:|---|---|---|---|
| **Cohere Transcribe 03-2026** | **2,81** | RTFx 723 en GPU | ~4,1 GB VRAM fp16 / ~2 GB en Q4 | Apache 2.0 | **El mejor abierto en español** |
| **NVIDIA Canary-1B-v2** | 3,23 | RTFx 1466 en GPU | ~6 GB RAM | CC-BY-4.0 | Decoder autorregresivo: malo en CPU |
| **NVIDIA Canary-180M-Flash** | 3,17 (MLS es) | 5-10× en 2 hilos *(estimado)* | **154 MB / ~400 MB RAM** | CC-BY-4.0 | Solo es/en/de/fr. **El único bueno que cabe en el VPS** |
| **NVIDIA Parakeet-TDT-0.6B-v3** | 3,71 | **RTFx 3786** (11× Whisper) | 487 MB / ~700 MB-1 GB | CC-BY-4.0 | No alucina en silencios. **Acepta hotwords** |
| Whisper `large-v3` | 4,15 | RTFx 328 | ~1,5-2,5 GB en int8 | MIT | La referencia vieja |
| Whisper `large-v3-turbo` | ~4,2 | 2× large-v3 | ~1,5 GB en int8 | MIT | Lo que vende Groq |
| Whisper `small`/`base`/`tiny` | **dos dígitos** | rápido | <1 GB | MIT | ❌ **Descartados para ficha clínica** |
| Distil-Whisper | — | — | — | MIT | ❌ No soporta español |
| Voxtral Mini-3B | 4,20 | RTFx 188 | 9,5 GB VRAM | Apache 2.0 | El bueno (24B) no cabe en tu GPU |

### 3.1 La consecuencia sobre el VPS

Mi tabla de la sección 2.3 decía que `small` cabe en el VPS. **Cabe, pero no sirve**: Whisper `small` tiene WER de dos dígitos en español real, y eso en una ficha clínica significa terminología dermatológica destrozada.

El modelo correcto para el VPS actual no es `small`, es **Canary-180M-Flash**: 154 MB en disco, ~400 MB de RAM, WER 3,17 en MLS español — mejor que Whisper `large-v3` y 5× más chico que `small`. Entra con holgura en los 1140 MB disponibles.

> ⚠️ Su velocidad en 2 hilos a 2 GHz es estimación, no medición. Y solo soporta 4 idiomas, lo cual aquí es irrelevante.

### 3.2 Por qué Parakeet importa aparte

**Acepta *hotwords***, es decir, puedes inyectarle el vocabulario dermatológico (nombres de fármacos, `queratosis actínica`, `pitiriasis versicolor`, `liquenificación`, `tacrolimus`) para sesgar el reconocimiento. Whisper solo tiene el truco del `initial_prompt`, limitado a 224 tokens y con riesgo de inducir alucinación. Esa es la mayor palanca de calidad local que tienes, y es gratis.

Además **no alucina en silencios**, que es precisamente el modo de fallo documentado de Whisper (Koenecke et al., FAccT '24: ~1% de transcripciones con frases completamente inventadas, y peor con hablantes de pausas largas).

---

## 4. Vía A — Dictado del teclado del sistema

**Cómo funciona:** el micrófono lo dibuja Gboard o el teclado de iOS, no tu página. El texto entra al `<textarea>` por la misma ruta que el tecleo normal (`InputConnection` → IME → DOM). Tu APK no declara `RECORD_AUDIO`, no pide permiso de micrófono y nunca ve un `Blob`. Desde el punto de vista de la app, el médico *escribió*.

**Estado en el repo:** el composer del chat ya es un `<textarea>` plano con `v-model` (`cepi-frontend/src/components/IntakeChat.vue:79-85`) y el placeholder ya dice *"Escribe o pega un texto largo…"*. **Probablemente ya funciona hoy sin cambiar código.**

### Lo que gana

- Cero infraestructura, cero costo por minuto, cero permiso de micrófono.
- **Se distribuye por OTA con Capgo**, porque no toca el `AndroidManifest.xml`. La vía de grabar audio obliga a pasar por Play Store.
- Desaparece toda la mitad pesada del pipeline: `MediaRecorder`, chunking, IndexedDB, worker, límite de multer, retención de audio, job de borrado, contaminación de backups.
- El médico ve el texto aparecer mientras habla y lo corrige en el momento.

### Lo que pierde, y la trampa

- **No puedes garantizar que el audio no salga.** El modo on-device de Gboard (*advanced voice typing*) requiere **Pixel 6 o superior**. En el parque real ecuatoriano — Samsung serie A, Redmi, Motorola — el dictado va **por defecto a servidores de Google** salvo que el usuario baje a mano el paquete offline. Con teclado de Samsung puede ir a servidores de Samsung: otro tercero más.
- **En iOS sí está confirmado** en fuente primaria de Apple que el dictado en español es on-device (es-MX, es-CO, es-CL, es-ES, es-US).
- Legalmente es **peor de lo que parece**: sin contrato de encargo no aplica el escudo del Art. 34 LOPDP, y el Art. 12.10 obliga a informar **quiénes son los destinatarios** — que aquí dependen del teclado que cada médico tenga instalado, o sea indeterminables en tiempo de diseño.
- **Vocabulario dermatológico: imposible.** No hay diccionario que afecte al dictado del IME.
- **No puedes medir adopción**: no existe `insertFromDictation` en Input Events Level 2, así que la app no sabe si el texto vino de dictado o de tecleo.
- **Corte por silencio a ~2-3 s**, no configurable. Los 60-180 s de dictado corrido **no están validados**.

### Bug que ya tienes, independiente de esto

`IntakeChat.vue:555-565`: `onSubmit()` lee `draft.value` (línea 556) y después hace `draft.value = ''` (línea 562). Vue 3.5.34 ignora los eventos `input` mientras `el.composing === true` y omite la escritura programática durante composición — verificado en `node_modules/@vue/runtime-dom`. Si el IME está componiendo al enviar, **el mensaje sale incompleto y el textarea no se limpia**.

Esto afecta **el tecleo normal en Android hoy**, no solo el dictado: Gboard compone mientras escribes por autocorrección y por deslizamiento.

**Arreglo:** en `onSubmit()`, llamar `taEl.value.blur()` antes de leer (el `change` del blur cierra la composición) y leer `taEl.value.value` en vez de `draft.value`. Añadir un watchdog que fuerce `composing = false` si pasan 3 s sin `compositionend`.

---

## 5. Vía B — ASR nativo on-device

**Cómo funciona:** un plugin de Capacitor llama al motor de reconocimiento del sistema operativo forzando el modo local.

- **Android:** `SpeechRecognizer.createOnDeviceSpeechRecognizer()`, API 31+. Para forzarlo de verdad hace falta **Android 13 (API 33)** y que el pack de español esté descargado.
- **iOS:** `SFSpeechRecognizer` con `requiresOnDeviceRecognition = true`. Permisos `NSSpeechRecognitionUsageDescription` y `NSMicrophoneUsageDescription`.
- Plugin candidato: `@capgo/capacitor-speech-recognition` (la familia `@capgo` es la que declara compatibilidad con Capacitor 8; **no** uses `@capacitor-community/speech-recognition` 7.x).

### Por qué importa

**Es la única configuración donde "el audio no sale del dispositivo" es demostrable y logueable**, no una suposición. Sin servidor, sin GPU, sin VPS, sin costo por minuto, con resultado prácticamente instantáneo y *partials* en vivo.

### Lo que pierde

- **Vocabulario médico: no verificado.** El dictado de Google en español general es muy bueno; en términos dermatológicos va a normalizar hacia palabras comunes. Sin hotwords.
- Depende de que el usuario tenga Android 13+ y el pack de español instalado. En dispositivos viejos degrada a la nube o falla.
- Requiere **release por Play Store** (permiso nativo), no sale por OTA.
- Calidad atada al modelo del sistema operativo, que no controlas ni versionas.

### Alternativa dentro de la misma vía — y por qué hoy no es viable

**sherpa-onnx nativo** (AAR de Android / framework de iOS) cargando **Parakeet-TDT-0.6B-v3** sería lo mejor de ambos mundos: on-device *de verdad*, 487 MB de modelo, 3,4-4,4% de WER en español, **con hotwords** para el vocabulario dermatológico.

**El problema es que no existe el plugin.** Búsqueda en npm hoy: **cero paquetes** de Capacitor que envuelvan sherpa-onnx o whisper.cpp. En GitHub solo repos de 0-1 estrellas. El equivalente maduro vive en otro ecosistema (`whisper.rn` en React Native, 798★). Escribirlo y mantenerlo son **2-4 semanas de NDK y Core ML más mantenimiento perpetuo** — desproporcionado para prellenar un formulario.

Queda como opción a reevaluar si aparece un plugin adoptable, no como plan.

### Lo que NO funciona: WebGPU en el WebView

`transformers.js` v4 con Whisper en WebGPU funciona bien en **navegador de escritorio**, pero **no en el APK de Capacitor**. Las fuentes se contradicen —MDN lo marca como *mirror* de Chrome Android 121 (asumido, no verificado), caniuse marca el agente `android` como no soportado, y caniwebview lo lista explícitamente como NO soportado en Android WebView y en WKWebView. **Hay que resolverlo empíricamente antes de invertir un día en esto.**

---

## 6. Vía C — Modelo propio en servidor

**Cómo funciona:** el frontend graba con `MediaRecorder`, sube el audio como attachment normal, y un endpoint `POST /transcribe` en `cepi-isic` (FastAPI, ya existe) devuelve el texto.

**Lo bueno:** el transporte ya está construido. `uploadAttachment()` (`cepi-frontend/src/api.js:352-366`) acepta cualquier Blob, y el `fileFilter` de multer (`attachmentsRouter.ts:42-55`) es blacklist de ejecutables, no whitelist: `audio/webm` y `audio/mp4` pasan **sin tocar el servidor**.

### Dónde hostear — rutas costeadas

| Ruta | Hardware | Costo/mes | Latencia (dictado 90 s) | Soberanía |
|---|---|---:|---|---|
| **Tu 4060 Ti + túnel Tailscale** | Ya lo tienes | **$0-8** | **1,6 s** *(medido)* | Total |
| Mini-PC en la clínica, en LAN | $500-600 único | ~$19-23 | ~5-15 s | Total |
| Subir el VPS a 8 GB RAM | Contabo VPS 4 (4 vCPU/8 GB) | **$6,25** | ~16-30 s *(estimado)* | Total |
| VPS con GPU dedicada 24/7 | Hetzner GEX / Contabo | $60-200+ | <2 s | Total |
| GPU serverless (RunPod, Modal) | — | ~$1-5 | 2-3,5 s + arranque en frío | **⚠️ No es local** — el audio sale a un tercero |
| *(referencia)* API cloud | — | $0,20-2,00 | ~0,4 s | ❌ Descartada |

**Nota sobre el VPS:** subirlo a 8 GB cuesta ~$6/mes y no lo harías por CPU sino **por RAM** — es lo que permite pasar de `Canary-180M` a `large-v3-turbo` int8 (2045 MB de pico contra los 1150 MB disponibles hoy). El valor real no es que sea la ruta principal, sino tener un **escalón de degradación soberano** para cuando tu máquina esté apagada o haya corte de luz.

> ⚠️ **Aviso caro:** si tu VPS está en Hetzner con precio viejo, **no lo escales verticalmente**. Cualquier rescale, arriba o abajo, dispara los precios de 2026 al instante — el CCX23 pasó de €31,49 a €85,99 en cinco meses. Crea instancia nueva y migra.

**Nota sobre serverless:** aunque el modelo sea abierto y el contenedor sea tuyo, el audio sale hacia infraestructura de un tercero. Si el requisito es soberanía del dato, **esta ruta no la cumple** aunque técnicamente sea "self-hosted".

### Software servidor

**No uses `speaches`** pese a ser la opción que más suena: el proyecto está semi-parado (último commit en master 2026-04-18; issue #659 *"Actively supported?"* del 2026-07-05 sin respuesta, con 102 issues y 28 PRs sin atender; v0.9.0 lleva 7 meses en release candidate; issue #638 abierta por RAM que no se libera al descargar el modelo).

**Usa `faster-whisper` in-process dentro de `cepi-isic`.** El argumento del aislamiento no aplica en una máquina con 20 cores y 62 GB, y te ahorras operar un contenedor extra. Con carga perezosa, lock de concurrencia 1, VAD y descarga por inactividad.

Patrón de invocación: ya existen dos en el repo y ambos sirven.
- **Síncrono:** `cepi-bot/src/imageInspect.ts` hace `fetch` a `${ISIC_URL}/inspect`; el servicio Python descarga el binario él mismo con el Bearer del usuario.
- **Asíncrono:** `TodoERP/backend/src/services/clinicalImageProcessor.ts` hace polling cada `CEPI_ISIC_POLL_MS` sobre filas con estado `pending`.

Para dictado, **síncrono**: 1,6 s en la 4060 Ti cabe de sobra en los 120 s de `/api/bot/`.

---

## 7. Plan por etapas

### Semana 1 — Validar la hipótesis sin construir nada (vía A)

1. **Arreglar el bug de composición IME** en `IntakeChat.vue:555-565`. Es un bug real que afecta el tecleo en Android hoy, independiente de todo esto.
2. **Probar el dictado de Gboard** en un Samsung A y un Redmi reales, con la PWA y con el APK. Dictar 90 s de anamnesis con pausas de 3-5 s. Anotar si `compositionend` llega y cuántas veces se corta.
3. **Prueba de modo avión**, con y sin paquete offline instalado. Si el dictado deja de funcionar sin red, queda probado que el audio salía.
4. **50 términos dermatológicos reales** dictados por un médico. Medir el WER a mano.
5. **Guardar el par `(texto_dictado, patch_guardado)` desde el día 1.** Es el corpus que necesitas para medir si la extracción funciona, y es irrecuperable a posteriori.
6. Aviso al médico: *"quien transcribe es Google o Apple, no CEPI"* y *"dicta el cuadro clínico, no dictes nombres ni cédulas"*.

**Esto ya entrega valor:** el médico dicta, obtiene texto, y de ahí sale la extracción a la ficha. Sin construir pipeline de audio.

### Semanas 2-3 — Construir la vía C sobre la 4060 Ti

1. `useRecorder.js` + botón de micrófono en `IntakeChat.vue`, con medidor de nivel (`AnalyserNode`), constraints explícitas y verificación de `blob.size > 0`.
2. Endpoint `POST /transcribe` en `cepi-isic` con `faster-whisper` in-process, `device="cuda"`, `compute_type="float16"`.
3. **Bake-off de modelos con audio real tuyo**: `large-v3-turbo`, `large-v3`, Parakeet-TDT-v3 y Cohere Transcribe. Es la única forma de saber cuál gana en español ecuatoriano con dermatología.
4. Túnel Tailscale entre el VPS y tu máquina, con degradación explícita si está apagada.
5. Extracción a **formulario prellenado**, nunca escritura directa (ver `docs/ASR_TRANSCRIPCION.md` §5.5).

### Mes 2+ — Decidir el destino de producción

Según lo que muestre el piloto:
- Si el volumen es bajo y el vocabulario importa → **mini-PC en la clínica** con Parakeet + hotwords.
- Si hace falta que funcione sin tu máquina → **subir el VPS a 8 GB** ($6/mes) con `large-v3-turbo` int8, o `Canary-180M-Flash` en el VPS actual sin gastar nada.
- Si Android es el canal principal → **plugin sherpa-onnx** con Parakeet on-device.

---

## 8. Lo que falta medir, y no se puede deducir

1. **WER en español ecuatoriano con dermatología.** No existe corpus público. Mi benchmark usó audio en inglés porque no conseguí muestras públicas en español — sirve para velocidad, **no dice nada de calidad**. Se resuelve grabando 10-15 dictados reales, transcribiéndolos a mano como referencia, y corriendo el bake-off del punto 3 de arriba.
2. **El factor de hyperthreading del VPS** (~1,6× asumido). Solo se mide corriendo el benchmark ahí.
3. **Si WebGPU existe en el Android System WebView.** Las fuentes se contradicen. Dos horas de prueba en dispositivo lo resuelven.
4. **Si Gboard aguanta 90 s de dictado corrido.** Documentado que corta a ~2-3 s de pausa; no está claro qué pasa con habla continua.
5. **Velocidad real de Canary-180M-Flash en 2 hilos.** Es el modelo que decide si el VPS actual sirve, y su velocidad ahí es estimación.

---

## 9. Gobernanza

`docs/PAPER.md:1091` tiene la decisión **D-6 cerrada: "Grabaciones de voz si se agrega dictado → No en v1."** Por la regla paper-first de `CLAUDE.md`, habilitar cualquiera de estas tres vías exige reabrir y actualizar esa decisión en el paper **antes de tocar código**, declarando explícitamente que se habilita solo el escenario (i).

La vía A es la que más se parece a "no habilitar nada" —técnicamente es entrada de texto— pero el efecto sobre el dato es el mismo, así que también pasa por D-6.
