# Bake-off de ASR — dictado clínico en español

Decide con **tus** audios cuál de los candidatos locales sirve para el dictado
del médico (escenario *i* de [`docs/ASR_TRANSCRIPCION.md`](../../docs/ASR_TRANSCRIPCION.md) §2.1),
y con qué configuración. Contexto y recomendación previa:
[`docs/ASR_OPCIONES_LOCALES.md`](../../docs/ASR_OPCIONES_LOCALES.md) y
[`docs/ASR_PLAN_LOCAL.md`](../../docs/ASR_PLAN_LOCAL.md).

Todo lo que dicen esos documentos sobre calidad viene de leaderboards públicos
sobre audio genérico. **Ninguno midió español ecuatoriano, dictado por un
dermatólogo, con vocabulario clínico, en tu micrófono.** Eso es lo único que
decide, y es lo que corre acá.

## Las tres preguntas que contesta

1. **¿Qué modelo?** `large-v3-turbo` vs `large-v3` vs Parakeet vs Cohere vs Canary.
2. **¿El glosario (`hotwords`) ayuda o inventa?** Sube el acierto en términos
   raros, pero también las alucinaciones. Una "queratosis actínica" que nadie
   dijo, en una ficha, es peor que diez tildes mal.
3. **¿Cuánto se pierde al bajar de la GPU al CPU?** Es la diferencia entre tu
   4060 Ti y el mini-PC de la clínica — o el VPS.

---

## 1. Grabar los dictados

**Cuántos:** empezá con 12-15. Con eso ya distinguís diferencias grandes
(`small` vs `turbo`). Para el A/B de `hotwords`, que es la diferencia fina,
vas a necesitar 25-30 — pero no adivines: el reporte calcula, con tus propios
datos, cuántas muestras faltarían para que cada comparación sea concluyente.

**Con qué grabar:** con el teléfono, dentro de la app, a la distancia real de
uso. No con un micrófono bueno. Si medís con condensador y desplegás con un
celular en el bolsillo del mandil, los números que obtengas no describen nada.

**Qué tienen que contener**, o el bake-off no mide lo que creés:

| | Por qué |
|---|---|
| **≥8 dictados con vocabulario del glosario** — diagnósticos y fármacos por nombre | Sin términos en las referencias, el A/B de `hotwords` no tiene nada que medir. El reporte te lo va a decir en §4, pero mejor no llegar ahí |
| **Pausas reales de 3-10 s** — pensando, mirando la lesión | Es lo único que ejercita el VAD y las alucinaciones en silencio, que son el modo de falla más peligroso de Whisper |
| **2-3 dictados largos (>3 min)** | Con `condition_on_previous_text=False` el prompt se resetea cada ventana de 30 s. Los bugs de dictado largo no aparecen en clips de 40 s |
| **2-3 cortos (<30 s)** | El otro extremo: un "control en dos semanas, sigue igual" |
| **Números con unidades** — "tres coma cinco milímetros", "cero coma cero cinco por ciento" | Es donde más se rompe la transcripción y donde más importa clínicamente |
| **Code-switching**: peeling, láser, shaving, punch, pool test | Cohere Transcribe rinde inconsistente acá y es el favorito según el leaderboard. Si no lo grabás, no lo vas a descubrir |
| **2-3 voces distintas**, sierra y costa | Un modelo puede ser excelente con vos y malo con el residente |
| **1-2 en condiciones malas** — consultorio con ruido, aire acondicionado | Define el piso, no el promedio |

**Formato:** el que sea (`ffmpeg` convierte). Grabá a 16 kHz o más; por debajo
de eso perdés información que ningún modelo recupera.

**Nombres:** `01-nevo-dorso.wav`, `02-psoriasis-control.wav`. **Sin nombres de
paciente ni cédulas en el nombre del archivo** — los nombres de archivo
terminan en logs, en reportes y en pantallas compartidas.

Copiá todo a `audio/`.

---

## 2. Las referencias

```bash
./setup.sh          # venv + dependencias (una sola vez)
./draft_refs.py     # borradores con large-v3, ~unos segundos por dictado
```

Eso deja `refs/<nombre>.draft.txt` con un segmento por línea y su timestamp,
para que corrijas escuchando. Después:

```bash
mv refs/01-nevo-dorso.draft.txt refs/01-nevo-dorso.txt
```

`bakeoff.py` **solo lee `.txt`**, nunca `.draft.txt`, y avisa fuerte si
encuentra borradores sin corregir. No es burocracia: si evaluás contra la
salida de Whisper sin corregir, estás midiendo *cuánto se parece cada modelo a
Whisper*. El reporte saldría hermoso y no significaría nada.

**Corregí verbatim: lo que se dijo, no lo que debería quedar en la ficha.**
Muletillas, repeticiones y autocorrecciones van tal cual. El WER mide
reconocimiento; limpiar el texto es trabajo del LLM y se evalúa aparte.

No pierdas tiempo unificando "3 mm" con "tres milímetros": `normalize.py` ya
los iguala, junto con tildes, romanos del Fitzpatrick, porcentajes y decimales.

---

## 3. Correr

```bash
./run.sh --listar                  # qué configs y grupos hay
./run.sh --grupo rapido            # turbo, turbo+hot, large-v3
./run.sh --grupo ablacion          # beam, VAD, int8 vs fp16
./run.sh --grupo cpu               # lo que pasaría en el mini-PC
./run.sh --grupo todo
./run.sh --config turbo parakeet   # ids sueltos
```

Es reanudable: si lo matás a la mitad, la próxima corrida salta lo ya hecho.
`--force` rehace todo, `--solo-reporte` regenera el reporte desde `raw.json`
sin volver a transcribir (útil mientras ajustás el glosario o el normalizador).

Para los rivales de Whisper hay que bajar los pesos primero:

```bash
./fetch-model.sh                          # lista lo disponible
./fetch-model.sh parakeet-tdt-0.6b-v3
./fetch-model.sh cohere-transcribe
./fetch-model.sh canary-180m-flash
```

Si el directorio extraído no coincide con lo que espera `configs.py`, el script
te dice el `ln -s` exacto que falta.

Salida en `results/`: `report.md` (el que se lee), `raw.json` (todo, reanudable)
y `diffs/<dictado>.txt` con la referencia y la transcripción de cada config una
debajo de otra.

---

## 4. Leer el reporte

El orden importa, y no es el del ranking:

1. **Descartá toda config con `alucinados` alto**, sin mirar su WER. Son
   términos del glosario que el modelo escribió y nadie dijo. En una ficha
   clínica eso no se negocia contra dos décimas de WER.
2. **Mirá §2 antes de creerle al ranking.** El bootstrap pareado te dice si la
   diferencia con el baseline es real o ruido de muestreo. Si no es
   concluyente, quedate con la config **más barata de operar**, no con la del
   número más lindo.
3. **`WER strict` vs `WER relaxed`.** Si hay mucha distancia, tus errores son
   cosméticos (tildes, unidades) y los arregla el post-proceso. Si son casi
   iguales, son errores de verdad.
4. **Recién ahí, la latencia.** Por debajo de ~5 s el médico no nota la
   diferencia. El salto que importa es de 5 s a 30 s.
5. **La licencia.** `parakeet` y `canary` son CC-BY-4.0: exigen atribución
   visible a NVIDIA en el producto. Un dígito de diferencia en el nombre del
   modelo (`parakeet-tdt-1.1b`, `canary-1b`) te deja en CC-BY-**NC**, que
   prohíbe uso comercial.
6. **Leé `results/diffs/` de los 3 peores dictados.** La mitad de las veces el
   problema es la grabación o una referencia mal tipeada, no el modelo.

---

## 5. Antes de grabar: usá casos simulados

**Recomendación fuerte: que los dictados sean simulados** — el médico
improvisando casos realistas con datos de paciente inventados — y no dictados
reales de consulta.

Para medir ASR da exactamente lo mismo: lo que importa es el acústico, el
acento, el vocabulario y la prosodia, y todo eso es idéntico. Lo que cambia es
todo lo demás. Un dictado real es dato personal de salud (LOPDP Art. 26.a):
necesita consentimiento explícito para este uso concreto, y un set de
benchmark no se borra nunca — se copia a otra máquina, se comparte con quien
te ayude a evaluar, sobrevive al proyecto. Un corpus simulado no arrastra nada
de eso.

Si aun así usás audio real: consentimiento por escrito para este uso, sin
nombres ni cédulas dictados en voz, y tené presente que `audio/` y `refs/`
están en `.gitignore` pero **eso no es cifrado** — viven en `/mnt/sda1`, que es
NTFS sin cifrar.

---

## 6. Lo que este bake-off NO mide

Para que nadie lea el reporte como si dijera más de lo que dice:

- **La calidad de la ficha.** Mide transcripción, no la extracción
  transcripción→campos. Un WER de 4% puede producir una ficha perfecta o una
  desastrosa según dónde caigan los errores. Esa evaluación es otra, contra el
  LLM, y todavía no existe.
- **Los escenarios *ii* y *iii*** (conversación médico-paciente, varias voces).
  No hay diarización acá, y el producto hoy es store-and-forward: no existe una
  consulta sincrónica que grabar.
- **La latencia que siente el médico.** Mide inferencia pura, sin subida del
  archivo ni red. Sumale eso.
- **El VPS de producción.** Las configs `cpu` corren en tu máquina con
  `cpu_threads=4`. Para el VPS aplicá el factor de escalado de
  `ASR_OPCIONES_LOCALES.md` §2.3, o medí ahí directamente cuando decidas.

---

## 7. Cosas que ya pasaron, verificadas

Todas encontradas construyendo esto, todas silenciosas. Están documentadas en el
código donde corresponde; acá el resumen para que no las redescubras.

| Síntoma | Qué es |
|---|---|
| Columna **Palabras** muy por debajo de 100% | `without_timestamps=True` perdió ventanas enteras de 30 s: sin timestamp al que saltar, un fin-de-texto temprano se lleva el bloque completo. Medido: 19% de las palabras en `turbo`. Por eso el baseline usa `False` y el plan quedó corregido |
| La transcripción es literalmente el `initial_prompt` | El modelo completó la frase del prompt y emitió fin-de-texto. Un `initial_prompt` corto y declarativo es una frase *terminable* |
| **Vacías** > 0 en Canary | Canary devuelve cadena vacía cuando el audio no coincide con su `src_lang`. No degrada: pierde el dictado entero |
| Muro de `Cannot find ID for token` al correr `parakeet+hot` | El release no trae `bpe.model`; sherpa descarta el glosario y transcribe sin él. Los resultados son idénticos a `parakeet` y no miden nada |
| El proceso muere sin traceback en una config de sherpa | sherpa-onnx llama a `exit()` desde C++ en vez de lanzar excepción. Se lleva el proceso y el buffer de stdout. `raw.json` se guarda después de cada config, así que no perdés lo ya hecho: volvé a lanzar y sigue donde quedó |
| `Library libcublas.so.12 is not found` | Estás llamando a `.venv/bin/python` directo en vez de `./run.sh` |
| El glosario "no hace nada" | Contá los tokens: `./run.sh glosario.py`. El techo son 223 y faster-whisper trunca **el final** sin avisar, justo donde van los términos más raros |

## Archivos

| | |
|---|---|
| `configs.py` | La matriz. Cada config existe para contestar **una** pregunta; está escrito cuál |
| `glosario.py` | Términos dermatológicos. Techo real: **223 tokens** — `python glosario.py` te los cuenta |
| `normalize.py` | Normalización es. `python normalize.py` muestra ejemplos |
| `metrics.py` | WER/CER corpus-level, recall y alucinación de términos, bootstrap pareado |
| `backends.py` | faster-whisper y sherpa-onnx. Firmas verificadas contra sherpa-onnx 1.13.4 |
| `bakeoff.py` | El runner y el reporte |
| `draft_refs.py` | Borradores de referencia (sin `hotwords`, a propósito) |
