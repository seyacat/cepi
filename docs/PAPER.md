# Asistente Médico Conversacional sobre TodoERP

**Documento de proyecto — borrador 0.1**
**Fecha:** 2026-05-06
**Repositorio raíz:** `D:\cepi`
**Autor:** Equipo CEPI / Seyacat

---

## 1. Resumen ejecutivo

Construir un **asistente médico conversacional** que reduzca al mínimo la fricción de captura de datos clínicos. El médico habla con el bot durante (o después de) la consulta; el bot extrae información estructurada de manera incremental y la persiste en una base de datos clínica, sin pedirle nunca al médico que llene un formulario largo de una sola vez.

La plataforma de gestión y persistencia es **TodoERP** (sistema polimórfico ya existente, basado en `entity_definitions` + `entities` con `data` JSONB). El bot **no accede a la base de datos directamente**: TodoERP expone sus capacidades como un **servidor MCP** (Model Context Protocol), y el agente conversacional las consume como *tools*. Cualquier capacidad que falte se añade como nueva *tool* MCP.

Hay cinco roles: **guest, paciente, médico, supermédico, admin**. Cada rol determina qué *tools* del MCP puede invocar el agente y qué datos le devuelven.

---

## 2. Contexto y problema

### 2.1 Contexto

CEPI Centro de la Piel (cepi.ec) ya tiene un chatbot público de orientación dermatológica (`backend/server.js` actual, basado en DeepSeek + un árbol de decisión hardcodeado en `tree.js`). Es informativo, no clínico, y no persiste nada.

En paralelo existe **TodoERP** (`D:\cepi\TodoERP`), un ERP polimórfico con autenticación, permisos finos, formularios dinámicos (`form_configs`), adjuntos, chatter (feed de cambios + notas), accounting y traducciones. Está pensado para modelar entidades de cualquier tipo sin migraciones por cada dominio nuevo.

### 2.2 Problema

La carga de datos clínicos es la principal fuente de fricción en una consulta:

- Formularios extensos exigen que el médico interrumpa la atención para tipear.
- La estructura rígida no se adapta al ritmo natural del diálogo médico-paciente.
- Los datos relevantes para diagnóstico (anamnesis, signos, antecedentes, tratamientos previos) suelen aparecer dispersos en notas libres y no son consultables.
- El paciente repite información que ya dio en visitas anteriores.

### 2.3 Hipótesis

> Un agente conversacional con contexto del paciente activo, capaz de extraer y persistir slots clínicos de manera incremental sobre un modelo polimórfico flexible, puede reducir el tiempo de carga, mejorar la calidad estructurada del dato y evitar redundancia, **sin imponer un esquema rígido al médico**.

---

## 3. Objetivos

### 3.1 Objetivo general

Diseñar e implementar un asistente médico conversacional que use TodoERP como sistema de persistencia y gestión administrativa, exponiendo su funcionalidad vía MCP, con captura progresiva de datos clínicos de baja fricción.

### 3.2 Objetivos específicos

1. Modelar el dominio clínico (paciente, episodio, diagnóstico, examen, prescripción, imagen) sobre el sistema polimórfico de TodoERP.
2. Implementar un **servidor MCP** dentro de TodoERP que exponga lectura, escritura, búsqueda, adjuntos y consulta de definiciones como *tools* tipadas.
3. Construir un **agente conversacional** (LLM con tool-use) que mantenga contexto de paciente activo, haga *slot filling* incremental y persista por *tools* MCP.
4. Definir y aplicar la matriz de permisos para los cinco roles (guest, paciente, médico, supermédico, admin).
5. Cumplir con la **Ley Orgánica de Protección de Datos Personales del Ecuador (LOPDP)** y buenas prácticas equivalentes a HIPAA.
6. Dejar trazabilidad completa de toda interacción del bot (qué *tool* invocó, con qué argumentos, qué devolvió) usando el módulo Chatter ya existente.

---

## 4. Alcance

### 4.1 Dentro del alcance (v1)

- Especialidad piloto: **dermatología** (alineado con CEPI), extensible.
- Roles: guest, paciente, médico, supermédico, admin (los cinco mencionados).
- Idiomas: **español** primero; inglés a través del módulo de traducciones existente.
- Captura por chat de: motivo de consulta, anamnesis dirigida, exploración (descripción + fotos), diagnóstico presuntivo, plan, prescripción libre.
- Subida de imágenes clínicas vinculadas al episodio (módulo de attachments existente).
- Historial completo del paciente con vista cronológica (Chatter + lista de episodios).
- Auditoría: cada acción del bot deja entrada en Chatter del paciente / episodio.

### 4.2 Fuera del alcance (v1)

- **Diagnóstico autónomo**: el bot **nunca** emite un diagnóstico definitivo. Sugiere y deja al médico la decisión.
- Integración con sistemas externos (HL7/FHIR, laboratorios reales, e-prescripción legal).
- Análisis de imagen por IA (clasificador dermatológico). Las fotos se almacenan; no se procesan automáticamente en v1.
- Telemedicina con video en tiempo real.
- Facturación clínica (pero TodoERP ya tiene módulo accounting, queda como extensión).

---

## 5. Stakeholders y roles

| Rol | Quién es | Qué hace en el sistema |
|---|---|---|
| **Guest** | Visitante anónimo | Consulta el bot público de orientación (lo que ya existe), accede a formularios públicos (e.g., pre-registro). Sin persistencia salvo la solicitud. |
| **Paciente** | Persona registrada | Conversa con el bot para autollenar antecedentes, alergias, medicación; agenda; ve su propia ficha y consultas pasadas; mensajería con su médico. |
| **Médico** | Profesional asignado | Conversa con el bot durante/después de consulta para registrar episodio; ve y edita las fichas de **sus** pacientes; sube imágenes; firma diagnóstico y plan. |
| **Supermédico** | Médico senior / supervisor | Lee toda la base clínica; revisa, comenta o sobrescribe diagnósticos de otros médicos; dashboards agregados; auditoría clínica. |
| **Admin** | Operador del sistema | Gestión de usuarios, roles, configuraciones de formularios, traducciones, auditoría técnica. **No** debe poder leer datos clínicos por defecto (separación de roles administrativo / clínico). |

> **Decisión abierta D-1:** ¿el admin puede ver datos clínicos? Recomendación: no por defecto, con permiso explícito y auditoría.

---

## 6. Arquitectura general

```
┌───────────────────────────────────────────────────────────────┐
│                  Frontend (Vue 3 + Vite)                      │
│  - UI de chat (basada en frontend/ actual)                    │
│  - UI administrativa de TodoERP (frontend de TodoERP)         │
└─────────────────┬─────────────────────────┬───────────────────┘
                  │  HTTP / SSE             │  HTTP (REST clásico)
                  ▼                         ▼
┌─────────────────────────────────────┐  ┌─────────────────────┐
│      Servicio del Agente            │  │  TodoERP Backend    │
│      (cepi-bot, Node.js)            │  │  (Express + JWT)    │
│  - Recibe mensajes del usuario      │  │  - Auth, CRUD, etc. │
│  - LLM con tool-use                 │  │  - REST API actual  │
│  - Cliente MCP                      │  │                     │
└──────────────┬──────────────────────┘  └──────────┬──────────┘
               │ MCP (stdio o HTTP)                 │
               ▼                                    │
┌──────────────────────────────────────┐            │
│   TodoERP MCP Server (NUEVO)         │            │
│   - Tools: get_patient, upsert_*,    │            │
│     search, attachments, etc.        │            │
│   - Reusa servicios y middleware     │◄───────────┘
│     existentes de TodoERP            │   acceso compartido
└──────────────┬───────────────────────┘
               ▼
        ┌──────────────────┐
        │   PostgreSQL     │
        │   (TodoERP DB)   │
        └──────────────────┘
```

### Tres procesos lógicos

1. **TodoERP Backend** (existente, `TodoERP/backend`): API REST, autenticación, permisos. No se reescribe; se extiende.
2. **TodoERP MCP Server** (nuevo, `TodoERP/mcp/`): proceso que expone capacidades de TodoERP como *tools* MCP. Reutiliza los servicios y middleware de auth/permisos del backend.
3. **Agente médico (cepi-bot)** (`backend/` actual evoluciona): orquesta el LLM, gestiona contexto de conversación, llama *tools* MCP. El frontend de chat se conecta a este servicio.

### ¿Por qué MCP?

- **Reutilización**: cualquier cliente MCP (Claude Desktop, Claude Code, otros agentes futuros) puede operar TodoERP con las mismas *tools*.
- **Aislamiento**: el bot no necesita credenciales de DB; toda autorización pasa por el MCP, que reutiliza la matriz de permisos de TodoERP.
- **Tipado**: cada *tool* MCP declara su *schema* JSON, lo que el LLM aprovecha para llamadas correctas y validación.
- **Auditoría centralizada**: cada *tool call* se loguea en Chatter con autor, argumentos y resultado.

---

## 7. Reutilización de TodoERP y principio de generalidad

### 7.1 Principio de generalidad (no negociable)

**TodoERP es un ERP genérico**. Todo lo que se le añada en este proyecto debe mantener ese carácter. El conocimiento del dominio médico **no vive** en el código de TodoERP ni en las *tools* del MCP. Vive en:

- Las `entity_definitions` y sus `form_configs` (datos de configuración, no código).
- Los scripts de seed médicos (`004_medical_seed.sql`).
- El agente médico (`cepi-bot`), que traduce intenciones clínicas a operaciones genéricas.

TodoERP **no debe tener** tablas, columnas, rutas REST ni *tools* MCP cuyos nombres o lógica presupongan "paciente", "episodio", "diagnóstico". Cualquier feature funcional añadida (alertas, vectores, clasificación de imágenes) se diseña como **capacidad transversal** del ERP, reutilizable por cualquier dominio futuro (logística, RRHH, educación, etc.).

Operativamente: si una feature se nombra `medical_*` o se documenta como "para clínicas", está mal modelada. Hay que rediseñarla en abstracto.

### 7.2 Lo que se reutiliza tal cual

| Capacidad TodoERP | Componente | Uso del lado del agente médico |
|---|---|---|
| Tablas polimórficas | `entity_definitions`, `entities`, `data JSONB` | Cada entidad clínica es una entity_definition; cada registro va en `entities` |
| Formularios dinámicos | `form_configs` + `DynamicFormRenderer.vue` | Vistas administrativas de paciente, episodio, prescripción |
| Permisos resource:action | `roles`, `permissions`, `role_permissions` + `hasPermission` middleware | Matriz médica (ver §13), construida con permisos genéricos |
| Adjuntos con dedup SHA256 | `attachments` + `AttachmentsGallery.vue` | Fotos clínicas, informes |
| Chatter (feed de cambios + notas) | `chatter` + `Chatter.vue` | Trazabilidad clínica + auditoría del bot |
| Relaciones entre entidades | `entity_relationships` | Paciente↔Episodio, Episodio↔Diagnóstico, Médico↔Paciente |
| Índices por campo | `indexSyncService` | Búsqueda rápida por cédula, email, fecha |
| Traducciones dinámicas | `translations` table + i18n | Soporte multi-idioma del UI |
| Formularios públicos (guest) | `publicFormsRouter` + API keys | Autoatención del rol guest |

### 7.3 Capacidades nuevas y genéricas que TodoERP debe ganar

Tres bloques de funcionalidad que actualmente faltan en TodoERP. Se diseñan **sin ninguna referencia médica**, y luego el agente las usa para casos clínicos.

#### 7.3.1 Servidor MCP de TodoERP (genérico)

Detallado en §8. Expone CRUD, búsqueda, relaciones, adjuntos, chatter, alertas y vectores como *tools* sobre cualquier `entity_definition`.

#### 7.3.2 Sistema de alertas y recordatorios (genérico)

Detallado en §9. Programador de eventos asociables a cualquier `entities.id` con disparadores temporales o por condición; canales de entrega plugables (in-app, email, webhook, push); recurrencia opcional; cierre/cancelación con resultado.

Casos de uso médicos típicos (no exclusivos):
- Recordar al paciente una toma de medicación.
- Recordar al médico revisar control en N días.
- Repreguntar al paciente por evolución 7 días después del episodio.
- Avisar al supermédico si hay diagnósticos sin aprobar.

Casos de uso no médicos (pruebas de generalidad):
- Recordar vencimiento de factura, renovación de suscripción, cumpleaños de cliente, renovación de contrato.

#### 7.3.3 Vector store + clasificación de entidades (genérico)

Detallado en §10. Extensión `pgvector` en Postgres; tablas `vector_embeddings` y `entity_classifications` referenciables desde cualquier entidad; *tools* MCP de upsert, k-NN, set/get classification, vinculación con un `model_id` declarado en una nueva tabla `models_registry`.

Casos de uso médicos típicos:
- Embeddings de imágenes de lesiones para "casos similares".
- Clasificaciones por modelos ISIC (ver §10).

Casos de uso no médicos:
- Búsqueda semántica de documentos, productos, candidatos a un puesto, etc.

### 7.4 Lo que **no** se añade a TodoERP (vive en el agente o en datos)

- Vocabulario médico (paciente, anamnesis, signos vitales, CIE-10): vive en seed como `entity_definitions` y en el agente como prompts y heurísticas.
- Modelos de IA específicos (ISIC, vademécum, dermNet): el agente los consume; TodoERP solo guarda el resultado vía las *tools* genéricas de classification y vectors.
- Reglas de negocio clínicas (qué slot es crítico, cuándo escalar al supermédico): viven en el agente.

> Regla práctica: si añades algo a TodoERP, debe poder usarse mañana para gestionar inventario o nóminas sin cambios de código.

---

## 8. Servidor MCP de TodoERP

### 8.1 Ubicación y stack

- Carpeta: `TodoERP/mcp/`
- Stack: TypeScript, paquete `@modelcontextprotocol/sdk` (servidor stdio + opcional HTTP/SSE para uso remoto).
- Reutiliza el **pool de Postgres** y los servicios de `TodoERP/backend/src/services/` (mover a `shared/` si es necesario).
- Autenticación: el servidor MCP requiere un **token de servicio** (API key con rol asignado) o un JWT de usuario por *call*; sin auth, ninguna *tool* responde con datos.

### 8.2 Catálogo de tools — todas genéricas

Naming: `<recurso>.<acción>`. **Ningún nombre de tool contiene términos del dominio médico**. El agente compone intenciones clínicas a partir de estas operaciones genéricas, pasando el `definition_slug` apropiado (`patient`, `episode`, etc.) en cada llamada.

#### Identidad y contexto
- `auth.whoami` → usuario actual y permisos efectivos
- `auth.set_active_context(key, value)` → fija contexto arbitrario en la sesión (e.g., `key="patient", value=<id>`); el agente decide qué claves usa

#### Definiciones de entidad
- `definitions.list({ active? })` → lista de tipos disponibles
- `definitions.describe(slug)` → schema de campos actual; el agente lo lee al inicio para saber qué slots tiene cada tipo
- `definitions.required_fields(slug)` → campos obligatorios

#### Entidades (CRUD genérico)
- `entities.create(slug, data, parent_id?)`
- `entities.get(id, { include_relations?, include_attachments? })`
- `entities.update(id, partial_data)` → merge JSONB no destructivo
- `entities.delete(id)` (soft delete)
- `entities.search({ slug?, filters?, query?, limit, offset })` → búsqueda general; el `query` puede dispararse por full-text o vector si el slug tiene embeddings configurados
- `entities.list_children(parent_id, slug?)` → siguiendo `parent_id`
- `entities.list_by_relation(source_id, field_key)` → siguiendo `entity_relationships`

#### Relaciones
- `relations.add(source_id, target_id, field_key)`
- `relations.remove(source_id, target_id, field_key)`
- `relations.list(entity_id, { field_key?, direction? })`

#### Adjuntos
- `attachments.upload(entity_id, field_key, file_metadata)` → metadata; el binario sube por REST aparte (el frontend ya lo hace contra `/api/attachments`)
- `attachments.list({ entity_id?, field_key? })`
- `attachments.delete(id)`

#### Chatter (auditoría y notas)
- `chatter.add_note(entity_id, body, parent_id?)`
- `chatter.list(entity_id)`
- `chatter.log_action(entity_id, { actor, action, payload })` → la usa el bot para registrar cada acción suya

#### Recordatorios (capacidad genérica nueva, ver §9)
- `reminders.create({ entity_id?, due_at, message, channel?, recurrence?, condition? })`
- `reminders.list({ entity_id?, status?, due_before?, owner? })`
- `reminders.complete(id, { result? })`
- `reminders.cancel(id)`
- `reminders.snooze(id, until)`

#### Vectores y clasificaciones (capacidad genérica nueva, ver §10)
- `models.list({ kind? })` → modelos registrados (text-embedder, image-embedder, image-classifier)
- `vectors.upsert(entity_id, field_key, embedding, model_id, metadata?)`
- `vectors.search({ embedding | text | entity_id, model_id, k, filter? })` → k-NN con filtros sobre metadata
- `classifications.set(entity_id, model_id, { labels[], confidence, raw? })`
- `classifications.get(entity_id, { model_id? })`

### 8.3 JSON Schema por tool

Cada *tool* declara `inputSchema` y `outputSchema` (requisito del MCP SDK). Esto guía al LLM y evita argumentos malformados. Para tools genéricas como `entities.update`, el `inputSchema` no enumera campos por *slug*: simplemente declara que `partial_data` es objeto libre. El **schema específico** del dominio médico vive en `definitions.describe(slug)`, que el agente carga al iniciar conversación y usa para guiar el slot-filling.

### 8.4 ¿Qué hacer si falta una tool?

Si la conversación requiere algo no cubierto, se implementa la tool en el MCP **antes** de avanzar el agente — y se diseña genéricamente. Antes de añadir una tool, hacer la prueba: *¿podría usarse esta misma tool para gestionar facturas o tickets de soporte?* Si no, está mal modelada.

Bypass directo al backend o a la DB desde el agente: prohibido. Toda mutación pasa por el MCP para garantizar auditoría y autorización centralizadas.

### 8.5 Cómo el agente compone intenciones médicas

Ejemplos de "intención clínica → llamada genérica":

| Intención del agente médico | Tool MCP genérica que invoca |
|---|---|
| "Crear paciente" | `entities.create("patient", {...})` |
| "Buscar paciente por cédula" | `entities.search({ slug: "patient", filters: { cedula: "..." } })` |
| "Iniciar episodio" | `entities.create("episode", { ... }, parent_id: <patient_id>)` + `relations.add(...)` |
| "Anotar anamnesis" | `entities.update(<episode_id>, { anamnesis: "..." })` |
| "Marcar diagnóstico" | `entities.create("diagnosis", { episode_id, codigo, ... })` |
| "Recordar control en 14 días" | `reminders.create({ entity_id: <episode_id>, due_at: +14d, message: "..." })` |
| "Buscar imágenes parecidas" | `vectors.search({ entity_id: <image_id>, model_id: "isic-resnet50", k: 10 })` |
| "Guardar predicción ISIC" | `classifications.set(<image_id>, "isic-resnet50", { labels, confidence })` |

---

## 9. Sistema de alertas y recordatorios (capacidad nueva, genérica)

### 9.1 Por qué

El bot debe permitir al médico dar **seguimiento** real al paciente: recordar revisiones, repreguntar evolución, avisar de hallazgos pendientes. Hoy TodoERP no tiene esta capacidad; se diseña ahora como módulo genérico del ERP, reutilizable para vencimientos contables, cumpleaños de cliente, renovación de contratos, etc.

### 9.2 Modelo de datos

**Tabla nueva `reminders`** (genérica, no en `entities`):

```sql
CREATE TABLE reminders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID REFERENCES entities(id) ON DELETE CASCADE,  -- opcional: anclado o no
    owner_user_id   UUID REFERENCES users(id) ON DELETE CASCADE,     -- a quién se le recuerda
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    title           VARCHAR(500) NOT NULL,
    message         TEXT,
    due_at          TIMESTAMPTZ NOT NULL,
    recurrence      JSONB,           -- { rule: 'rrule:...', until: ... }
    condition       JSONB,           -- opcional: condición que debe cumplirse para disparar
    channels        JSONB DEFAULT '["in_app"]',  -- array: in_app | email | webhook | push
    status          VARCHAR(50) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','snoozed','sent','done','cancelled','failed')),
    result          TEXT,            -- al completar, qué pasó
    last_attempt_at TIMESTAMPTZ,
    sent_at         TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reminders_due_pending ON reminders(due_at) WHERE status='pending';
CREATE INDEX idx_reminders_owner ON reminders(owner_user_id, status);
CREATE INDEX idx_reminders_entity ON reminders(entity_id);
```

`entity_id` es opcional: un recordatorio puede estar anclado a una entidad (un episodio, una factura) o ser libre ("llamar a María a las 17h").

### 9.3 Componentes

| Componente | Responsabilidad |
|---|---|
| **Tabla `reminders`** | Almacenamiento. |
| **Scheduler** (proceso interno backend) | Cada N segundos consulta `due_at <= NOW() AND status='pending'`; entrega a los canales; marca `sent`. |
| **Drivers de canal** | `in_app` (escribe a `chatter` o cola por usuario), `email` (SMTP), `webhook` (POST a URL configurada), `push` (Web Push si frontend lo habilita). |
| **API REST** (en TodoERP) | CRUD `/api/reminders`. |
| **Tools MCP** | `reminders.create`, `list`, `complete`, `cancel`, `snooze` (ya en §8.2). |
| **UI** | Panel "Mis recordatorios" en el sidebar; marca de pendientes en cada entidad relacionada. |

### 9.4 Recurrencia y condiciones

- **Recurrencia**: subset de RRULE (RFC 5545). Suficiente con: diario, semanal, mensual, "cada N días/semanas". Implementación: librería liviana (`rrule` en npm) o regla propia minimal.
- **Condición**: JSONB con expresión simple evaluable contra los datos de la entidad (e.g., `{ field: "estado", op: "eq", value: "pendiente" }`). Si la condición no se cumple cuando llega el `due_at`, el recordatorio se reagenda.

### 9.5 Permisos (genéricos)

- `reminders:create`, `reminders:read_own`, `reminders:read_all`, `reminders:complete`, `reminders:cancel`.
- El agente médico, al actuar en nombre del médico, hereda los permisos de éste.

### 9.6 Uso desde el agente médico (ejemplos)

- **Tras cerrar episodio**: bot llama `reminders.create({ entity_id: <episode_id>, owner_user_id: <medico_id>, due_at: now+14d, title: 'Control', message: 'Verificar evolución de X' })`.
- **Si el paciente no responde a control**: una segunda regla con `condition` chequea si hubo nuevo episodio; si no, dispara aviso al médico.
- **Toma de medicación**: si el paciente acepta, recordatorios diarios con canal `push` durante la duración del tratamiento.

> **Decisión abierta D-9:** ¿qué canales habilitamos en v1? Recomendación: `in_app` siempre, `email` opcional. Push y webhook en v2.

---

## 10. Vector store y clasificación de entidades (capacidad nueva, genérica)

### 10.1 Por qué

Las imágenes clínicas (en dermatología, fotos de lesiones) deben:
1. Ser **clasificables** por uno o varios modelos de identificación de patrones (ISIC, melanoma vs. nevus, dermatitis, etc.).
2. Ser **comparables** vía similitud para encontrar casos parecidos en la base.

Esto exige guardar embeddings (vectores) y predicciones (clasificaciones) por imagen, vinculadas al modelo que las generó. Diseño genérico: cualquier entidad —no solo imágenes, también textos, documentos— puede tener vectores y clasificaciones.

### 10.2 Modelo de datos

**Extensión Postgres**: `pgvector`.

**Tabla `models_registry`** (genérica):

```sql
CREATE TABLE models_registry (
    id              VARCHAR(128) PRIMARY KEY,        -- ej: 'isic-resnet50-v1', 'openai-text-embedding-3-small'
    kind            VARCHAR(50) NOT NULL             -- 'text-embedder' | 'image-embedder' | 'image-classifier' | 'text-classifier'
                    CHECK (kind IN ('text-embedder','image-embedder','image-classifier','text-classifier','multimodal')),
    title           VARCHAR(500) NOT NULL,
    description     TEXT,
    dimensions      INTEGER,                          -- para embedders
    labels          JSONB,                            -- para classifiers: { code: human_label }
    config          JSONB DEFAULT '{}',               -- endpoint, version, etc.
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Tabla `vector_embeddings`** (genérica):

```sql
CREATE TABLE vector_embeddings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    field_key       VARCHAR(255),                     -- opcional: qué campo de la entidad embeddió
    model_id        VARCHAR(128) NOT NULL REFERENCES models_registry(id) ON DELETE CASCADE,
    embedding       vector NOT NULL,                  -- pgvector, dimensión definida por el modelo
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(entity_id, field_key, model_id)
);
-- Index HNSW por modelo para búsquedas rápidas:
-- CREATE INDEX ... ON vector_embeddings USING hnsw (embedding vector_cosine_ops) WHERE model_id = 'X';
-- Nota: pgvector exige el mismo número de dimensiones por índice; en la práctica creamos un índice por modelo.
```

**Tabla `entity_classifications`** (genérica):

```sql
CREATE TABLE entity_classifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    model_id        VARCHAR(128) NOT NULL REFERENCES models_registry(id) ON DELETE CASCADE,
    labels          JSONB NOT NULL,                   -- [{label, confidence}, ...]
    raw             JSONB,                            -- respuesta cruda del modelo
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(entity_id, model_id)
);
```

### 10.3 Integración con modelos ISIC

ISIC (International Skin Imaging Collaboration) ofrece datasets y modelos para clasificación de lesiones de piel (HAM10000, SLICE-3D, etc.). Estrategia:

| Aspecto | Decisión |
|---|---|
| **¿Entrenar nosotros un modelo?** | No en v1. Tomamos modelos pre-entrenados publicados por ISIC u otros (ResNet50/EfficientNet sobre HAM10000) o servicios hospedados. |
| **Hospedaje** | Servicio Python aparte (FastAPI) corriendo el modelo en GPU/CPU; expone POST `/embed` y `/classify`. Si no hay GPU, modelo más liviano (MobileNet) en CPU. |
| **Llamada** | El backend de TodoERP, al recibir un upload con `field_key='clinical_image'`, dispara un job que llama al servicio Python; al volver, el job hace `vectors.upsert` y `classifications.set`. |
| **Modelos múltiples** | Cada imagen puede pasar por varios modelos a la vez. Se registran como `model_id` distintos. |
| **Etiquetas** | Las etiquetas de los modelos ISIC (melanoma, nevus, BCC, AK, etc.) se cargan en `models_registry.labels`. |
| **Privacidad** | Si se usa servicio externo, las imágenes salen sin metadata clínica (solo el binario). Auditoría de cada llamada. |
| **Investigación pendiente** | Confirmar disponibilidad de pesos open-source actualizados (ISIC 2024/2025 challenges). Workshop ISIC 2026 puede aportar modelos nuevos. |

> **Decisión abierta D-10:** ¿modelo de imagen on-prem o servicio externo? Trade-off: privacidad/coste vs. complejidad de despliegue. Recomendación: empezar con modelo open-source liviano on-prem; subir a servicio gestionado si la calidad no alcanza.
>
> **Decisión abierta D-11:** ¿qué tareas de clasificación priorizamos en v1? Recomendación: triage binario "sospecha alta / no" (melanoma / no melanoma) + multiclase top-5 informativo. No reemplaza al médico; ayuda al triage.

### 10.4 Flujo de procesamiento de imagen

1. Médico/paciente sube imagen → `attachments` (TodoERP) + se crea entidad `clinical_image` ligada al episodio.
2. Job en cola (BullMQ o similar) procesa la imagen:
   a. Pre-procesa (resize, normalización).
   b. Llama al servicio del modelo → recibe embedding + labels.
   c. `vectors.upsert(<image_id>, 'image', embedding, 'isic-resnet50')`.
   d. `classifications.set(<image_id>, 'isic-resnet50', { labels, confidence })`.
   e. Si confidence > umbral en clase "sospecha alta", crea `reminders` para supermédico (escala automáticamente).
3. El bot, al hablar de la imagen, lee `classifications.get` y lo presenta al médico **como sugerencia, no diagnóstico**.

### 10.5 Búsqueda de casos similares

Médico pregunta: *"¿Tenemos casos similares a esta lesión?"*. Bot llama `vectors.search({ entity_id: <image_id>, model_id: 'isic-resnet50', k: 10, filter: { ... } })`. Devuelve imágenes similares; el bot las muestra **anonimizadas** (no se revelan pacientes de otros médicos sin permiso).

Permisos: la búsqueda respeta visibilidad. Resultados de pacientes que el médico no puede ver salen sin metadata identificadora (modo "caso académico").

### 10.6 Permisos (genéricos)

- `vectors:search`, `vectors:write`, `classifications:write`, `classifications:read`.
- `models:manage` (admin).

---

## 11. Modelo de datos clínico

Todas las entidades viven como `entity_definitions` (slug + config) y registros en `entities` (`data` JSONB). UUIDs prefijados para identificación visual:

| `slug` | Prefijo UUID | Descripción |
|---|---|---|
| `patient` | `m1000000-…` | Paciente |
| `episode` | `m2000000-…` | Episodio / consulta |
| `diagnosis` | `m3000000-…` | Diagnóstico (puede haber 1..N por episodio: presuntivo, diferencial, definitivo) |
| `prescription` | `m4000000-…` | Prescripción |
| `lab_order` | `m5000000-…` | Orden de laboratorio / examen complementario |
| `clinical_image` | `m6000000-…` | Foto clínica (registro lógico; el binario va en `attachments`) |
| `bot_session` | `m7000000-…` | Sesión de chat (turnos, slots, paciente activo) |

### 11.1 Paciente — campos sugeridos (`data` JSONB)

Identidad: `nombre`, `apellidos`, `cedula` (único, con índice), `fecha_nac`, `sexo`, `email`, `telefono`, `direccion`.
Médicos: `tipo_sangre`, `alergias[]`, `medicacion_actual[]`, `antecedentes_personales`, `antecedentes_familiares`, `habitos` (tabaco, alcohol, etc.), `seguro_medico`.
Sistema: `medico_principal_id` (rel), `consentimientos[]` (LOPDP, fotos, etc.), `notas_internas`.

> **Decisión abierta D-2:** ¿qué campos son obligatorios al registrar un paciente? Recomendación: solo `nombre` + `cedula` o `email`. El resto se completa por chatbot a lo largo de visitas.

### 11.2 Episodio — campos sugeridos

`patient_id` (rel), `medico_id` (rel), `fecha`, `tipo` (presencial/virtual), `motivo_consulta`, `anamnesis`, `signos_vitales` (presión, FC, FR, temp, SatO2, peso, talla), `examen_fisico`, `imagenes[]` (rel a `clinical_image`), `diagnostico_principal_id` (rel a `diagnosis`), `diagnosticos_diferenciales[]`, `plan`, `prescripcion_ids[]`, `seguimiento`, `proximo_control_fecha`, `proximo_control_motivo`, `reminder_ids[]` (rel a `reminders`), `estado` (en_curso, cerrado, en_revisión).

> Los campos de seguimiento (`proximo_control_*`, `reminder_ids`) son **datos**, no código de TodoERP. El agente los completa al cerrar el episodio y crea los `reminders` correspondientes vía la *tool* genérica.

### 11.3 Diagnóstico

`episode_id`, `tipo` (presuntivo/diferencial/definitivo), `codigo_cie10`, `descripcion`, `confianza` (0..1), `notas`, `revisado_por` (rel a supermédico), `aprobado_at`.

### 11.4 Imagen clínica (`clinical_image`)

Entidad lógica que envuelve una imagen subida al sistema y centraliza su clasificación:

- `episode_id` (rel), `patient_id` (rel), `attachment_id` (referencia al binario en `attachments`).
- `field_key`: identifica qué tipo de imagen (lesión, dermatoscopia, panorámica, ambiente).
- `body_region`, `lesion_id` (si la lesión se está siguiendo en el tiempo, se mantiene el mismo `lesion_id` entre fotos sucesivas).
- `consentimiento_uso_imagen`: bool.
- `classification_ids[]`: poblado automáticamente cuando el job de §10.4 termina; cada uno apunta a un registro en `entity_classifications`.
- `embedding_status`: `pending | done | failed`.

Búsqueda visual: el bot puede invocar `vectors.search` pasando un `clinical_image.id` y obtener IDs de imágenes similares en la base, respetando permisos.

### 11.5 Bot session

Por cada conversación: `user_id`, `active_patient_id`, `active_episode_id`, `turns[]`, `extracted_slots` (lo que ya se rellenó), `pending_slots` (lo que aún falta), `tool_calls[]`. Sirve para reanudar y para entrenar/auditar.

### 11.6 Asignación médico↔paciente y seguimiento

- Relación primaria: campo `medico_principal_id` en paciente.
- Relación de cobertura: cada episodio enlaza `medico_id`; el médico que ha atendido un episodio gana lectura sobre ese episodio aunque no sea el principal.
- Pacientes "sin médico asignado" caen en una bandeja del supermédico.
- Equipos: opcional vía `entity_relationships` con `field_key='medico_secundario'`.

---

## 12. Diseño del chatbot conversacional

### 12.1 Arquitectura del agente

El bot es un **agente con tool-use**:
1. Recibe el último mensaje del usuario + historial.
2. Carga contexto: rol, paciente activo, episodio en curso, definiciones de entidad relevantes (vía `entity_definitions.describe`).
3. Construye prompt con: rol del usuario, contexto del paciente, esquema de slots pendientes, *tools* MCP disponibles.
4. LLM decide: ¿responder en lenguaje natural? ¿llamar una *tool*? ¿pedir un slot faltante? ¿no hacer nada y devolver pregunta?
5. Ejecuta *tool calls* contra el servidor MCP. Reinyecta resultados al LLM.
6. Devuelve respuesta final por SSE al frontend.

### 12.2 Política de baja fricción (slot filling progresivo)

Reglas del prompt del sistema:

- **Una sola pregunta por turno** (salvo síntesis final).
- **Prioriza** lo que cambia el diagnóstico, no lo que llena el formulario.
- **Confirma antes de persistir** datos sensibles (alergia nueva, medicación, diagnóstico).
- **Nunca repreguntes** lo ya contestado (releer `data` del episodio vía `entities.get(<episode_id>)` antes de preguntar).
- **No bloqueas** la conversación si falta un slot opcional: lo dejas y avanzas.
- **Persiste por incrementos**: cada vez que extraes un dato, llamas `entities.update(<episode_id>, { campo: valor })`. No esperas a tener todo.

### 12.3 Modos por rol

| Rol del usuario | Modo del bot | Comportamiento |
|---|---|---|
| Guest | Informativo público | Como `server.js` actual: orientación, agendamiento, sin persistencia |
| Paciente | Autollenado guiado | Pregunta antecedentes, alergias, medicación; resume; pide consentimientos; agenda; mensajería con su médico |
| Médico | Asistente clínico | Toma dictado del médico, extrae anamnesis/examen/diagnóstico, persiste en episodio activo, busca pacientes, sube imágenes |
| Supermédico | Revisor | Resume episodios, lista pendientes de revisión, permite anotar/comentar, ver dashboards |
| Admin | Soporte operativo | No accede a datos clínicos por defecto; ayuda con configuración, usuarios, traducciones |

### 12.4 Contexto del paciente

Mecanismo:
- En cada sesión, el bot mantiene `active_patient_id` y `active_episode_id`.
- Para el médico: al iniciar conversación, el frontend manda el paciente seleccionado de la UI; o el bot llama `entities.search({ slug: "patient", query: "..." })` y confirma con el médico.
- Para el paciente: el `active_patient_id` es siempre el propio (no negociable).
- Cualquier *tool call* que reciba `patient_id` distinto al activo y el rol no lo permita → 403 desde el MCP.

### 12.5 Manejo de imágenes

- En modo médico, el chat permite adjuntar fotos (input nativo en frontend).
- El frontend sube el archivo vía REST de TodoERP (`POST /api/attachments`) con `entity_id` = episodio y `field_key` = `imagenes`.
- El bot recibe del frontend la metadata del adjunto y registra una nota tipo `change` en el chatter del episodio: *"Médico subió imagen X"*.
- Las imágenes son **siempre** ligadas a un episodio + paciente; nunca sueltas.

### 12.6 Streaming y latencia

Mantener el streaming SSE actual. Las *tool calls* **no** se streamean al usuario; se muestran como estado intermedio (`status: 'consultando ficha…'`) y la respuesta final sí se streamea.

### 12.7 LLM

- Mantener compatibilidad con varios proveedores (DeepSeek ya configurado, NVIDIA, NaN). El `.env` actual ya soporta `AI_PROVIDER`.
- Requisito: el modelo elegido debe soportar **tool calling** correctamente en el formato OpenAI-compatible. DeepSeek lo soporta. Validar antes de comprometer.

> **Decisión abierta D-3:** modelo final para producción. Trade-off: latencia (DeepSeek bajo, Claude alto) vs. calidad de tool-use (Claude alto). Recomendación: DeepSeek para v1, abstraer detrás de interfaz.

---

## 13. Roles, permisos y seguridad

### 13.1 Matriz de permisos (resumen)

| Recurso/acción | guest | paciente | médico | supermédico | admin |
|---|:---:|:---:|:---:|:---:|:---:|
| `patient:read_own` | — | ✓ | — | ✓ | — |
| `patient:read_assigned` | — | — | ✓ | ✓ | — |
| `patient:read_all` | — | — | — | ✓ | — |
| `patient:create` | — | — | ✓ | ✓ | ✓ |
| `patient:update_own` | — | ✓ (campos limitados) | — | ✓ | — |
| `patient:update_assigned` | — | — | ✓ | ✓ | — |
| `episode:create` | — | — | ✓ | ✓ | — |
| `episode:read_own_patient` | — | ✓ | — | ✓ | — |
| `episode:read_assigned` | — | — | ✓ | ✓ | — |
| `episode:update_assigned` | — | — | ✓ | ✓ | — |
| `episode:override` (sobrescribir trabajo de otro médico) | — | — | — | ✓ | — |
| `diagnosis:write` | — | — | ✓ | ✓ | — |
| `diagnosis:approve` | — | — | — | ✓ | — |
| `attachment:upload` | — | ✓ (su ficha) | ✓ | ✓ | — |
| `attachment:read_clinical` | — | ✓ (suyas) | ✓ (asignadas) | ✓ (todas) | — |
| `prescription:write` | — | — | ✓ | ✓ | — |
| `chat:bot` (puede usar el bot) | ✓ (modo guest) | ✓ | ✓ | ✓ | ✓ (modo admin) |
| `bot:audit:read` | — | — | — | ✓ | ✓ |
| `users:manage` | — | — | — | — | ✓ |
| `roles:manage` | — | — | — | — | ✓ |
| `forms:manage` | — | — | — | — | ✓ |

> *Asignación médico↔paciente*: campo `medico_principal_id` en paciente, **además** de relaciones por episodio (un médico que ha atendido un episodio gana lectura sobre ese episodio).

### 13.2 Mecanismo de autorización

- Se reutiliza `hasPermission` de TodoERP (`authMiddleware.ts`).
- El servidor MCP recibe el JWT/API key del usuario, resuelve su rol, y para cada *tool call* aplica el chequeo correspondiente.
- Para `read_assigned` se usa `entity_relationships` (médico → paciente) o el campo `medico_principal_id`.
- **Privilege escalation prevention** del TodoERP también aplica para asignación de roles clínicos.

### 13.3 Seguridad y privacidad

- **Cifrado en tránsito**: HTTPS obligatorio en producción.
- **Cifrado en reposo**: Postgres con `pgcrypto` ya activo. Datos especialmente sensibles (cédula, diagnósticos) → considerar columnas cifradas en `data` JSONB con clave gestionada fuera de la DB.
- **Cumplimiento LOPDP (Ecuador, 2021)**:
  - Consentimiento informado almacenado por paciente.
  - Derecho de acceso, rectificación, eliminación: el paciente puede pedir export/borrado.
  - Registro de tratamiento (qué se almacena, finalidad, base legal).
- **Auditoría**: cada *tool call* del bot deja entrada en `chatter` con `created_by = bot:<user_id>`.
- **Datos a LLMs externos**: el prompt nunca debe incluir cédula, dirección, teléfono, ni nombre completo si no es estrictamente necesario para la tarea. Pseudoanonimización en el prompt (e.g., "el paciente" en lugar del nombre).
- **Retención**: definir política. Recomendación: episodios cerrados conservados 10 años (norma médica común); sesiones de bot crudas, 90 días con resumen permanente.

> **Decisión abierta D-4:** ¿se manda data clínica a un LLM en la nube? Recomendación: sí, pero **pseudoanonimizada** y bajo acuerdo de procesamiento. Alternativa: LLM local (Ollama) si se requiere zero-egress.

### 13.4 Rate limiting y abuso

- En el endpoint de chat, por usuario: N mensajes/min (configurable).
- Para guest: límites más estrictos (ya hay precedente en server.js actual).

---

## 14. Casos de uso principales

> Convención de tools en estos casos: el agente solo invoca tools genéricas. Donde aparece `entities.create("episode", ...)` léase "el bot está creando una entidad del tipo episodio"; el MCP no tiene una tool específica de episodios.

### CU-1 — Médico registra una consulta dermatológica

1. Médico abre la app, se autentica, selecciona paciente "Juan Pérez".
2. Frontend manda al bot el `active_patient_id`. Bot llama `entities.get(<patient_id>)` y `entities.search({ slug: 'episode', filters: { patient_id: <id> }, limit: 5 })`.
3. Bot saluda con un brief: *"Juan Pérez, 34a, última consulta hace 2 meses por dermatitis seborreica"*. Pregunta motivo de consulta actual.
4. Médico dicta libremente: *"Vino por una mancha en el antebrazo, hace 3 semanas, le pica de noche, ha usado hidrocortisona sin mejoría."*
5. Bot llama `entities.create("episode", { patient_id, motivo: 'mancha en antebrazo' })` → recibe `episode_id`.
6. Bot extrae slots y llama `entities.update(<episode_id>, { tiempo_evolucion: '3 semanas', sintoma_principal: 'prurito nocturno', tratamientos_previos: ['hidrocortisona sin respuesta'] })`.
7. Bot pregunta lo siguiente más útil: *"¿Algún factor desencadenante claro? ¿Estrés, contacto con alguna sustancia, viajes?"*.
8. Médico sube foto de la lesión → frontend la asocia al episodio (sube binario por REST, llama `entities.create("clinical_image", { episode_id, attachment_id, body_region: 'antebrazo' })`). Job en cola dispara clasificación ISIC (§10.4).
9. Médico sigue dictando exploración. Bot persiste por turnos vía `entities.update`.
10. Al final, médico dice "diagnóstico presuntivo dermatitis de contacto, plan corticoide tópico potente 7 días, control en 2 semanas". Bot:
    - `entities.create("diagnosis", { episode_id, tipo: 'presuntivo', codigo_cie10: 'L25.9', ... })`
    - `entities.update(<episode_id>, { plan: '...', proximo_control_fecha: '+2 semanas' })`
    - `reminders.create({ entity_id: <episode_id>, owner_user_id: <medico_id>, due_at: now+14d, title: 'Control Juan Pérez', message: 'Revisar evolución dermatitis de contacto antebrazo' })`
    - `reminders.create({ entity_id: <patient_id>, owner_user_id: <patient_user_id>, due_at: now+13d, title: 'Recordatorio control', channels: ['email','in_app'] })`
    - Sugiere búsqueda CIE-10 vía `entities.search` sobre el catálogo CIE cargado.
11. Bot resume el episodio en lenguaje natural y pide confirmación. Médico confirma → bot llama `entities.update(<episode_id>, { estado: 'cerrado' })`.

### CU-2 — Paciente autorrellena antecedentes antes de su primera cita

1. Paciente recibe link al portal, se registra, agenda cita.
2. Bot le saluda y le pregunta antecedentes alérgicos, medicación, hábitos. Una pregunta a la vez.
3. Cada respuesta se persiste en su ficha vía `entities.update(<patient_id>, { ... })`.
4. Si el paciente menciona algo crítico (alergia a penicilina), el bot lo marca como `priority: 'high'` y crea `chatter.add_note` con destacado para que el médico lo vea.
5. Bot programa `reminders.create` para 24h antes de la cita ("revisa este resumen").
6. En su consulta, el médico ya tiene la ficha pre-llenada.

### CU-3 — Supermédico revisa diagnósticos del último mes

1. Supermédico entra al dashboard.
2. Le pide al bot: *"Listame los diagnósticos sin revisar de la última semana."*
3. Bot llama `entities.search({ slug: 'diagnosis', filters: { revisado_por: null, created_at: '>= now-7d' } })`.
4. Supermédico abre uno, comenta o aprueba: bot llama `entities.update(<diagnosis_id>, { revisado_por: <super_id>, aprobado_at: now })`.
5. Si el supermédico no atiende su bandeja en 48h, un `reminders` recurrente le avisa.

### CU-4 — Guest hace consulta dermatológica anónima

Como hoy: árbol de decisión en `tree.js`, sin persistencia. Al final, oferta de agendar cita o registrarse como paciente.

### CU-5 — Admin agrega un nuevo campo "antecedente quirúrgico" al paciente

1. Admin va al editor de formularios de TodoERP.
2. Agrega el campo en `form_configs` del entity_definition `patient`.
3. El bot, en su próximo turno, lee `definitions.describe('patient')` y descubre el nuevo slot. Empieza a preguntarlo cuando proceda. **Sin redeploy del bot ni del MCP**.

### CU-6 — Clasificación automática de imagen y casos similares

1. Médico sube foto de una lesión sospechosa durante CU-1.
2. Backend crea `clinical_image` y encola job de clasificación.
3. Job llama al servicio Python (modelo ISIC). Recibe embedding de 1024 dims y top-5 labels (e.g., `[melanoma:0.62, nevus_atípico:0.24, ...]`).
4. Job llama `vectors.upsert(<image_id>, 'image', embedding, 'isic-resnet50-v1')` y `classifications.set(<image_id>, 'isic-resnet50-v1', { labels: [...], confidence: 0.62 })`.
5. Como `melanoma >= 0.5`, el sistema crea automáticamente un `reminders` para el supermédico con `priority='alta'` y referencia al episodio.
6. Bot, al continuar la consulta, le dice al médico: *"El clasificador ISIC sugiere melanoma con confianza media (62%). ¿Quieres ver casos similares en la base?"*.
7. Si médico acepta, bot llama `vectors.search({ entity_id: <image_id>, model_id: 'isic-resnet50-v1', k: 8 })`. Devuelve thumbnails y, si el médico no tiene permiso para ver al paciente original, anonimiza.
8. Médico revisa, hace su propio diagnóstico y lo registra (CU-1 paso 10). El sistema **nunca** persiste la predicción del modelo como diagnóstico.

### CU-7 — Seguimiento longitudinal de un paciente crónico

1. Paciente con dermatitis crónica tiene `medico_principal_id` asignado y un episodio abierto recurrente (`tipo: 'seguimiento'`).
2. Cada 30 días, un `reminders` recurrente con `owner = paciente` le envía mensaje al portal: "¿Cómo está la lesión esta semana?".
3. Paciente responde por chat con descripción + opcional foto. Bot persiste como nota+imagen del episodio (`chatter.add_note`, `entities.create("clinical_image", ...)`).
4. Si el bot detecta empeoramiento o palabras clave ("peor", "sangra", "duele"), crea recordatorio inmediato para el médico (`due_at: now`, canal `in_app`+`email`).
5. Médico revisa el feed cronológico del paciente: imágenes, clasificaciones, mensajes — todo en orden.

### CU-5 — Admin agrega un nuevo campo "antecedente quirúrgico" al paciente

1. Admin va al editor de formularios de TodoERP.
2. Agrega el campo en `form_configs` del entity_definition `patient`.
3. El bot, en su próximo turno, lee `entity_definitions.describe('patient')` y descubre el nuevo slot. Empieza a preguntarlo cuando proceda. **Sin redeploy**.

---

## 15. Plan de implementación por fases

Orden propuesto. Cada fase es desplegable y testeable.

### Fase 0 — Fundación (1-2 días)
- Limpieza del repo raíz (carpetas espurias `D:cepibackend`, etc.).
- Instalar/levantar TodoERP con Postgres local.
- Confirmar que login y CRUD de entidades funcionan.
- Crear rama `feat/medical-assistant`.

> Las fases marcadas con **[TodoERP genérico]** se diseñan e implementan **sin** referencia al dominio médico. Las marcadas con **[médico]** consumen lo genérico.

### Fase 1 — Capacidades genéricas en TodoERP (5-7 días) [TodoERP genérico]
**1A — Sistema de alertas/recordatorios**
- Schema `reminders` (§9.2), drivers de canal (`in_app`, `email`).
- Scheduler interno (process pull cada N segundos).
- API REST `/api/reminders` y permisos `reminders:*`.
- Tests: creación, disparo, snooze, cancelación, recurrencia básica.

**1B — Vector store + classifications**
- Habilitar extensión `pgvector` en init script.
- Schemas `models_registry`, `vector_embeddings`, `entity_classifications` (§10.2).
- API REST `/api/vectors` y `/api/classifications` y permisos correspondientes.
- Cola de jobs (BullMQ con Redis o pg-boss).
- Tests: upsert + búsqueda k-NN, set/get clasificación.

### Fase 2 — Servidor MCP de TodoERP (5-7 días) [TodoERP genérico]
- Carpeta `TodoERP/mcp/` con `@modelcontextprotocol/sdk`.
- **Tools genéricas únicamente** (§8.2): `auth.*`, `definitions.*`, `entities.*`, `relations.*`, `attachments.*`, `chatter.*`, `reminders.*`, `vectors.*`, `classifications.*`, `models.*`.
- Auth: API key con rol asignado o JWT pasado por arg.
- Tests: cada tool valida permisos, respeta schema, audita.
- Validación: usar el MCP para gestionar entidades **no médicas** (e.g., facturas) sin un solo cambio de código.

### Fase 3 — Modelo clínico (3-5 días) [médico — datos sobre genérico]
- Definir `entity_definitions`: `patient`, `episode`, `diagnosis`, `prescription`, `clinical_image`, `lab_order`, `bot_session`.
- Seed `004_medical_seed.sql`.
- Roles `guest`, `paciente`, `medico`, `supermedico`, `admin`. Sus permisos se construyen sobre los recursos genéricos: `patient:read_assigned` es un permiso registrado contra el slug `patient`, no una tabla nueva.
- Formularios dinámicos básicos (vista CRUD admin del médico) usando `DynamicFormRenderer.vue`.
- Tests: CRUD por rol respeta matriz.

### Fase 4 — Agente médico (7-10 días) [médico]
- Refactor de `backend/server.js` actual a `cepi-bot/`:
  - Cliente MCP del SDK.
  - Loop de tool-use con LLM (proveedor configurable).
  - Gestión de `active_patient_id` y `active_episode_id` por sesión.
  - Modo dispatcher por rol (guest mantiene flujo actual; los demás van al modo agente).
  - Persistencia de `bot_session` vía `entities.create("bot_session", ...)`.
  - Mapa "intención clínica → tool genérica" (§8.5).
- Frontend de chat: envío de `patient_id` activo, render de estados intermedios, subida de archivos.
- Tests E2E con guiones (CU-1 simplificado).

### Fase 5 — Captura clínica completa (1-2 semanas) [médico]
- Slot filling para anamnesis, examen, signos vitales, diagnóstico, plan.
- Catálogo CIE-10 cargado como `entity_definition` "icd10_code" + seed (no tabla específica). Búsqueda vía `entities.search`.
- Subida de imágenes clínicas atadas a episodio (sin clasificación aún).
- Confirmación obligatoria antes de persistir datos sensibles.
- Cierre de episodio crea recordatorio de control (`reminders.create`).

### Fase 6 — Clasificación de imágenes con ISIC (1-2 semanas) [médico — modelos]
- Servicio Python (FastAPI) que aloja modelo ISIC pre-entrenado. Endpoints `/embed`, `/classify`.
- Registrar el modelo en `models_registry` vía seed (`isic-resnet50-v1`).
- Worker que toma jobs de la cola (creada en Fase 1), llama al servicio, persiste vía `vectors.upsert` y `classifications.set`.
- Política de escalación: si confianza ≥ umbral en clase crítica → recordatorio supermédico.
- Bot integra "casos similares" (`vectors.search`) y muestra clasificación al médico como sugerencia.
- Pruebas con dataset HAM10000 / ISIC público.

### Fase 7 — Modo paciente y portal (1 semana) [médico]
- Frontend de paciente con su ficha y mensajería con el bot.
- Bot pregunta antecedentes/alergias.
- Consentimientos LOPDP visibles y firmables (entidad `consent`).
- Agendamiento integrado con el flujo actual de "cita".
- Recordatorios automáticos de cita y de seguimiento (CU-7).

### Fase 8 — Supermédico, dashboards, seguimiento agregado (3-5 días) [médico]
- Vistas agregadas (reportes TodoERP existentes ayudan).
- Workflow de revisión/aprobación de diagnóstico.
- Bandeja de pendientes (recordatorios + escalaciones automáticas).
- Auditoría: dashboard de tool-calls del bot.

### Fase 9 — Endurecimiento y despliegue (1 semana)
- Pseudoanonimización de prompts.
- Rate limiting.
- Logs estructurados.
- Backup y restore de DB (incluye `vector_embeddings` que pueden ser pesados).
- Política de retención implementada (job nocturno usando reminders del propio sistema).
- Documentación operacional.

> Total estimado: ~9-12 semanas de trabajo concentrado para un único desarrollador. Fases 1A/1B y 6 paralelizables si hay segundo dev.

---

## 16. Métricas de éxito

| Métrica | Cómo se mide | Meta v1 |
|---|---|---|
| **Tiempo de carga por consulta** | Comparar minutos tipeando vs. dictando al bot | -40% |
| **Cobertura estructurada** | % de campos clave llenos por episodio | ≥80% |
| **Repreguntas indebidas** | Veces que el bot pregunta algo ya en ficha | <5% |
| **Tiempo de revisión supermédico** | Minutos por episodio revisado | -30% |
| **Errores de persistencia** | Tool calls fallidas / total | <1% |
| **Adopción** | % de consultas registradas vía bot vs. UI clásica | ≥50% en 3 meses |

---

## 17. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| LLM extrae mal un slot crítico (alergia, medicación) | Alto | Confirmación obligatoria antes de persistir; logging de cambios; supermédico revisa |
| Filtración de datos clínicos a LLM externo | Alto | Pseudoanonimización; opción local; acuerdo de procesamiento |
| Bot da diagnóstico definitivo | Alto (legal) | Prompt + tool design lo prohíben; siempre "presuntivo"; disclaimer; firma humana requerida |
| Coste de LLM se dispara | Medio | Streaming corto; resúmenes; caché de definiciones de entidad |
| Adopción baja por médicos | Medio | Pilotear con un grupo, iterar UX; mantener UI clásica como alternativa |
| Cambios de schema rompen el bot | Medio | Bot lee schema dinámicamente vía `entity_definitions.describe`; tests por contrato |
| Latencia inaceptable en tool-use | Medio | Llamadas MCP locales (mismo host); tools lean; paralelización donde aplique |

---

## 18. Decisiones abiertas

| ID | Decisión | Recomendación |
|---|---|---|
| D-1 | ¿Admin lee datos clínicos? | No por defecto, override con permiso explícito y auditado |
| D-2 | Campos obligatorios al crear paciente | `nombre` + `cedula` o `email`; resto incremental |
| D-3 | LLM principal | DeepSeek v1, abstraído tras interfaz; reservar opción local |
| D-4 | Datos clínicos al LLM externo | Sí, pseudoanonimizados |
| D-5 | ¿El bot habla con el paciente sin médico de por medio? | Sí, en modo paciente, pero solo para autollenado y consultas no clínicas; nada de diagnóstico |
| D-6 | ¿Almacenar grabaciones de voz si se agrega dictado? | No en v1 |
| D-7 | Vademécum / catálogo de medicamentos | Texto libre v1; dataset estructurado en una fase posterior |
| D-8 | ¿Multi-tenant (varias clínicas en una instancia)? | Single-tenant CEPI v1; multi-tenant si se vende como producto |
| D-9 | Canales de recordatorios habilitados en v1 | `in_app` siempre; `email` opcional; `push` y `webhook` v2 |
| D-10 | Modelo de imagen on-prem o servicio externo | On-prem con modelo open-source liviano; subir a gestionado solo si la calidad no alcanza |
| D-11 | Tareas de clasificación priorizadas | Triage binario "sospecha alta / no" + multiclase top-5 informativo |
| D-12 | Cola de jobs (BullMQ vs pg-boss) | pg-boss si queremos cero infra extra (usa Postgres); BullMQ si ya hay Redis |
| D-13 | ¿Lesiones siguen un mismo `lesion_id` en el tiempo? | Sí, opcional; útil para series longitudinales y comparación de imágenes |
| D-14 | Umbral de confianza para escalación automática a supermédico | 0.5 sobre clases críticas (melanoma, BCC, SCC) — calibrar con datos reales |

---

## 19. Glosario

- **MCP** — Model Context Protocol. Estándar para exponer *tools*/recursos a agentes LLM.
- **Slot filling** — técnica de NLU: extraer campos estructurados (slots) de texto libre, turno a turno.
- **Anamnesis** — historia clínica narrada por el paciente al médico.
- **CIE-10 / ICD-10** — clasificación internacional de enfermedades, 10ª revisión.
- **LOPDP** — Ley Orgánica de Protección de Datos Personales del Ecuador (2021).
- **Polimórfico (TodoERP)** — patrón de tablas únicas (`entities`) con discriminador y JSONB para estructura variable.
- **Chatter** — feed de actividad de TodoERP (cambios automáticos + notas humanas).
- **pgvector** — extensión Postgres que añade el tipo `vector` y operadores de distancia (cosine, L2, inner product) para búsqueda de similaridad. Soporta índices IVFFlat y HNSW.
- **HNSW** — Hierarchical Navigable Small World. Índice aproximado de k-NN; alta velocidad de consulta a costa de tiempo de construcción y memoria.
- **ISIC** — International Skin Imaging Collaboration. Iniciativa abierta que publica datasets (HAM10000, SLICE-3D) y modelos para clasificación de lesiones cutáneas.
- **HAM10000** — dataset ISIC con ~10 000 imágenes dermatoscópicas etiquetadas, base habitual para fine-tuning de clasificadores.
- **Embedding** — representación vectorial densa de un dato (texto, imagen) producida por un modelo, usable para búsqueda por similaridad.
- **k-NN** — k-Nearest Neighbors: encontrar los k registros más cercanos a un vector dado.
- **RRULE** — sintaxis de recurrencia del estándar iCalendar (RFC 5545); usada en `reminders.recurrence`.
- **Tool-use / function calling** — capacidad de un LLM de emitir llamadas estructuradas a funciones/tools en lugar de solo texto.
- **Slug (TodoERP)** — identificador corto en minúsculas/snake_case para una `entity_definition` (`patient`, `episode`, etc.).

---

## 20. Apéndices

### A. Esquema de slot-filling para episodio dermatológico

```yaml
required_for_close:
  - motivo_consulta
  - tiempo_evolucion
  - examen_fisico.descripcion_lesion
  - examen_fisico.localizacion
  - diagnostico_principal
  - plan
recommended:
  - sintomas_asociados
  - tratamientos_previos
  - factor_desencadenante
  - imagenes (≥1)
optional:
  - antecedentes_familiares_relevantes
  - signos_vitales (no siempre relevantes en derma)
ask_order_priority:
  1. motivo_consulta
  2. tiempo_evolucion
  3. localizacion
  4. descripcion_lesion
  5. sintomas_asociados
  6. tratamientos_previos
  7. factor_desencadenante
```

### B. Plantilla de prompt (modo médico) — esqueleto

```
Eres asistente clínico del médico {medico_nombre}.
Paciente activo: {patient_brief} (edad, sexo, alergias, medicación, últimas consultas).
Episodio en curso: {episode_id_or_none}, slots ya rellenos: {filled_slots}.
Slots pendientes prioritarios: {pending_slots_top3}.

REGLAS:
- Una sola pregunta por turno, salvo síntesis final.
- Nunca des un diagnóstico definitivo. Siempre "presuntivo" + diferencial.
- Antes de persistir alergia, medicación, diagnóstico o plan: confirma con el médico.
- Usa tools MCP para todo cambio de datos. No inventes ids.
- Sé conciso, sin emojis, sin lenguaje empático innecesario.

TOOLS DISPONIBLES: {mcp_tools_signatures}
```

### C. Estructura de carpetas final propuesta

```
D:/cepi/
├── docs/
│   └── PAPER.md                   ← este documento
├── TodoERP/                       ← ERP genérico (existente, se extiende)
│   ├── backend/                   ← REST API (Express) + nuevos endpoints genéricos
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── remindersRouter.ts        ← NUEVO (genérico)
│   │       │   ├── vectorsRouter.ts          ← NUEVO (genérico)
│   │       │   ├── classificationsRouter.ts  ← NUEVO (genérico)
│   │       │   └── modelsRouter.ts           ← NUEVO (genérico)
│   │       ├── services/
│   │       │   ├── reminderScheduler.ts      ← NUEVO (genérico)
│   │       │   └── classificationWorker.ts   ← NUEVO (genérico, agnóstico al modelo)
│   ├── frontend/                  ← UI admin (Vue 3)
│   ├── mcp/                       ← NUEVO: servidor MCP (genérico)
│   │   ├── src/
│   │   │   ├── server.ts          ← entry MCP
│   │   │   ├── tools/             ← una tool por archivo: entities/, relations/, reminders/, vectors/, ...
│   │   │   └── auth.ts
│   │   └── package.json
│   └── database/
│       ├── 001_schema.sql                    ← actualizar: pgvector, reminders, vectors, classifications, models_registry
│       ├── 002_seed.sql
│       └── 003_clientes_seed.sql
├── cepi-bot/                      ← agente médico (refactor de backend/ actual)
│   ├── src/
│   │   ├── server.ts              ← /api/chat con SSE
│   │   ├── agent.ts               ← loop de tool-use
│   │   ├── mcpClient.ts
│   │   ├── modes/                 ← guest, paciente, médico, supermédico, admin
│   │   └── prompts/
│   └── package.json
├── medical-models/                ← NUEVO: servicio Python para modelos ISIC
│   ├── app.py                     ← FastAPI: /embed, /classify
│   ├── models/                    ← pesos descargados (gitignored)
│   ├── requirements.txt
│   └── Dockerfile
├── medical-seed/                  ← seed específico médico (datos, no código)
│   └── 004_medical_seed.sql       ← entity_definitions clínicas, roles, permisos, modelos ISIC en models_registry
├── frontend/                      ← UI de chat (existente, evoluciona)
└── ecosystem.config.cjs           ← PM2: backend, mcp, cepi-bot, medical-models, frontend
```

> Observación: `medical-seed/` y `medical-models/` viven fuera de `TodoERP/` para reforzar visualmente que TodoERP no contiene nada médico. Solo configuración (seed) y un servicio externo que el ERP llama.

### D. Ejemplo concreto de tool-call

Conversación:
```
Médico: "Tiene una placa eritematodescamativa en codo, 4 cm, asintomática."
```

LLM decide (tool genérica):
```json
{
  "tool": "entities.update",
  "args": {
    "id": "ep-abc-123",
    "partial_data": {
      "examen_fisico": {
        "descripcion_lesion": "placa eritematodescamativa",
        "tamano_cm": 4,
        "localizacion": "codo"
      },
      "sintomas_asociados": ["asintomática"]
    }
  }
}
```

MCP server (`entities.update`, genérica):
1. `verifyToken` → user role = `medico`.
2. Lee la entidad → discrimina por su `entity_definition.slug` = `episode`.
3. Resuelve permiso requerido como `<slug>:update_assigned` → `episode:update_assigned`.
4. `hasPermission(user, 'episode:update_assigned')` → ok.
5. Verifica que `medico_id` del episodio === `user.sub` (regla genérica de "asignación" basada en metadata del slug, no hardcoded).
6. Hace MERGE no destructivo sobre `data` JSONB.
7. Inserta entrada `change` en chatter con autor `bot:<userid>` y diff de campos.
8. Devuelve la entidad actualizada.

LLM responde al médico:
```
Anotado: placa eritematodescamativa, 4 cm, codo, asintomática.
¿Bordes definidos o difusos?
```

### E. Lista de entity_definitions clínicas para seed (`004_medical_seed.sql`)

| slug | parent permitido | campos clave | índices |
|---|---|---|---|
| `patient` | — | `cedula` (unique), `nombre`, `email`, `medico_principal_id` | unique(cedula), btree(email) |
| `episode` | `patient` | `medico_id`, `fecha`, `motivo`, `estado`, `proximo_control_fecha` | btree(medico_id, fecha desc), btree(estado) |
| `diagnosis` | `episode` | `tipo`, `codigo_cie10`, `confianza` | btree(codigo_cie10) |
| `prescription` | `episode` | `medicamento`, `dosis`, `duracion` | — |
| `clinical_image` | `episode` | `attachment_id`, `body_region`, `lesion_id`, `embedding_status` | btree(lesion_id) |
| `lab_order` | `episode` | `tipo_examen`, `estado_resultado` | — |
| `bot_session` | `patient`? (opcional) | `user_id`, `turns`, `extracted_slots` | btree(user_id, created_at desc) |
| `consent` | `patient` | `tipo`, `texto`, `firma`, `vigencia_hasta` | btree(patient_id, tipo) |
| `icd10_code` | — | `codigo`, `descripcion`, `categoria` | unique(codigo), full-text(descripcion) |

### F. Modelos a registrar en `models_registry` (seed)

| `id` | `kind` | `dimensions` | Origen sugerido |
|---|---|---|---|
| `isic-resnet50-v1` | `image-classifier` | — | Pre-entrenado sobre HAM10000; FastAPI local |
| `isic-img-embed-v1` | `image-embedder` | 1024 | Backbone del clasificador (penúltima capa) |
| `text-embed-multilingual-v1` | `text-embedder` | 768 | Para búsqueda semántica de notas/anamnesis |

### G. Cuestiones para investigación previa antes de Fase 6

- ¿Existen pesos públicos directamente reutilizables del ISIC 2024/2025 challenge?
- Qué dataset usar para validar localmente (HAM10000 funciona; SLICE-3D si hay GPU).
- Métrica objetivo de validación (sensibilidad alta para melanoma, AUC ≥ 0.85).
- Latencia objetivo de clasificación: < 3s por imagen en CPU consumer; < 500ms en GPU.

---

**Fin del documento.** Próximo paso: revisión y resolución de decisiones abiertas (D-1 a D-14) antes de iniciar Fase 0.
