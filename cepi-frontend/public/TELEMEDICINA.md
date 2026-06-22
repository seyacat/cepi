# TELEMEDICINA — Plan de desarrollo

> Plan accionable para la capa de telemedicina sobre el sistema **cepi** ya
> construido (asistente conversacional + TodoERP genérico + MCP + frontend Vue).
> Estilo y reglas alineadas con `docs/PAPER.md`. **Regla dura**: TodoERP queda
> genérico; el vocabulario clínico vive solo en `database/medical-seed/` y en el
> agente `cepi-bot`. Ver §3.
>
> Convención de marcado: **[YA]** = existe en el código · **[NUEVO]** = a construir
> · **[EXT]** = extensión de algo existente · **[CABLEAR]** = el código ya existe
> pero falta montarlo/exponerlo.
>
> **Nota de auditoría (importante)**: este plan se reescribió tras auditar los
> primitives ya construidos. Buena parte de la "infraestructura" que un primer
> borrador habría dado por inexistente **ya está en el repo y es genérica**. Antes
> de proponer cualquier capacidad nueva en TodoERP, verificar que no exista ya:
> `entities/claim.ts`, `entities/assign.ts`, `entities/requestReview.ts`,
> `groupsRouter.ts` (+ `resolveGroupMemberIds`), `migrations/015_user_groups.sql`,
> y los drivers `channels/{telegram,webPush}.ts`.

---

## 0. Nota original (intención preservada)

La nota cruda de 12 líneas que este documento reemplaza describía la visión así
(parafraseada, sin perder nada):

- App **PWA instalable**, complementada por **chat de Telegram** (próximamente).
- Un **médico primario** envía la información de un paciente; un **grupo de médicos
  especializados** la evalúa y devuelve una recomendación de diagnóstico.
- El primario envía de **dos formas**: (1) un **texto completo** que la IA
  interpreta y clasifica en la ficha; (2) por **preguntas hechas por la IA**, como
  funciona hoy.
- Interfaz del primario **básica tipo WhatsApp/Telegram**, ayudada por buildforms.
- La solicitud llega a **un médico en TURNO**, responsable del análisis inicial,
  que decide **responder directo** o **socializar con el grupo de especialistas**.
- Si responde directo → el primario recibe la **notificación con el resultado**.
- Si deriva → se notifica al **círculo** del médico elegido (**por especialidad o
  todos**); hay que implementar los círculos.
- La info del paciente **viaja en la estructura de la ficha**.
- Roles **Médico Primario, Residente, Especialista** deben ser usuarios; **mejorar
  el registro es importante**.

Esta intención se mapea íntegramente a las secciones siguientes.

---

## 1. Resumen ejecutivo

La telemedicina **no es un subsistema nuevo**: es un **flujo de coordinación**
montado sobre piezas que ya existen, casi todas ya genéricas en TodoERP.

| Necesidad de la visión | Pieza existente que la sostiene | Estado |
|---|---|---|
| El caso del paciente | **episodio** (`episode`, entity_def `12000000-…`) | [YA] |
| Estructura de la ficha que viaja | `FICHA_GROUP_SPEC` en `cepi-bot/src/flowV1.ts` + `entity_definitions` | [YA] |
| Enviar a revisión / derivar (a usuarios **y a grupos**) | `request_review` (`entities/requestReview.ts`) + `/escalar` | [YA] (grupos ya resueltos en el handler) |
| Reclamar trabajo de una bandeja (claim) | `entities/claim.ts` (`responsable_actual_id`, atómico `FOR UPDATE`) | [YA] |
| Asignación manual (modo C) | `entities/assign.ts` (`entities:assign`) | [YA] |
| Avisos al destinatario | `reminders` + scheduler + drivers `in_app`/`email`/`telegram`/`web_push` | [YA] |
| Auditoría de quién derivó a quién | `chatter` (`action='request_review'`/`claim'`/`assign'`) | [YA] |
| Identidad del primario por Telegram | `auth/external/resolve\|link`, `data.telegram_id` | [YA] |
| Ingesta guiada (preguntas IA) | flujo `ficha_grp_*` en `flowV1.ts` | [YA] |
| Grupos / círculos / especialidad | tablas `user_groups`/`user_group_members`, `groupsRouter.ts` | [YA] (router **sin montar**) |
| Estado `estado` escrito en columna tipada al derivar | `requestReview.ts` (vía `getTableNameForEntityDef`) | [YA] |
| Web Push: tabla + drivers | `push_subscriptions`, `channels/{telegram,webPush}.ts` | [YA] |
| Montar `groupsRouter` + tools MCP `groups.*`/`entities.claim`/`entities.assign` | — | **[CABLEAR]** |
| Sembrar permisos `groups:read`/`groups:manage`/`entities:claim`/`entities:assign` | — | **[NUEVO]** (genéricos, base seed) |
| Estados de telemedicina del caso | valores de `episode.estado` (3 hoy) | **[EXT]** (solo seed) |
| `request_review` a un **grupo** desde el bot (`/escalar a grupo:<slug>`) y desde MCP | regex + schema MCP | **[EXT]** |
| Servicio de transición de estados (valida arco+permiso+propiedad) | — | **[NUEVO]** |
| PWA / Web Push frontend / offline | frontend es Vue plano, sin PWA | **[NUEVO]** |
| Ingesta por texto libre + gate | `pending_action` (confirmation gate) | **[EXT]** |
| Roles primario/residente/especialista | seed `002_medical_roles_perms.sql` | **[EXT]** |

**El flujo objetivo (v1, slice fino):**

```
Primario crea/llena ficha (texto libre o guiado)
        │
        ▼
  episode.estado = "enviada"  ──►  entra a la BANDEJA del círculo destino
                                   (= episodes con responsable_actual_id IS NULL
                                      filtrados por el grupo destino; sin tabla nueva)
        │
        ▼
  Médico de turno RECLAMA  (POST /api/entities/:id/claim → responsable_actual_id = él,
                            turno_claimed_by = él, estado = "en_triage")
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
 RESPONDE directo            DERIVA a especialidad/círculo
 estado="respondida"         estado="derivada", derivado_a=<group_id>
   │                              │  request_review {group_id} → reminders a cada miembro
   ▼                              ▼
 Primario recibe            Círculo recibe (in_app/email/telegram/push);
 notificación               un especialista responde → estado="respondida"
        └──────────┬──────────────┘
                   ▼
            estado = "cerrada"  (primario notificado del resultado)
```

Lo nuevo en TodoERP es mínimo y **genérico**: un servicio de transición de estados
y el cableado de lo ya escrito. El que esos grupos se llamen "Dermatólogos" o que
el estado se llame "derivada" vive en el **seed** y en el **agente**.

---

## 2. Mapeo de las 8 decisiones del dueño → diseño concreto

| # | Decisión | Diseño | Dónde |
|---|---|---|---|
| **1B** | Roles **nuevos separados**: `medico_primario`, `residente`, `especialista`, con sus bundles | Tres `roles` + tres bundles `data.permissions` que extienden `002_medical_roles_perms.sql`. Conviven con los 5 existentes (no se tocan). | §5 |
| **2B** | **Sin entidad nueva**: el episodio es el caso. Extender `estado` + campos `responsable_actual_id` / `derivado_a`; `request_review` a grupos | Nuevos valores de `episode.estado` (solo seed) + 3 columnas text que el seed declara y que `claim.ts`/`assign.ts` ya leen genéricamente. `request_review` a grupos **ya implementado**. | §4, §8 |
| **3A+B+C** | Turno **configurable**, 3 modos: **bandeja-reclamar (default)**, rotación, manual | A = `entities/claim.ts` (ya existe). C = `entities/assign.ts` (ya existe). B (rotación) = lógica en el **wrapper/agente** que elige al siguiente y llama `assign`. Sin tabla nueva. | §6 |
| **4C** | Círculos **por especialidad** + **nombrados a medida** | Un solo modelo `user_groups`/`user_group_members`; el "tipo" es `kind` (free-text) + metadata en `data`. | §7 |
| **5A** | v1 = **slice end-to-end fino**, UI mínima, ciclo completo | Plan de fases §14: cablear grupos → estados → claim → responder/derivar → notificar. | §14 |
| **6C** | PWA instalable + **Web Push** + **offline** (cola de envíos) | `vite-plugin-pwa`, manifest, SW, tabla `push_subscriptions` (ya existe) + driver `web_push` (ya existe), cola en `localStorage`. | §11 |
| **7A+B+C** | Canales: in_app + email(Brevo) + **Telegram** + **Web Push** | Los 4 drivers **ya existen** y están registrados en `registry.ts:44-48`. Falta env (VAPID, TELEGRAM_BOT_TOKEN) y el endpoint de subscribe. | §9 |
| **8A** | **Ambas ingestas** en v1: texto libre clasificado por IA **con gate** + flujo guiado actual | Reutiliza `pending_action`; requiere LLM tool-use (Claude CLI [YA], DeepSeek pendiente de key). | §10 |

---

## 3. Principio de generalidad (regla dura, PAPER §7 / CLAUDE.md)

> **Prueba de admisión a TodoERP**: toda capacidad nueva debe servir también para
> logística / RRHH / soporte sin cambiar código. Si solo sirve para clínica, vive
> en el seed o en el agente.
>
> **Regla de auditoría (nueva, obligatoria)**: antes de proponer una capacidad
> nueva, verificar que **no exista ya** como primitive genérico —
> `claim.ts`, `assign.ts`, `requestReview.ts`, `groupsRouter.ts`,
> `resolveGroupMemberIds()`, `migrations/015_user_groups.sql`, los drivers de
> canal. Reusar siempre el primitive existente; **duplicarlo con otro nombre es el
> peor resultado para la generalidad** (dos modelos divididos).

Telemedicina introduce 4 conceptos. Ninguno entra a TodoERP con nombre clínico, y
**todos** se apoyan en primitives genéricos ya construidos:

| Concepto clínico (visión) | Capacidad **genérica** en TodoERP (REAL) | Naming clínico vive en |
|---|---|---|
| Especialidad (dermatología) | **grupo** (`user_groups`) con `kind='specialty'` | seed `medical-seed/*` + agente |
| Círculo nombrado a medida | **grupo** con `kind='custom'`/`'circle'` | seed + admin UI |
| Membresía de un médico a un círculo | `user_group_members` (`group_id`, `user_id`, `role_in_group`) | — (es genérico) |
| Médico en TURNO | **claim** (`responsable_actual_id`) o **assign** sobre el episode | — |
| Caso / paciente que viaja | **episode** (entidad genérica polimórfica, ya existe) | seed (entity_def) |
| Derivar a un círculo | `request_review` con `group_id`/`group_ids` (ya soportado) | comando `/escalar` y prompts del bot |
| Estado "derivada", "en_triage"… | valores de un campo `select` genérico (`estado`) | seed (`options`) |
| Diagnóstico / recomendación | `chatter` note + entidad `diagnosis` (ya existe) | seed |

**Reglas de naming que se aplican sin excepción (nombres REALES verificados):**

- Tablas: `user_groups`, `user_group_members`, `push_subscriptions`. **Nada** de
  `specialties`, `circles`, `on_call`, `cases`, `assignment_queue`.
- Rutas REST: `/api/groups`, `/api/groups/:idOrSlug/members`,
  `/api/entities/:id/claim`, `/api/entities/:id/assign`,
  `/api/entities/:id/request_review`. **Nada** de `/api/circles`, `/api/triage`,
  `/api/assignments`.
- Tools MCP: recurso `groups.*` y acciones de entidad
  `entities.claim` / `entities.assign` / `entities.request_review`. **Nada** de
  `specialty.*`, `assignments.*`, `memberships.*` como recurso aparte (los miembros
  cuelgan de `groups.*`).
- Permisos **REALES**: `groups:read`, `groups:manage` (solo dos), `entities:claim`,
  `entities:assign`, `entities:request_review`. **Nada** de
  `groups:create/update/delete/manage_members` ni `assignments:*` — esos strings no
  los chequea ningún handler y serían permisos muertos.
- La palabra "dermatología", "círculo de dermatólogos", "médico de turno",
  "derivada", "en_triage", los roles `medico_primario/residente/especialista` y la
  regex `/escalar a grupo` aparecen **solo** en `medical-seed/*.sql`, en
  `cepi-bot/src/{server.ts,llm.ts,flowV1.ts}` y en los labels de UI.

---

## 4. Modelo de datos

### 4.1 Capacidad de grupos — **[YA], falta CABLEAR**

**No hay tablas ni router que crear.** Ya existen, genéricos, en
`TodoERP/database/migrations/015_user_groups.sql`:

```sql
-- (ya en el repo; transcrito para referencia)
CREATE TABLE user_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        varchar(128) NOT NULL UNIQUE,    -- id estable, p.ej. 'dermatologia'
  name        varchar(500) NOT NULL,
  kind        varchar(64),                     -- discriminador free-text (data, no código)
  description text,
  data        jsonb NOT NULL DEFAULT '{}',     -- config arbitraria (p.ej. assignment_strategy, rotation_order[])
  active      boolean NOT NULL DEFAULT TRUE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_group_members (
  group_id      uuid NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_group varchar(64),                   -- 'lead' | 'member' | 'especialista' (label libre)
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
```

> **Slot de migración**: 015 **ya está ocupado** por `015_user_groups.sql`. Si
> alguna vez hiciera falta una migración nueva, numerar **016+**.
>
> **Membresía con metadata por miembro** (`on_call`, `expertise[]`): la tabla
> `user_group_members` **no** tiene columna `data` ni índice GIN; solo
> `role_in_group VARCHAR(64)`. **Decisión v1**: no agregar columna. El estado de
> turno (modo A) se modela en el episode (`responsable_actual_id`), no por miembro.
> Si más adelante hiciera falta `on_call`/`expertise` por miembro, hay dos
> opciones, a decidir explícitamente (D-T11): **(a)** migración 016 que
> `ADD COLUMN data jsonb` a `user_group_members` + GIN + extender `groupsRouter`
> members para aceptar `data`; **(b)** modelarlo en `role_in_group` (p.ej.
> `'oncall'`) o en `user_groups.data`. v1 no lo necesita.

**El "turno" NO es una tabla.** Se cubre con primitives ya existentes:

- **Modo A (default) — bandeja compartida + reclamar**: la bandeja es una *consulta*
  (episodes `enviada` con `responsable_actual_id IS NULL` cuyo `derivado_a`/grupo
  destino apunta al círculo del usuario, vía `user_group_members`). Reclamar =
  `POST /api/entities/:id/claim` (`claim.ts`, atómico `FOR UPDATE`, 409 si ya
  reclamado salvo override `entities:assign`).
- **Modo C — manual**: `POST /api/entities/:id/assign` (`assign.ts`).
- **Modo B — rotación/horario**: lógica en el **wrapper/agente** que elige al
  siguiente miembro y llama `assign`. No vive en TodoERP (ver §6.2 y D-T3).

### 4.2 Extensión del episodio **[EXT, solo seed]** — cuidando `columnSyncService`

`episode.estado` hoy es un `select` (`001_medical_definitions.sql:86`, field `e020`)
con `options`: `["en_curso","cerrado","en_revisión_solicitada"]`. Los nuevos estados
de telemedicina **se agregan** (no se quitan):

```
en_curso · cerrado · en_revisión_solicitada · enviada · en_triage · respondida · derivada · cancelada
```

> **Contrato de generalidad (explícito)**: TODOS los valores de `estado`
> (`enviada`, `en_triage`, `derivada`, …) y los campos `responsable_actual_id`,
> `derivado_a`, `turno_claimed_by` se definen **SOLO** en `medical-seed/001` y
> `005` (entity_definition + form + nav). **Nunca** en migrations de TodoERP ni en
> código TS. TodoERP solo conoce esos 3 nombres de columna **genéricos** (los lee
> `claim.ts`/`assign.ts` vía `columnExists`, sin hardcodear semántica); el
> SIGNIFICADO ("derivada a dermatología") vive en seed/agente. `derivada` es un
> **valor-dato**, no un concepto de código.

`columnSyncService` regenera el CHECK `chk_<tbl>_estado` en
`reconcileColumnsOnStartup()` SOLO para `type='select'` con `options` no vacías.
Como `episode.estado` ES un select con options, **tres lugares deben quedar
sincronizados** o el CHECK rechaza el valor:

1. `medical-seed/001_medical_definitions.sql:86` — `options` del `entity_definition`.
2. `medical-seed/005_medical_forms_navs.sql:57` — `options` del `form_config`.
3. `medical-seed/005_medical_forms_navs.sql:296` — `options` del filtro de la nav-list.

> **GOTCHA crítico (no opcional)**: `requestReview.ts:135-139` envuelve el
> `UPDATE … SET estado = $1` en un `try/catch` que **solo loguea un warning**. Si
> el `status_value` (o un estado nuevo) **no está en el CHECK** del episode, la
> derivación responde **201 OK** pero **el estado NO cambia** (falla silenciosa).
> Por eso sincronizar los 3 lugares **antes** de derivar con estados nuevos es
> **obligatorio**. Lo mismo aplica al **4º vector**: `reviewRouter.ts:120-126`
> escribe el estado con `jsonb_set(data,'{estado}')` (modelo JSONB **obsoleto**) en
> vez de la columna tipada — ver §8 (consolidación).

Campos nuevos (todos `type:"text"`, sin `options` → no generan CHECK, bajo riesgo):

| key | uso clínico | dónde |
|---|---|---|
| `responsable_actual_id` | médico que reclamó / triage (UUID user) | `001:` tras `e020`; `005:` tras `e020` |
| `derivado_a` | grupo destino de la derivación (`user_groups.id`) | idem |
| `turno_claimed_by` | quién reclamó de la bandeja (UUID user) | idem |

> `claim.ts` ya setea `responsable_actual_id` y `turno_claimed_by` si las columnas
> existen; `assign.ts` setea `responsable_actual_id`. Nada que tocar en código.
> Opcional: que el bot capture estos campos → `FICHA_FIELD_DEFS` /
> `FICHA_EPISODE_KEYS` en `flowV1.ts`.

### 4.3 Máquina de estados del episodio-como-caso

```
                         [primario: crea+envía ficha]
        en_curso ───────────────────────────────────────────►  enviada
                                                                  │
                          [turno: RECLAMA bandeja] (claim)        │◄── [turno: DES-reclama] (unclaim)
                          responsable_actual_id := medico_turno   │
                          turno_claimed_by := medico_turno        ▼
                                                              en_triage
                                                          ┌───────┴────────────┐
                  [turno: responde directo]               │                    │ [turno: deriva]
                                                           │                    │ derivado_a := group_id
                                                           ▼                    ▼
                                                      respondida            derivada ──[especialista: rechaza/no aplica]──► respondida (sin dx)
                                                           │                    │ [especialista del círculo: responde]
                                                           │                    │ responsable_actual_id := especialista
                                                           │                    ▼
                                                           │                respondida
                                                           └─────────┬──────────┘
                                       [primario o sistema: confirma cierre]
                                                                     ▼
                                                                  cerrado ──[supermedico: reabre]──► en_curso

   En cualquier estado abierto:  *  ──[primario: cancela]──►  cancelada
   SLA sin respuesta:            derivada ──[supermedico/SLA: reasigna]──► en_triage
```

| Arco | Quién transiciona | Permiso requerido | Efecto técnico |
|---|---|---|---|
| `en_curso → enviada` | medico_primario | `episode:update_assigned` | episode queda en bandeja (claim pendiente) del grupo destino |
| `enviada → en_triage` | medico de turno | `entities:claim` | `claim.ts`: set `responsable_actual_id`,`turno_claimed_by`, `estado` |
| `en_triage → enviada` (unclaim) | turno actual o supervisor | `entities:claim` / `entities:assign` | limpia `responsable_actual_id` (reabre la bandeja) |
| `en_triage → respondida` | turno (residente/especialista) | `diagnosis:write` | `chatter` note + `diagnosis`; notifica al primario |
| `en_triage → derivada` | turno | `entities:request_review` | `request_review {group_id}` (§8); reminders a miembros |
| `derivada → respondida` | especialista | `diagnosis:write` | idem respondida; `responsable_actual_id` := especialista |
| `derivada → respondida` (sin dx / rechazo) | especialista | `diagnosis:write` | rebote al primario con nota "no aplica"; sin diagnóstico |
| `derivada → en_triage` (reasignar por SLA) | supermedico | `entities:assign` | reabre triage cuando el círculo no responde (§15) |
| `respondida → cerrado` | primario o hook | `episode:update_assigned` | hook `episode_close_followup` ya existe |
| `cerrado → en_curso` (reabrir) | supermedico | `episode:override` | corrección/reapertura; nota obligatoria en chatter |
| `* (abierto) → cancelada` | medico_primario | `episode:update_assigned` | cancela el caso; nota en chatter |

> **El CHECK NO valida el arco, solo el valor.** Un CHECK de columna garantiza que
> `estado ∈ options`, pero **no** que la transición sea legal (p.ej. saltar de
> `enviada` a `cerrado`, o que un residente responda un caso que no reclamó).
> **Decisión [NUEVO]**: centralizar las transiciones en un
> `episodeStateService.transition(client, entityId, from, to, actor)` **genérico**
> (no clínico: valida `arco ∈ tabla`, permiso, y propiedad
> `responsable_actual_id === actor.sub`) dentro de la **misma TX** que el `UPDATE`,
> con `SELECT … FOR UPDATE` del episodio. La tabla de arcos legales viaja como
> **datos** (config del entity_def o constante del wrapper médico), no como
> vocabulario en TodoERP. Tests por arco inválido. Transiciones inválidas → 422.

---

## 5. Roles y permisos

### 5.1 Convivencia con los 5 roles existentes

Roles actuales: `paciente`, `medico`, `supermedico` se **insertan** en
`002_medical_roles_perms.sql:26-28`; `admin` y `guest` provienen del **seed base de
TodoERP** (`database/002_seed.sql`). El seed clínico además define los bundles
`admin_clinical_extras` (`:117`) y `guest_clinical` (`:130`) y los vincula
(`:142-146`). **No se tocan.** Los 3 nuevos se **agregan** vía
`INSERT … ON CONFLICT (name) DO NOTHING`, con su bundle único `data.permissions`
(formato exacto del seed actual; `flattenPermissionRows` los expande sin cambios de
código).

Mapeo / convivencia recomendado:

| Rol nuevo | Es una especialización de | Diferencia clave |
|---|---|---|
| `medico_primario` | `medico` | crea/envía casos; NO reclama turno; NO responde casos ajenos |
| `residente` | `medico` | reclama turno + responde, pero su respuesta puede requerir co-firma (D-T4) |
| `especialista` | `medico` (≈ `supermedico` en lectura) | recibe derivaciones; `diagnosis:set_definitive` |
| `supermedico` | (existente) | supervisión global + break-glass; gestiona círculos; reasigna/reabre |

> Decisión: NO renombrar `medico`. Los 3 roles nuevos conviven; un usuario tiene
> exactamente un rol (modelo flat user→role). La pertenencia a círculos se modela
> con `user_group_members`, **no** con el rol.

### 5.2 Matriz de permisos nueva (bundles `data.permissions`)

Extiende `medical-seed/002_medical_roles_perms.sql`. Permisos **genéricos nuevos**
marcados con ⊕. Todos los strings de permiso deben mapear a un `hasPermission(...)`
real en algún handler (regla anti-permisos-huérfanos; test que falle si hay
huérfanos).

```jsonc
// medico_primario_perms
{ "description": "Médico primario: crea y envía casos, recibe resultados",
  "permissions": {
    "patient:read_own": true, "patient:create": true,
    "episode:create": true, "episode:read_assigned": true, "episode:update_assigned": true,
    "episode:request_review": true, "entities:request_review": true,
    "attachment:upload": true, "attachment:read_clinical": true,
    "reminders:read_own": true, "chat:bot": true, "pii:read:patient": true,
    "groups:read": true                                            // ⊕ ver a qué círculo enviar
}}

// residente_perms
{ "description": "Residente de turno: triage y respuesta inicial",
  "permissions": {
    "patient:read_assigned": true, "episode:read_assigned": true,
    "episode:update_assigned": true, "episode:request_review": true,
    "entities:request_review": true, "diagnosis:write": true,
    "attachment:read_clinical": true, "reminders:read_own": true, "chat:bot": true,
    "pii:read:patient": true,
    "groups:read": true, "entities:claim": true                    // ⊕ ver círculos + reclamar bandeja
}}

// especialista_perms
{ "description": "Especialista: recibe derivaciones del círculo, responde",
  "permissions": {
    "patient:read_assigned": true, "episode:read_assigned": true,
    "episode:update_assigned": true, "diagnosis:write": true,
    "diagnosis:set_definitive": true, "attachment:read_clinical": true,
    "reminders:read_own": true, "chat:bot": true, "pii:read:patient": true,
    "groups:read": true, "entities:claim": true                    // ⊕
}}
```

> **Corrección importante**: se usa `episode:read_assigned` (existente,
> `002_medical_roles_perms.sql:53,86`), **no** `episode:read_own` (que **no existe**
> y no tiene enforcement). El genérico `hasPermission` no tiene scope por entidad,
> así que `episode:read_own_patient`/`episode:read_assigned` son los únicos con
> semántica real hoy.

Permisos genéricos a sembrar — en `database/seeds/` **base** de TodoERP (no en
medical-seed), para que pasen la prueba "sirve para soporte/RRHH":

| Permiso ⊕ | Quién (en el seed clínico) | Handler que lo chequea |
|---|---|---|
| `groups:read` | médicos (todos los nuevos) | `groupsRouter.ts:65,91,188` |
| `groups:manage` | supermedico, admin | `groupsRouter.ts:114,143,172,211,238` |
| `entities:claim` | residente, especialista | `entities/claim.ts:32` |
| `entities:assign` | supermedico (modo C + reasignar) | `entities/assign.ts:22` |

> **No existe `groups:create/update/delete/manage_members` ni `assignments:*`** en
> el código — eran del primer borrador y serían permisos muertos. El router de
> grupos solo distingue `groups:read` (lectura) y `groups:manage` (toda escritura).
> El claim/assign usan `entities:claim`/`entities:assign`.
>
> `entities:request_review`, `pii:read:patient` y `diagnosis:write` ya existen en
> `medico_perms`/`supermedico_perms`. Como el bundle es solo data, agregar un
> permiso genérico es **JSONB, sin migración**. Recordar
> `invalidateUserPermissionsCache()` tras cambios (cache ~10-30 s).

---

## 6. Turno — estrategia de asignación (Decisión 3A+B+C)

La estrategia activa se lee de `user_groups.data.assignment_strategy`
(`"shared_claim" | "rotation" | "manual"`; default `shared_claim`). El concepto es
genérico ("a quién del grupo le llega el trabajo") y se apoya **100% en primitives
existentes** — no hay tabla ni router de "assignments".

### 6.1 Modo A — bandeja compartida + reclamar (DEFAULT) — **[YA] `claim.ts`**

1. `enviada` → el episode queda en la bandeja del grupo destino (consulta:
   `responsable_actual_id IS NULL` + grupo del usuario). NO se crean reminders
   pesados (a lo sumo un in_app liviano por miembro, D-T2).
2. Cada miembro ve la bandeja vía un endpoint de listado de episodes filtrado
   (`entities:read_assigned` + filtro `responsable_actual_id IS NULL`), **sin
   permiso ni tabla nuevos**.
3. `POST /api/entities/:id/claim` (`claim.ts`): bloquea `FOR UPDATE`, valida que no
   esté reclamado por otro (si lo está y el caller no tiene `entities:assign` → 409
   "Already claimed"), setea `responsable_actual_id`, `turno_claimed_by` y
   `estado='en_triage'` (vía `status_value`), y deja nota en chatter.

### 6.2 Modo B — rotación / horario — **[NUEVO, en el wrapper]**

Al `enviada`, el **wrapper/agente** (no TodoERP) elige el siguiente miembro on-call
leyendo `user_groups.data.rotation_order[]` + `last_assigned_index`, y llama
`POST /api/entities/:id/assign {user_id}`. Cuidados (§15): el incremento de
`last_assigned_index` debe hacerse con `SELECT … FOR UPDATE` sobre la fila de
`user_groups` (o una secuencia dedicada) para evitar el race read-modify-write; y
saltar miembros inactivos/sin canal. Fuera del slice v1 default.

### 6.3 Modo C — asignación manual — **[YA] `assign.ts`**

Supermedico asigna explícito: `POST /api/entities/:id/assign {user_id, status_value?}`
(permiso `entities:assign`). Sirve también para reasignar un caso huérfano (§15).

### 6.4 Tools MCP / endpoints — **[YA] + [CABLEAR]**

| Tool / Endpoint | Estado | Firma | Permiso |
|---|---|---|---|
| `entities.claim` / `POST /api/entities/:id/claim` | endpoint [YA]; tool **[CABLEAR]** | `{entity_id, status_value?}` | `entities:claim` |
| `entities.assign` / `POST /api/entities/:id/assign` | endpoint [YA]; tool **[CABLEAR]** | `{entity_id, user_id, status_value?}` | `entities:assign` |

> Los endpoints ya están montados (`entitiesRouter.ts:27-28`). Falta exponerlos como
> tools MCP en `mcp/src/tools.ts` (hoy solo está `entities.request_review`). La
> estrategia (A/B/C) se aplica en el **wrapper**, no en TodoERP.

---

## 7. Círculos (Decisión 4C: por especialidad + nombrados)

Ambos tipos son **el mismo** `user_groups`. Solo cambia `kind`:

| Círculo | Modelo | `kind` / `data` |
|---|---|---|
| Por especialidad (Dermatología) | `user_groups` | `kind='specialty'`, `data={ "assignment_strategy":"shared_claim", "tags":["dermatologia"] }` |
| Nombrado a medida ("Comité oncológico") | `user_groups` | `kind='custom'` (o `'circle'`), `data={ "assignment_strategy":"rotation", "rotation_order":[u1,u2], "last_assigned_index":0 }` |

Membresía: `user_group_members (group_id, user_id, role_in_group)`. La metadata por
miembro (`on_call`/`expertise`) **no cabe hoy** (no hay columna `data` en miembros);
ver §4.1 / D-T11.

Los círculos clínicos se **siembran** en un nuevo
`medical-seed/007_telemedicine.sql` (idempotente, `ON CONFLICT (id) DO UPDATE`),
p.ej. el grupo "Dermatología". El comentario de `015_user_groups.sql:7` **ya
anticipa** ese nombre `medical-seed/007_telemedicine.sql`. **No usar `006`**:
colisiona con `006_icd10_dermatology.sql` y `006_remove_invoicing_test_data.sql`. El
naming "dermatólogos" vive ahí, no en el código.

### 7.1 Tools MCP / endpoints genéricos — **[YA endpoints], tools [CABLEAR]**

El `groupsRouter.ts` ya implementa todas estas rutas; falta **montarlo en `app.ts`**
y exponer los tools MCP.

| Tool / Endpoint (REAL) | Firma | Permiso |
|---|---|---|
| `groups.list` / `GET /api/groups` | `{kind?, active?, q?}` | `groups:read` |
| `groups.mine` / `GET /api/groups/mine` | — | `groups:read` |
| `groups.get` / `GET /api/groups/:idOrSlug` | — | `groups:read` |
| `groups.create` / `POST /api/groups` | `{slug, name, kind?, description?, data?}` | `groups:manage` |
| `groups.update` / `PUT /api/groups/:idOrSlug` | `{name?, kind?, description?, data?, active?}` | `groups:manage` |
| `groups.delete` / `DELETE /api/groups/:idOrSlug` | — (soft) | `groups:manage` |
| `groups.members.list` / `GET /api/groups/:idOrSlug/members` | — | `groups:read` |
| `groups.members.add` / `POST /api/groups/:idOrSlug/members` | `{user_id, role_in_group?}` | `groups:manage` |
| `groups.members.remove` / `DELETE /api/groups/:idOrSlug/members/:userId` | — | `groups:manage` |

> `slug` es **obligatorio** y debe matchear `[a-z][a-z0-9_-]*`. El recurso de
> miembros cuelga de `/api/groups/:idOrSlug/members` (no hay recurso `memberships.*`
> aparte). Los endpoints aceptan **id o slug** (`resolveGroupId`).

### 7.2 UI de admin/supermedico **[NUEVO]**

Página `cepi-frontend` (o reutilizar el admin de TodoERP `frontend/`): lista de
grupos, alta/edición (`slug`, `name`, `kind`, `data.assignment_strategy`), gestión
de miembros con su `role_in_group`. v1 puede ser una vista mínima o incluso comandos
del bot (`/circulos`, `/circulo crear …`) para supermedico — más rápido para el
slice.

---

## 8. Derivación — `request_review` a grupos — **[YA] en el handler principal**

`requestReviewHandler` (`entities/requestReview.ts`) **ya** acepta derivación a
grupos y resuelve la estructura completa. Lo verificado en el código:

- **Firma real** (`:38`): `{ reviewers?: uuid[], group_id?, group_ids?, reason, due_at?, status_value? }`.
  Acepta reviewers individuales **y/o** uno o varios grupos (por id **o slug**).
- **Resolución de grupos** (`:109-114`): usa `resolveGroupMemberIds(client, g)` —
  el helper de `groupsRouter.ts:50-61`, que ya devuelve solo miembros **activos**.
  **No hay que reinventar `resolveReceivers`.**
- **Dedupe + excluir al requester** (`:116`):
  `Array.from(new Set(merged.filter(id => id !== callerId)))`. Cubre el solapamiento
  multi-grupo.
- **Estado en columna tipada** (`:100,136`): lee/escribe `estado` en
  `entity_<slug>` vía `getTableNameForEntityDef` (modelo post-JSONB correcto), **no**
  en `data` JSONB.
- **Reminders** (`:142-154`): uno por reviewer resuelto, canales `["in_app","email"]`.
- **Chatter** (`:156-174`): nota con `changes.action='request_review'`, `reviewers`,
  `previous_status`, `new_status`, `due_at`.

**Trabajo pendiente sobre la derivación (acotado):**

1. **MCP** (`mcp/src/tools.ts:126-139`): el `inputSchema` de `entities.request_review`
   hoy solo expone `{entity_id, reviewers, reason, due_at, status_value}` con
   required `[entity_id, reviewers, reason]`. **Extender** a `{group_id?, group_ids?}`
   y volver `reviewers` opcional (el backend ya valida "reviewers[] y/o grupo").
   Actualizar también la `description` (hoy dice "Updates entity.data.estado", que es
   incorrecto — escribe la columna tipada).
2. **Enriquecer chatter** (opcional): añadir `group_ids`/`expanded_user_ids` a
   `changes` para auditoría "derivado al **grupo** Dermatología (expandido a X,Y,Z)".
3. **Consolidar el duplicado** `reviewRouter.ts` (**Fase 0/3, no diferir**): hay dos
   caminos divergentes —
   - `requestReview.ts` (montado en `entitiesRouter.ts:26`, lo usa `/escalar` y el
     tool MCP) escribe la **columna tipada** y resuelve grupos. ✅
   - `reviewRouter.ts` (montado en `app.ts:136` bajo `/api/review`) escribe
     `data.estado` con `jsonb_set` (**JSONB obsoleto**, `:120-126`), **no** resuelve
     grupos, y crea el reminder con título exacto `'Revisión solicitada'`
     (`REVIEW_REMINDER_TITLE`, `:28,115`).

   **Bug confirmado de `my-pending`**: `GET /api/review/my-pending` filtra por
   `r.title = 'Revisión solicitada'` (`:204`), pero el handler principal escribe el
   título **con sufijo**: `Revisión solicitada: <title>` (`requestReview.ts:142`).
   Resultado: **los reminders del flujo `/escalar` NO aparecen en `my-pending`**.
   Solución al consolidar: eliminar el `jsonb_set` de `reviewRouter`, o reescribir su
   `UPDATE` a la columna tipada vía `getTableNameForEntityDef`, y dejar un **único
   handler**. La "bandeja"/"notificación al primario" NO debe apoyarse en
   `my-pending` por título frágil; filtrar por `changes.action='request_review'` en
   chatter o por un campo semántico del reminder.

**Efectos completos de una derivación a grupo:**
1. `episode.estado='derivada'`, `derivado_a=<group_id>` (UPDATE en tabla tipada;
   recordar el gotcha del CHECK, §4.2).
2. N `reminders` (uno por especialista del círculo). Canales en v1: `['in_app','email']`
   (igual que hoy); ampliar a `telegram`/`web_push` por evento en §9.
3. 1 `chatter` note con la auditoría.

**Notificación al primario al responder:** cuando el turno/especialista responde
(`en_triage|derivada → respondida`), crear un `reminder` cuyo `owner_user_id` es el
**primario** (creador del episode), título p.ej. `"Resultado disponible"`. Se cablea
como cualquier otro reminder. **El cuerpo NO debe llevar PII** (§13).

> **Bot — `/escalar a grupo` es nuevo.** El regex real
> (`cepi-bot/src/server.ts:1260`) solo matchea un UUID de 36 chars:
> `/^\/?\s*escalar\s+a\s+([0-9a-f-]{36})\s+(.+)$/i`. Para derivar a grupo hay que
> **agregar** un regex `/escalar a grupo:<slug> <razón>` que pre-valide con
> `GET /api/groups/:slug` (idOrSlug ya soportado) y arme un `pending_action` con
> `{group_id:<slug>}`. Añadir línea en `/help` (`llm.ts`) y test de regex en
> `cepi-bot/tests/server_commands.test.ts` (regla CLAUDE.md).

---

## 9. Notificaciones — 4 canales sobre `reminders` (Decisión 7A+B+C)

**Los 4 drivers ya existen y están registrados.** `channels/registry.ts:44-48` mapea
las **claves de canal** a las **funciones driver**:

```ts
export const drivers: Record<string, ChannelDriver> = {
  in_app:   inAppDriver,    // channels/inApp.ts   [YA]
  email:    emailDriver,    // channels/email.ts   [YA]  (Brevo)
  telegram: telegramDriver, // channels/telegram.ts [YA]
  web_push: webPushDriver,  // channels/webPush.ts  [YA]
};
```

> **Clave de canal ≠ nombre del export.** En `channels[]` de un reminder van las
> **claves** (`'telegram'`, `'web_push'`); el driver es la función (`telegramDriver`,
> `webPushDriver`). Web push debe llamarse **consistentemente** `web_push` en
> reminder y registry.

Trabajo pendiente para activarlos de punta a punta:

| Canal | Estado | Pendiente |
|---|---|---|
| `in_app` | [YA] activo | — |
| `email` | [YA] activo | `BREVO_API_KEY` en env |
| `telegram` | driver [YA] | `TELEGRAM_BOT_TOKEN` en env; resolver `chat_id` desde `users.data.telegram_id` |
| `web_push` | driver [YA] | **VAPID** (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`), lib `web-push`, y el endpoint `POST /api/push/subscribe` (§11) que inserta en `push_subscriptions` |

> **Tabla de Web Push REAL**: `push_subscriptions(id, user_id, endpoint UNIQUE,
> p256dh, auth, user_agent, data, …)` — campos **desglosados**, NO un blob
> `subscription jsonb`. El driver y el subscribe leen/escriben esas columnas. Al
> recibir **410 Gone** → `DELETE … WHERE endpoint=` (UNIQUE).

> Falla de un canal es no-fatal: si Telegram falla pero email entra, el reminder
> igual se marca enviado y el error queda en `result`.

**GOTCHA del scheduler (doble envío)** — prerequisito para canales externos:
`reminderScheduler.ts` toma el batch con
`SELECT … WHERE status='pending' AND due_at<=NOW() LIMIT 100` **sin** `FOR UPDATE
SKIP LOCKED` ni claim atómico previo al envío. Con >1 instancia o un tick solapado,
dos workers pueden enviar el mismo reminder dos veces (in_app es idempotente, pero
email/telegram/push **no**). **[NUEVO]**: antes de enviar, claim atómico —
`UPDATE reminders SET status='sending', attempts=attempts+1 WHERE id=$1 AND status='pending' RETURNING *`
(o `SELECT … FOR UPDATE SKIP LOCKED` en el batch).

**Eventos que disparan notificación (todos vía reminder):**

| Evento | Owner del reminder | Canales | Título (sin PII) | Idempotency |
|---|---|---|---|---|
| Caso enviado a la bandeja | miembros de turno | in_app(+push) | "Nuevo caso en bandeja" | 1 por (miembro, caso) |
| Caso reclamado (opcional, D-T2) | primario | in_app | "Tu caso está en triage" | 1 por caso |
| Derivado a círculo | cada especialista del círculo | in_app+email+telegram+push | "Caso #X derivado para revisión" | 1 por (miembro, caso) |
| Respuesta lista | **primario** | in_app+email+telegram+push | "Resultado disponible" | 1 por caso |
| Derivación sin respuesta (SLA) | supermedico (escalada) | in_app+email | "Caso sin respuesta" (§15) | 1 por (caso, ventana SLA) |

Preferencias de canal por usuario: `users.data.notify_channels` (JSONB), v1.5 (D-T10).

---

## 10. Ingesta de la ficha (Decisión 8A: ambas vías)

### 10.1 Flujo guiado (preguntas IA) — **[YA]**

`cepi-bot/src/flowV1.ts` ya implementa la ficha por ítems (`FICHA_GROUP_SPEC`,
`ficha_grp_*`), persistiendo directo vía `mcp.call('entities.update', …)`. Sin gate
porque enviar el formulario es una acción explícita del usuario (regla CLAUDE.md). Se
reutiliza tal cual.

### 10.2 Texto libre clasificado por IA + **gate de confirmación** — **[EXT]**

El primario pega un párrafo; el LLM (tool-use) extrae los campos de la ficha y
**propone** un `entities.update`. Como es **inferido de texto libre**, pasa por el
**confirmation gate** existente (`pending_action` en `server.ts`, PAPER §13.3.1): el
bot muestra "voy a guardar: motivo=…, dx=… ¿sí/no?" antes de persistir.

- Reutiliza el patrón `pending_action` ya usado por `/escalar`.
- **Dependencia dura**: requiere LLM con **tool-use**. El adaptador **Claude CLI ya
  existe**; **DeepSeek pendiente de key** → con feature flag y selección de adaptador,
  v1 corre con Claude CLI; degradar a flujo guiado si no hay tool-use.
- La estructura extraída usa las **mismas keys** que la ficha (`FICHA_EPISODE_KEYS`),
  de modo que "la info del paciente viaja en la estructura de la ficha".

---

## 11. PWA (Decisión 6C: instalable + Web Push + offline)

Hoy `cepi-frontend` es Vue 3 plano: **sin** manifest, **sin** SW, **sin**
`vite-plugin-pwa` (`package.json`, `vite.config.js`, `index.html`).

### 11.1 Instalable **[NUEVO]**
1. `npm i -D vite-plugin-pwa` → registrar en `vite.config.js` (array `plugins`).
2. `public/manifest.json` (icons, `start_url`, `display:standalone`, `theme-color`
   alineado a `--accent #63421e` de `style.css`).
3. `<link rel="manifest">` + meta `theme-color` en `index.html`.
4. `registerType:'autoUpdate'` + `skipWaiting` para evitar SW cacheado viejo (gotcha).

### 11.2 Web Push **[NUEVO frontend + endpoint]**
- Backend: la tabla `push_subscriptions` **ya existe** (`015_user_groups.sql:44`,
  columnas `endpoint`/`p256dh`/`auth`/`user_agent`). Falta: env **VAPID**
  (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`), lib `web-push`, y endpoint
  `POST /api/push/subscribe` que inserte `endpoint`/`p256dh`/`auth`/`user_agent`. El
  driver `web_push` ya está registrado (§9).
- Frontend: tras N mensajes (no en el primer load — gotcha de permisos), botón →
  `Notification.requestPermission()` → `pushManager.subscribe()` →
  `POST /api/push/subscribe`. Guardar en `localStorage.cepi.push_subscription`.
- SW: handler `push` → `showNotification`; `notificationclick` → abre/foco el chat.
- Punto de inserción: `cepi-frontend/src/components/Chat.vue` `onMounted` y
  `src/api.js` (export `subscribeToPush`).

### 11.3 Cola de envíos offline **[NUEVO]**
- `src/stores/offlineQueue.js`: antes de `send()` chequear `navigator.onLine`; si
  offline → encolar en `localStorage.cepi.pending_messages` con indicador ⏳ y un
  `client_msg_id` (uuid) por mensaje.
- Listener `online` → reintenta secuencial vía `chat()`; quita de la cola solo en
  éxito. Banner "Sin conexión — se enviará al reconectar".
- **Idempotencia (diseño, no solo mención)**: cada mensaje encolado lleva
  `client_msg_id`; el backend debe **deduplicar por `client_msg_id`** (columna/índice
  UNIQUE) y **devolver el resultado previo en replay** (no un 409 ciego que rompa la
  cola). La acción "enviar a bandeja" es idempotente por naturaleza (un episode =
  un `responsable_actual_id`); reproducir no crea doble caso.
- **Adjuntos**: subir primero, referenciar después; descartar refs cuyo upload no
  completó (no persistir refs stale).
- `localStorage` lleno → prune por antigüedad. Conflictos al reconectar → ver §15.

---

## 12. Registro mejorado (sobre identidad externa existente)

Base existente **[YA]**: `auth/external/resolve|link` (admin-only,
`authRouter.ts:86-126`), `data.telegram_id`/`whatsapp_phone` con índices únicos
parciales (`014_external_id_unique.sql`), gate de no-registrados en Telegram que
devuelve el `telegram_id` para pasárselo al admin (`telegram.ts:73-106`).

Plan de registro por capas (marca de v1):

| Capacidad | Mecanismo | v1? |
|---|---|---|
| **Vinculación manual por admin** | `/vincular telegram <id> <email>` → `auth/external/link` | **[YA] — v1** |
| **Self-request de acceso** | `POST /api/auth/external/request-access` (público, con rate-limit + honeypot) → crea registro `pending` + aviso a aprobadores | **[NUEVO] — v1 mínimo** |
| **Aprobación por supermedico/admin** | `POST /api/registrations/:id/approve` (patrón `temporaryPermissionsRouter`) → `users.active=true` + rol asignado + bienvenida al canal | **[NUEVO] — v1** |
| Invitación por token (magic link) | `accept-invite {token,password}` con TTL | v2 |
| Alta batch (CSV) | `external/batch-invite` | v2 |
| Dashboard de registros/aprobaciones | página admin + WS realtime | v2 |

**Riesgos del flujo público a resolver en el diseño:**
- **Estado no-aprobado**: modelar como `users.active=false` + `data.registration_status='pending'`
  (no puede loguear hasta `active=true`); o un registro `pending` dedicado.
- **Spam**: el endpoint público lleva **rate-limit** (`express-rate-limit`, ya usado
  en login) + honeypot. Idempotencia por `telegram_id`/`email` (índice único parcial
  ya en `014`): doble request del mismo `telegram_id` → un solo `pending`.
- **Escalación de rol en approve**: el aprobador asigna rol respetando
  `assertCanGrant` — debe **poseer** los permisos del bundle destino. Para otorgar
  `medico_primario/residente/especialista`, el rol del aprobador (supermedico/admin)
  debe contener esos permisos (validar en seed). Si no, el approve falla con 403.
- Test: doble `request-access` mismo `telegram_id` → un solo `pending`; approve con
  rol no-otorgable → 403.

---

## 13. Seguridad, PII y LOPDP

El caso lo ve gente que **no es el médico tratante** (el turno, los especialistas del
círculo). Controles:

1. **Redacción PII outbound al LLM** **[YA]** (PAPER §13.3.1): los campos `pii:true`
   de `entity_definitions.config.fields` se redactan en la frontera `cepi-bot → LLM`.
   La ingesta por texto libre (§10.2) clasifica sobre texto ya tratado.
2. **PII en frontera TodoERP → rol sin `pii:read:<slug>`** **[YA]** (R4): un
   especialista con `pii:read:patient` ve PII; un bundle sin ese permiso recibe la
   ficha redactada por el backend.
3. **PII en los canales externos (hueco a cerrar) [NUEVO]**: la redacción PII vive en
   la frontera bot→LLM y TodoERP→rol, **pero los reminders de derivación viajan por
   in_app/email/telegram/web_push sin pasar por el redactor**. Por lo tanto el
   **contenido de los reminders NO debe incluir PII**: `title`/`message` genéricos
   ("Caso #X derivado para revisión"); el detalle clínico se lee **en-app** tras pasar
   el filtro `pii:read:<slug>`. Los drivers email/telegram **nunca** vuelcan campos
   clínicos PII en el cuerpo. **Test obligatorio**: derivar caso con PII →
   `reminder.message` sin PII.
4. **Modo anonimizado / académico [definir, no solo "flag"]** (PAPER §10.5): para
   socializar sin identidad — especificar (a) la **lista de campos `pii:true`**
   ocultados; (b) render **server-side** por ausencia de `pii:read:patient`; (c)
   des-anonimización = **break-glass auditado**. **Decisión v1 (D-T6)**: derivación
   con PII solo a especialistas con `pii:read:patient`; anónimo como opción del
   primario al derivar.
5. **Break-glass** **[YA]** (PAPER §13.5): acceso ad-hoc auditado para casos
   huérfanos / urgencias fuera del círculo.
6. **Auditoría en `chatter`** **[YA/EXT]**: cada `request_review`/`claim`/`assign`
   deja note con `action` (y `request_review` con reviewers, estados, due_at). Claim,
   respuesta y cierre también dejan rastro.
   **Identidad dura para acciones clínicas [NUEVO]**: con actor `apikey:` o sin
   contexto, `created_by` puede ser NULL ("caller identity loss") — un diagnóstico o
   derivación sin médico real es un hueco LOPDP. **Rechazar (403)** claim/respuesta/
   derivación/cierre si no hay identidad de **usuario real** (no apikey, no null). El
   bot debe operar con **JWT por-usuario** (Telegram ya resuelve identidad). WhatsApp
   queda **fuera de acciones clínicas** hasta cerrar su gate (D-T5). Test:
   `request_review` con actor `apikey:` → 403.
7. **Consentimiento de teleconsulta [gate duro, no flag pasivo]**: compartir con
   terceros (el círculo) requiere consentimiento (LOPDP). Campo
   `consentimiento_teleconsulta` en el entity_def del **paciente** (en seed) con
   `timestamp` + `version` del texto. **Gate**: en las transiciones
   `en_curso→enviada` y `en_triage→derivada`, si `consentimiento_teleconsulta != true`
   → **422** (bloquea, no solo advierte). Registrar el consentimiento en chatter al
   derivar. Test: derivar sin consentimiento → rechazado.

---

## 14. Plan de fases incremental — slice v1 (Decisión 5A)

Cada fase es **desplegable y testeable** por separado. Estimación en jornadas-dev
(orientativas). Tests verde antes de cada cierre (`npx vitest run` en
`TodoERP/backend` y `cepi-bot`).

### Fase 0 — Cablear lo ya construido (cimiento) · ~1-1.5 d
**Casi todo el schema/router/driver ya existe; esto es cableado, no construcción.**
- **Montar** `app.use('/api/groups', groupsRouter)` en `app.ts` (hoy NO está; el
  router existe completo).
- **Sembrar** permisos genéricos `groups:read`, `groups:manage`, `entities:claim`,
  `entities:assign` en `database/seeds/` **base** (no medical-seed; deben servir a
  soporte/RRHH).
- **Tools MCP** en `mcp/src/tools.ts`: `groups.*` (+ members), `entities.claim`,
  `entities.assign`; y **extender** el schema de `entities.request_review` con
  `{group_id?, group_ids?}` + corregir su `description` (escribe columna tipada, no
  `data.estado`).
- **Consolidar** el duplicado `reviewRouter.ts` (eliminar `jsonb_set` obsoleto / fijar
  título; o delegar al handler principal). Resuelve el bug de `my-pending`.
- Tests: humo de `/api/groups`; `entities.claim` 409 en doble-claim; `request_review`
  a grupo expande vía `resolveGroupMemberIds` + dedupe multi-grupo + `message` sin PII.
- **Prueba de generalidad**: crear grupo "Soporte N2" + reclamar un ticket → debe
  funcionar sin código clínico.

### Fase 1 — Estados + campos del episodio (solo seed) · ~1 d
- Editar `medical-seed/001:86`, `005:57`, `005:296` (estados nuevos **sincronizados
  en los 3 lugares** — obligatorio por el gotcha del CHECK + falla silenciosa, §4.2).
- Agregar `responsable_actual_id`, `derivado_a`, `turno_claimed_by` en `001` (tras
  `e020`) y `005`.
- `reset-cepi.sh` + verificar que `reconcileColumnsOnStartup()` regenera el CHECK.
- Test: insertar episode con `estado='enviada'` (acepta) y con valor inválido
  (rechaza); derivar con estado nuevo presente en options (estado **sí** cambia).

### Fase 2 — Roles + servicio de transición + seed de círculos · ~1.5-2 d
- Extender `medical-seed/002_medical_roles_perms.sql` con 3 bundles (§5.2).
- `medical-seed/007_telemedicine.sql`: grupo "Dermatología" + membresías ficticias.
- `episodeStateService.transition(...)` **genérico** (valida arco+permiso+propiedad,
  §4.3) en la misma TX + `FOR UPDATE`. Gate de consentimiento (§13.7).
- Tests: login de cada rol nuevo, `getUserPermissions` contiene los strings ⊕;
  transición inválida → 422; sin consentimiento → 422.

### Fase 3 — Derivación a grupo end-to-end · ~1.5 d
- (Backend ya resuelve grupos.) Bot: regex `/escalar a grupo:<slug> <razón>` en
  `server.ts` + `/help` en `llm.ts` + `pending_action`.
- Enriquecer chatter con `group_ids`/`expanded_user_ids`.
- Tests: `cepi-bot/tests/server_commands.test.ts` (regex grupo); derivar a grupo →
  N reminders + chatter con `group_ids`; dedupe multi-grupo; `message` sin PII.

### Fase 4 — Bandeja + reclamar/asignar (estrategia default) · ~2 d
- Listado de bandeja (consulta `responsable_actual_id IS NULL` + grupo, sin tabla
  nueva). `claim`/`assign` ya hacen el resto.
- Frontend `cepi-frontend/src/components/Queue.vue` (lista + claim + respond + derive)
  o vía chat (`/bandeja`). v1 puede ser chat-driven (D-T1).
- Tests: claim atómico end-to-end + 409 visible; unclaim; reasignación por
  SLA/huérfano; transición inválida rechazada.

### Fase 5 — Activar Telegram + Web Push · ~1.5-2 d
- Env: `TELEGRAM_BOT_TOKEN`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` + lib `web-push`.
- `POST /api/push/subscribe` → inserta en `push_subscriptions` (drivers ya existen).
- **Claim atómico del scheduler** (`SELECT … FOR UPDATE SKIP LOCKED` / `status='sending'`)
  para evitar doble-envío de email/telegram/push.
- Reminder "Resultado disponible" al primario en `respondida`.
- Tests: `setDriver()` fake para telegram/web_push (patrón `reminders.test.ts`);
  scheduler no duplica envío; 410 Gone borra la suscripción por `endpoint`.

### Fase 6 — PWA + offline · ~2 d
- `vite-plugin-pwa`, manifest, SW, suscripción push, cola offline con `client_msg_id`
  + dedupe backend (§11).
- Smoke: instalar PWA, recibir push de "Resultado disponible"; replay de cola
  idempotente.

### Fase 7 — Ingesta texto libre + gate · ~1-2 d
- Camino LLM tool-use en `cepi-bot` que extrae ficha → `pending_action` (gate).
- Tests: texto → propuesta → confirmación sí/no idempotente → `entities.update`.

### Fase 8 — Registro mejorado (mínimo) · ~1.5-2 d
- `request-access` (público + rate-limit + honeypot) + `registrations/:id/approve`
  (§12). Asignación de rol con `assertCanGrant`.
- Tests: doble request mismo `telegram_id` → un `pending`; approve con rol
  no-otorgable → 403.

**Total v1 orientativo: ~13-16 jornadas-dev** (Fase 0 baja porque grupos/claim/
drivers ya existen). Las fases 0-4 ya entregan el ciclo "crear → bandeja → reclamar →
responder/derivar → notificar (in_app/email)"; 5-8 suman canales externos, PWA, texto
libre y registro.

---

## 15. Riesgos y mitigaciones (específicos de telemedicina)

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Caso sin dueño** (nadie reclama la bandeja) | paciente sin respuesta | SLA: reminder de escalada (§9) a supermedico tras X horas (default +24 h, parametrizable por `user_groups.data`); `assign` manual. Arco `derivada→en_triage` (§4.3). |
| **Derivación sin respuesta** del círculo | caso estancado en `derivada` | reminder recurrente + escalada a supermedico; reasignación (`entities:assign`). |
| **PHI a especialistas no tratantes** | LOPDP | reminders **sin PII** (§13.3); `pii:read:patient` por rol; detalle solo en-app; modo anonimizado; break-glass auditado. |
| **Conflicto de claim** (dos reclaman a la vez) | doble triage | `claim.ts` atómico `FOR UPDATE` → 409 (salvo override `entities:assign`); UI re-consulta. |
| **Doble envío del scheduler** (sin SKIP LOCKED) | email/telegram/push duplicados | claim atómico `status='sending'` antes de enviar (Fase 5). |
| **Transición de estado ilegal** | salto de estados / actor sin derecho | `episodeStateService.transition()` valida arco+permiso+propiedad; el CHECK solo valida el valor. |
| **Estado escrito en JSONB obsoleto** (`reviewRouter`) | fuente de verdad divergente | consolidar en Fase 0; escribir solo la columna tipada. |
| **`my-pending` no lista los `/escalar`** | bandeja incompleta | dejar de filtrar por título; usar `changes.action` o campo semántico (Fase 0). |
| **Conflictos offline** (cola choca con estado servidor) | datos inconsistentes | `client_msg_id` + dedupe backend que devuelve resultado previo; envío-a-bandeja idempotente; adjuntos: subir antes de referenciar. |
| **Estados desincronizados** (CHECK vs UI vs nav) + **falla silenciosa** | derivación 201 pero estado sin cambiar | sincronizar los 3 lugares en Fase 1 (gotcha §4.2). |
| **Identidad perdida en WhatsApp / apikey** | auditoría sin actor real | acciones clínicas exigen JWT por-usuario; rechazar `apikey:`/null (§13.6); WhatsApp fuera de acciones clínicas (D-T5). |
| **Rotación (modo B) con race** | mismo miembro o salto | `FOR UPDATE` sobre la fila `user_groups` al avanzar `last_assigned_index`; saltar inactivos. |
| **LLM sin tool-use** (DeepSeek sin key) | ingesta texto libre no funciona | feature flag; degradar a flujo guiado; Claude CLI como adaptador v1. |

---

## 16. Decisiones abiertas

| ID | Pregunta | Recomendación |
|---|---|---|
| **D-T1** | ¿Bandeja como componente `Queue.vue` o chat-driven? | v1 **chat-driven** (más rápido, reusa `BotForm`); `Queue.vue` en v1.5. |
| **D-T2** | ¿Reminder al enviar a bandeja por usuario, o solo el listado? | Solo listado + un in_app liviano por miembro; evita ruido de email por caso. |
| **D-T3** | ¿`assignment_strategy` en `user_groups.data` o columna dedicada? | **JSONB en `data`** (genérico, sin migración por estrategia nueva). |
| **D-T4** | ¿Respuesta del residente requiere co-firma del especialista? | v1 **no**; flag `requires_cosign` en `user_groups.data` para v1.5. |
| **D-T5** | ¿WhatsApp con identidad por usuario como Telegram? | Postergar; fuera de **acciones clínicas** hasta cerrar el gate en `whatsapp.ts` (v2). |
| **D-T6** | ¿Círculo anónimo por defecto o con PII? | Default **con PII** a `pii:read:patient`; anónimo como opción del primario; reminders siempre sin PII. |
| **D-T7** | ¿Recursión de grupos (subgrupos)? | **No** en v1 (flat, espejo del modelo user→role). |
| **D-T8** | ¿`request_review` a grupo crea fila de asignación o solo reminders? | **Solo reminders** (ya implementado). El reparto interno del círculo, si se quiere, vía `claim` sobre el episode (sin tabla nueva). |
| **D-T9** | ¿Cierre automático tras respuesta o confirmación del primario? | Confirmación del primario; auto-cierre por hook si no hay objeción en N días. |
| **D-T10** | ¿Preferencias de canal por usuario en v1? | No; canales fijos por evento. `users.data.notify_channels` en v1.5. |
| **D-T11** | ¿Metadata por miembro (`on_call`/`expertise`) en `user_group_members`? | v1 **no** (turno se modela en el episode). Si hace falta: migración 016 `ADD COLUMN data jsonb` + GIN + extender `groupsRouter` members. |

---

### Apéndice — Archivos clave (referencia rápida, verificada)

- Derivación: `TodoERP/backend/src/routes/entities/requestReview.ts` (acepta
  `group_id`/`group_ids`, escribe columna tipada, usa `resolveGroupMemberIds`) ·
  duplicado obsoleto `routes/reviewRouter.ts` (escribe `data.estado`, título sin
  sufijo) · montados en `entitiesRouter.ts:26` y `app.ts:136` · tool
  `TodoERP/mcp/src/tools.ts:126-139` · comando `cepi-bot/src/server.ts:1260`.
- Asignación/turno: `routes/entities/claim.ts` (`entities:claim`,
  `responsable_actual_id`/`turno_claimed_by`) · `routes/entities/assign.ts`
  (`entities:assign`) · montados en `entitiesRouter.ts:27-28`.
- Grupos: `migrations/015_user_groups.sql` (`user_groups`/`user_group_members`/
  `push_subscriptions`) · `routes/groupsRouter.ts` (CRUD + members,
  `resolveGroupId`/`resolveGroupMemberIds:50-61`, permisos `groups:read`/
  `groups:manage`) — **NO montado en `app.ts`**.
- Reminders/canales: `services/reminderScheduler.ts` ·
  `services/channels/registry.ts:44-48` (drivers `in_app`/`email`/`telegram`/
  `web_push` ya registrados) · `channels/{inApp,email,telegram,webPush}.ts` ·
  `migrations/004_reminders.sql`.
- Episodio/estados: `medical-seed/001_medical_definitions.sql:86` (field `e020`,
  select) · `005_medical_forms_navs.sql:57,296` · `services/columnSyncService.ts`
  (CHECK solo para select con options).
- Roles/permisos: `medical-seed/002_medical_roles_perms.sql:26-28` (paciente/medico/
  supermedico), `:117,130` (admin_clinical_extras/guest_clinical), `:142-146`
  (vínculos) · base `database/002_seed.sql` (admin/guest) · `services/authService.ts`
  · `middleware/authMiddleware.ts`.
- Identidad externa: `authRouter.ts:86-126` · `cepi-bot/src/telegram.ts:73-106` ·
  `migrations/014_external_id_unique.sql`.
- Ficha bot: `cepi-bot/src/flowV1.ts` (`FICHA_GROUP_SPEC`, `FICHA_EPISODE_KEYS`,
  `ficha_grp_*`).
- Frontend/PWA: `cepi-frontend/{index.html,vite.config.js,package.json}` ·
  `src/components/{Chat.vue,BotForm.vue}` · `src/api.js`.
