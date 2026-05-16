# cepi — STATUS

Estado del proyecto al cierre de la sesión actual.

---

## Servicios corriendo (PM2 local)

| Nombre | Puerto | Estado | Notas |
|---|---|---|---|
| `todoerp-backend` | 3001 | ✅ | `CEPI_MEDICAL=1`: hooks médicos + clinicalImageProcessor |
| `todoerp-frontend` | 5173 | ✅ | admin TodoERP |
| `cepi-bot` | 3002 | ✅ | agente conversacional + MCP loop |
| `cepi-frontend` | 5174 | ✅ | UI médica de chat |
| `cepi-isic` | 8000 | ⚠️ disabled by default | Python FastAPI; `pm2 start … --only cepi-isic` tras `apt install python3-venv` |
| `postgres` (WSL) | 5432 | ✅ | con extensión pgvector |

---

## Plan refactor TodoERP — 10/10

| ID | Tema | Commit |
|---|---|---|
| R1 | shadow-sync trigger sobre `entities` | 4094bdc |
| R2 | cross-type FK en `entity_<slug>.parent_id` | e5044a1 |
| R3 | validación JSONB contra `entity_definitions.config` | 2248434 |
| R4 | redacción de PII en respuestas | 8dfaa8d |
| R5 | (Phase A) `entity_relationships.target_definition_id`+`local_key` | af0865a |
| R6 | lifecycle hooks por entity_definition | 7049347 |
| R7 | aislamiento de tests, sin prefijo TEST_ | fd0be39 |
| R8 | `roles.allow_grant_all` reemplaza el bypass por nombre | c13b370 |
| R9 | convención de routers (>300 LOC ⇒ split) | c87c82f |
| R10 | CORS_ORIGINS con globs | 9f006d9 |

R5 Phase B (rename de keys en data JSONB existente) — **superada por la migración JSONB→columnas**.

### Migración JSONB → columnas reales (completa)

Cada `entity_<slug>` tiene columnas tipadas derivadas de `entity_definitions.config.fields[]`. La columna `data JSONB` fue dropeada. Writers (`insertBusinessRecord`, `put.ts` rama business) escriben directo a columnas vía `planFieldsForEntity`/`mapDataToColumns`; readers reensamblan el shape `data` con `assembleDataFromRow`. `indexSyncService` indexa columnas reales. CHECK constraints generados para `select` con `options`. La API y el frontend no cambiaron. Implementación en `backend/src/services/columnSyncService.ts`.

---

## Fases del PAPER

### Fase 1 — capacidades genéricas en TodoERP

- [x] **1A reminders** (alerts/reminders subsystem, scheduler, channels)
- [x] **1B vector store** (pgvector, models_registry, vector_embeddings, entity_classifications)
- [x] **1C temporary permissions** (break-glass)
- [x] **1D request_review** (acción genérica de escalamiento)

### Fase 2 — MCP server de TodoERP

- [x] 28 tools genéricas
- [x] Test de generalidad (entidad no clínica "lead")
- [x] Wireado para que cepi-bot lo invoque por stdio

### Fase 3 — modelo clínico + datos ficticios

- [x] 9 entity_definitions (patient, episode, diagnosis, prescription, lab_order, clinical_image, bot_session, consent, icd10_code)
- [x] Roles paciente/medico/supermedico + matriz §13.1 (admin sin acceso clínico — D-1)
- [x] models_registry con 4 stubs ISIC + text-embed
- [x] form_configs + navs_configs
- [x] Seeder ficticio: 50 pacientes / 150 episodios / 80 dx / 120 imágenes / 240 clasificaciones / 200 reminders / 10 bot_sessions
- [x] CIE-10 dermatología (37 códigos)

### Fase 4 — agente conversacional

- [x] Cliente MCP del SDK
- [x] Loop de tool-use con LLM (StubLLMAdapter + DeepSeekLLMAdapter listos, env-driven)
- [x] Gestión de active_patient_id / active_episode_id por sesión
- [x] Persistencia bot_session vía entities.create
- [x] Frontend de chat con tool result rendering, file upload, pending action panel
- [x] PM2 ecosystem con los 4 servicios
- [x] Modo guest (CEPI_GUEST_API_KEY env)

### Fase 5 — captura clínica

- [x] Hook `episode_close_followup` (R6 first medical hook)
- [x] CIE-10 catálogo (data, no code)
- [x] Subida de imágenes → `clinical_image` con confirmación obligatoria
- [x] `nuevo episodio <motivo>` con auto-activate
- [x] `cerrar episodio <fecha> <motivo>` con fetch+merge para preservar data
- [x] PUT con validación parcial
- [x] `/help` autodescubrible
- [x] `ver paciente` / `ver episodio` shortcuts
- [x] `nota <texto>` + `ver chatter`
- [x] `signs PA=… FC=… T=…` (signos vitales con gate)
- [x] `diagnostico <CIE10> <descripción>` con gate
- [x] `resumen` de paciente
- [x] `exportar [anonimizado]` JSON download
- [x] Auditoría: chatter note tras cada confirmación (R6 + bot)
- [x] PII redaction outbound al LLM (PAPER §13.3.1)
- [ ] Slot filling guiado por LLM (deferido — requiere DEEPSEEK_API_KEY)

### Fase 6 — clasificación de imagen ISIC

- [x] Servicio Python `cepi-isic/` (FastAPI) — endpoints /embed, /classify/triage, /classify/multiclass — modo stub determinístico
- [x] Worker `clinicalImageProcessor` en TodoERP backend (poll cada 15s, batch 5, opt-in via CEPI_MEDICAL=1)
- [x] Test del worker con fetch stubbed
- [ ] Pesos reales (ResNet/EfficientNet sobre HAM10000) — el usuario los conecta cuando los tenga
- [ ] Política de escalación automática por confianza (D-Aux-1: nada se decide sin acción explícita del médico, así que la "escalación automática" es solo *visual highlight*; puede esperar)

### Fase 7 — modo paciente y portal — diferida a v1.5/v2

### Fase 8 — supermédico, dashboards

- [x] `/escalar a <user-uuid> <razón>` — escalación desde chat
- [x] `revisiones` shortcut — bandeja de episodios `en_revisión_solicitada`
- [x] `sugerir diagnostico` — clasificaciones ISIC → CIE-10 mapping
- [x] `casos similares` — vectors.search sobre la imagen activa
- [ ] Dashboards visuales agregados (TodoERP report_configs ya soporta esto, pendiente diseñar)
- [ ] Auditoría visual de tool-calls del bot

### Fase 9 — endurecimiento y despliegue

- [x] Rate limit en login (express-rate-limit, 200/15min en DEVELOP)
- [x] STAGE-aware: dev relaja, prod cierra
- [x] CORS configurable (R10)
- [x] Privilege escalation prevention (R8 + assertCanGrant)
- [ ] Pseudoanonimización de prompts antes de mandar al LLM (la idea: agente sin perm `pii:read:*` recibe data ya redactada por R4 al tirar tools)
- [ ] Política de retención implementada vía reminders nocturnos (plantilla SQL documentada en `docs/OPERATIONS.md` §5; falta el job nocturno)
- [x] Backup automatizado de DB (scripts `backup-db.sh` + `backup-db.ps1`; instrucciones de cron/Task Scheduler en `docs/OPERATIONS.md` §4)
- [x] Documentación operacional (`docs/OPERATIONS.md`: topología, env, backup/restore, retención, runbook, hardening checklist)

---

## Tests

| Paquete | Archivos | Pruebas |
|---|---|---|
| `TodoERP/backend` | 32 | 181/181 ✅ |
| `cepi-frontend` | — | — (Vue, sin tests todavía) |
| `cepi-bot` | 3 | 21/21 ✅ |

Cero regresiones acumuladas a lo largo del refactor + Fase 1-6.

---

## Comandos del bot disponibles

```
/help | tools

# Lectura
whoami | definitions
pacientes | episodios | diagnósticos | revisiones | recordatorios
buscar paciente <texto>
cie10 <texto>
ver paciente | ver episodio | ver chatter | resumen
casos similares | sugerir diagnostico

# Contexto
activar paciente <uuid> | salir paciente
activar episodio <uuid> | salir episodio

# Escritura (todas detrás del gate sí/no)
nuevo episodio <motivo>
cerrar episodio [YYYY-MM-DD] [motivo]
diagnostico <CIE10> <descripción>
signs PA=120/80 FC=70 T=36.5 …
/escalar a <user-uuid> <razón>
nota <texto>
📎 imagen → clinical_image

# Reminders (directos, sin gate)
completar reminder <uuid> [nota]
cancelar reminder <uuid>
snooze reminder <uuid> YYYY-MM-DD

# Export
exportar [anonimizado]   → descarga JSON
```

**UX del frontend:**
- Botones de atajos en el panel lateral (incluyendo `bandeja revisión`, `casos similares`, `sugerir dx`, `recordatorios`, `⤓ exportar`).
- Drag-and-drop de imágenes sobre el chat.
- Botones inline `activar` en filas de listas de pacientes/episodios.
- Panel **Pendiente** con Confirmar/Cancelar para todas las acciones gate.
- Sidebar muestra nombre del paciente activo + UUID corto.
- Hidrata sesión completa al recargar la página (turnos + activos + pending).

---

## Próximos pasos sugeridos

1. **Levantar `cepi-isic` real** (requiere `apt install python3-venv` con sudo).
2. **DeepSeek API key** y `CEPI_LLM_PROVIDER=deepseek` para que el agente entienda lenguaje natural en lugar de solo comandos. Slot filling guiado emerge gratis.
3. **Pseudoanonimización pull**: que el agente use un JWT/api-key sin `pii:read:*` y reciba data ya redactada al jalar tools. Listo para la integración con DeepSeek.
4. **Dashboards supermédico**: aprovechar `report_configs` + frontend admin. Es DATA, no code.
5. **R5 Phase B**: rename de keys en `data` JSONB en una ventana de mantenimiento.

---

## Sesión 2026-05-15 — Ficha clínica, formularios del bot, ICD-11

### Formularios del bot (`BotForm`)
- Componente `cepi-frontend/src/components/BotForm.vue`: tipos de campo
  `text`, `textarea`, `checkbox`, `radio`, `heading`, `entity_search`.
- Envío estructurado (`submit_mode: 'structured'`) → `{ form_id, data }`.
- `EntitySearchField.vue`: autocompletado con lazy-load contra `/api/entities`
  (usa `filter[<col>]` para columnas UUID; `q` no las matchea).
- Búsqueda de paciente y alta de paciente como formularios en el chat.
- **El formulario activo se persiste en `extracted_slots.active_form`** de la
  sesión → sobrevive recarga y cambio de conversación, hasta que se llena.

### Ficha clínica (consulta)
- Modos: "Atención a paciente" abre episodio + ficha; "Información paciente"
  enlaza al último episodio (no presencial).
- Ficha §3-§7 como formularios por sección; cada submit hace `entities.update`
  del episodio.
- Visor de ficha (`docs/ficha.html`, servido en `cepi-frontend/public/`):
  modal con paginador entre episodios, Guardar (→ bot → paciente+episodio),
  etiquetas en rojo si el valor cambió vs la ficha anterior, regiones del
  cuerpo como toggles (multi-opción `regiones_afectadas`).
- Semáforo diagnóstico A/B/C en la barra superior del chat (`diagnostico_letra`).

### LLM
- Adapter `cepi-bot/src/llmClaudeCli.ts`: usa el CLI `claude` como LLM.
  Activar con `CEPI_LLM_PROVIDER=claude` (seteado en `ecosystem.config.cjs`).

### Integración ICD-11 (OMS)
- `cepi-bot/src/icdWho.ts`: cliente WHO ICD-11 (OAuth2 client-credentials,
  token cacheado) + búsqueda MMS.
- Endpoint `GET /api/bot/icd/search?q=` (proxy; el `client_secret` queda
  server-side).
- Credenciales en `cepi-bot/.env` (gitignored): `WHO_ICD_CLIENT_ID`,
  `WHO_ICD_CLIENT_SECRET` — registrarse en https://icd.who.int/icdapi.
- Campo §5 Diagnóstico de la ficha: autocompletado contra ICD-11.

### Seeders (TodoERP/database/medical-seed)
- `004_medical_fake_data.sql`: fix de claves `patient_id`/`episode_id` planas
  + `medico_id` (faltaban → rompía el seed).
- `006_icd10_dermatology.sql`: reescrito a forma columnar (la tabla tipada no
  tiene columna `data`).
- `001` (definición episodio) + `005` (form): campos de la ficha §3-§7,
  `diagnostico`, `diagnostico_letra`, `regiones_afectadas`.

### Pendiente / notas
- `reset-cepi.sh` no limpia registros `entity_*` reales (no-SEED) creados desde
  la app — se acumulan; conviene un TRUNCATE explícito de tablas tipadas.
- Bot proactivo con formularios dinámicos generados por LLM: planificado,
  no implementado.

### Ficha atómica + riel de bookmarks (continuación)

- La ficha se recorre como **grupos atómicos**: un campo = un formulario =
  un bookmark (`FICHA_FIELD_DEFS` → `FICHA_GROUPS` en `flowV1.ts`).
- **Riel de bookmarks** (`Chat.vue`) en el borde izquierdo del chat:
  - Agrupados por categoría (Filiación, Antecedentes, Anamnesis, Examen
    físico, Diagnóstico, Estudios, Tratamiento) con headers separadores.
  - Efecto **lupa** tipo Dock: el cursor agranda hasta 5 elementos
    (centro ±2); posiciones cacheadas, sólo se redibuja al cambiar de centro.
  - En reposo: tabs chicos, anclados a la derecha, metidos fuera del borde
    izquierdo; ancho = largo del texto (`min-width` = ancho del riel).
  - Completado (campo con valor) → transparente.
- Formularios cerrados (radio): seleccionar envía y avanza, sin botón Guardar.
  Botón **Omitir** en cada formulario. Formularios abiertos conservan Guardar.
- Al abrir un bookmark, el formulario llega **prellenado** con el valor
  actual del campo (`fichaGroupFormFilled`).
- `fichaBookmarks` calcula "completado" leyendo el valor real en la entidad
  (paciente/episodio), no sólo lo enviado en la sesión.
- Campos del paciente (§1-§2) se guardan en el paciente; §3-§7 en el episodio.
- `picor` / `dolor` pasaron a picklist (leve/moderado/severo) — definición,
  form_config y `ficha.html` actualizados.
- Ficha §4.4: `gravedad_total` (E+I+F) autocalculado, mostrado como
  "<n> Leve|Moderada|Grave".
- §5 Diagnóstico: autocompletado contra ICD-11 (OMS) en `ficha.html`.

### Ficha por ítems numerados + ajustes

- Los grupos/bookmarks de la ficha son los ítems numerados (1.1, 1.2, 3.1…),
  no las secciones — 23 grupos (`FICHA_GROUP_SPEC` en `flowV1.ts`).
- Riel de bookmarks: anclado a la derecha, ancho = largo del texto, lupa
  tipo Dock (5 elementos, optimizada con translateX/translateY).
- Formularios cerrados de una sola pregunta auto-envían; los agrupados
  conservan Guardar.
- Al enviar un formulario, el turno del usuario en el chat queda con el
  resumen (label: valor de cada campo).
- §1.2: Fecha de nacimiento (date picker `type:date`); la edad se autocalcula.
- §5 Diagnóstico: campo `icd_search` — autocompletado ICD-11 (OMS) también
  en el formulario del bot (`IcdSearchField.vue`), no sólo en `ficha.html`.
- `picor`/`dolor` y `escolaridad_grado` → picklists.

### Correcciones de ficha, formularios y UX móvil

- **Bot — formularios**: `proximo_control_fecha` con date picker; al guardar la
  ficha completa (`ficha_save`) los campos vacíos ya no sobrescriben datos
  guardados; botón "Omitir" reubicado al lado opuesto de "Guardar" para evitar
  clicks accidentales.
- **Bot — flujo de ficha**: `firstIncompleteFichaGroup()` — al activar/crear un
  paciente el bot arranca en el primer grupo incompleto y omite los ya
  completos (no vuelve a pedir, p.ej., datos de contacto ya cargados).
- **Pacientes**: se crean con `title = "Nombre Apellidos"` (antes
  `paciente_<cédula>`), así son ubicables por nombre en TodoERP.
- **Riel de bookmarks (móvil)**: la lupa funciona con touchmove y selecciona al
  levantar el dedo; el chat deja padding por el riel; el nombre del paciente no
  queda bajo el botón burger.
- **Header**: el semáforo A/B/C se refresca tras guardar un formulario.
- **Ficha (`ficha.html`)**: edad autocalculada desde fecha de nacimiento;
  selects de Picor/Dolor con tipografía uniforme y opciones (+)/(++)/(+++);
  los labels en rojo muestran "Valor anterior: …" al hover.

### Ficha §4.6/§4.7/§8 — mapa corporal e imágenes

- **§4.6 Regiones afectadas**: nuevo grupo `g_4_6` y nuevo tipo de campo
  `body_map`. El componente `BodyMapField.vue` replica las dos siluetas de
  `ficha.html` (`cuerpos.png` + 36 regiones, óvalos clicables); guarda
  `regiones_afectadas` como CSV de claves de región.
- **§4.7 Imágenes Lesión**: grupo `g_4_7`, tipo de campo `image_upload`
  (`ImageUploadField.vue`, subida múltiple vía `/api/attachments`). Al enviar,
  cada imagen pasa por `cepi-isic POST /inspect` (`imageInspect.ts`):
  - chequeo real de calidad — resolución (≥480px lado menor) e iluminación
    (brillo medio 40–220/255); las inadecuadas se omiten y el motivo se
    informa en el chat.
  - detección de rostro (OpenCV haar cascade) → el `clinical_image` se marca
    `privada: true` (campo nuevo en el `entity_definition`).
  - las adecuadas se crean con `embedding_status: 'pending'`; el worker
    `clinicalImageProcessor` ya existente las clasifica vía ISIC. Vinculadas a
    episodio y paciente.
- **§8 Imágenes Consentimiento**: grupo `g_8`; almacena cada imagen como un
  registro `consent` (`tipo: 'imagen_clinica'`) vinculado al paciente.
- Ambos grupos de imágenes pasan por el confirmation gate vía
  `pending_action.batch` (una creación por imagen, auditada en chatter).
- **cepi-isic**: nuevo endpoint real (no stub) `POST /inspect` — Pillow para
  dimensiones/brillo, OpenCV para rostro; dependencia `opencv-python-headless`.

### Auto-omisión de formularios ya completos

- `nextIncompleteFichaGroupId()` / `fichaGroupIsComplete()` en `flowV1.ts`: al
  avanzar la ficha (tras guardar u "Omitir") se salta a la siguiente sección
  **sin valor**, no a la siguiente en orden.
- Al reanudar una sesión (`GET /api/bot/session/:id`), si el formulario
  persistido apunta a un grupo ya completo (p.ej. `fecha_nac` cargada desde
  otra sesión sobre el mismo paciente), se auto-omite hacia el siguiente
  incompleto; si no, se refrescan sus valores desde la entidad.
