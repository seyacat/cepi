# Plan — Organizaciones (multi-tenancy)

> Estado: **propuesta / pendiente de implementar**. Este doc es el checklist + tareas + tests.

## 0. Requerimientos (del usuario)
1. Un médico puede pertenecer a **una o varias** organizaciones.
2. El **paciente es independiente** de la organización: un médico puede buscar un paciente de otra organización pero **no ver sus chats**; debe crear chat y fichas nuevas. Solo se comparte la **información personal** del paciente.
3. Una **ficha (episodio)** pertenece a una organización.
4. Un **chat (bot_session)** pertenece a una organización.
5. El **superadmin** administra organizaciones (global).
6. El **admin** administra solo las organizaciones a las que pertenece.

## 1. Idea clave (encaja con el modelo actual)
El sistema ya separa **paciente** (datos personales, `entity_patient`) de **episodio** (encuentro clínico, `entity_episode`) y **chat** (`entity_bot_session`).
- **Paciente = global** (compartido entre orgs) → cumple #2 "solo información personal".
- **Episodio + chat = scoped por `org_id`** → cumplen #3 y #4.
- Un médico en otra org ve al paciente (personal) pero **0 fichas / 0 chats** de orgs ajenas → empieza de cero.

## 2. Modelo de datos (migración `016_organizations.sql`)
- **`organizations`**: `id uuid pk, slug unique, name, active, data jsonb, created_at, updated_at` (infra, como `user_groups`).
- **`user_organizations`** (M:N, espeja `user_group_members`): `org_id fk, user_id fk, role_in_org varchar('admin'|'member'), PK(org_id,user_id)`.
- **`entity_episode.org_id`** `uuid NOT NULL` (FK organizations) + índice `(org_id, patient_id)`.
- **`entity_bot_session.org_id`** `uuid NOT NULL` (FK organizations) + índice `(org_id, active_patient_id)`.
- **`entity_patient`**: SIN `org_id` (global).
- Entidades hijas del episodio (`entity_diagnosis`, `entity_clinical_image`, `entity_consent`, `entity_prescription`, `entity_lab_order`): agregar `org_id` (denormalizado desde el episodio) para filtrar/auditar simple.
- Para que `org_id` viaje por `entities.create`/shadow-sync, declararlo como **field oculto** en los `entity_definition` de episodio (12…) y bot_session (17…) en `001_medical_definitions.sql` (type relationship→org, status hidden), así `columnSyncService` materializa la columna y el bot solo incluye `org_id` en `data`.

## 3. Identidad y contexto de "org activa"
- Un usuario puede estar en varias orgs → necesita una **org activa** (la que está usando).
- **JWT** += `org_id` (org activa). En login se elige una por defecto (su primera membresía).
- **Endpoint `POST /api/orgs/switch`** `{org_id}` → valida membresía → reemite token con esa `org_id`. (`authService` genera el token; agregar `org_id` al payload — ver `authService.ts:78-85`.)
- `getUserPermissions` no cambia (permisos siguen por rol); el scope por org es a nivel de query (scoping implícito — recomendado por ambos mapeos).
- `verifyToken` expone `req.user.org_id`; helper `getUserOrgs(userId)` y `isOrgAdmin(userId, orgId)` (consultan `user_organizations`).

## 4. Scoping de lectura/escritura (backend)
Agregar `AND org_id = $orgActiva` en los gates clínicos (además del view_own/view_all existente, que queda **acotado dentro de la org**; solo el superadmin cruza orgs):
- `routes/patientThreadRouter.ts` — filtrar `entity_bot_session` por `s.org_id = :org` (req #2/#4).
- `routes/reviewQueueRouter.ts` — unir/filtrar por `org_id` del episodio del reminder (req #4).
- `routes/patientAssignmentsRouter.ts` — filtrar episodios por `org_id` (req #3).
- `routes/entities/getList.ts` — para defs episodio(12…)/bot_session(17…)/hijas: inyectar `WHERE org_id = :org`. (También cerrar el gap existente de `view_own` sin filtro.)
- `routes/entities/requestReview.ts` — los `reviewers`/miembros de círculo resueltos deben pertenecer a la **misma org**; el reminder/episodio quedan en esa org.
- **Patient list** (`entity_patient`): NO se filtra por org (global). Búsqueda por cédula encuentra al paciente compartido (dedupe por cédula).

## 5. Creación con `org_id` (cepi-bot)
- `cepi-bot/src/server.ts` `openEpisodeFicha()` (~46-68): incluir `org_id` (de `auth.whoami` → que ahora devuelve `org_id` del JWT) en `data` del episodio.
- `cepi-bot/src/sessionStore.ts` `createSession()` (~97-110): incluir `org_id` en `data` de la sesión.
- `cepi-bot/src/flowV1.ts` creación de paciente (~450): **NO** poner org_id (paciente global); al abrir un paciente sin episodios/chats de la org activa → arrancar ficha/chat nuevos (ya es el comportamiento si el thread viene vacío para esa org).
- `auth.whoami` (MCP/tool) debe propagar `org_id` desde el JWT con el que se spawnea el MCP.

## 6. Administración de organizaciones
- **`routes/orgsRouter.ts`** (nuevo):
  - `GET /api/orgs` — superadmin: todas; admin: solo las suyas.
  - `POST /api/orgs` / `PUT /api/orgs/:id` / `DELETE` — **solo superadmin** (`organizations:manage`).
  - `POST /api/orgs/:id/members` `{user_id, role_in_org}` / `DELETE /api/orgs/:id/members/:user_id` — superadmin (cualquier org) u **org-admin de esa org**.
  - `GET /api/orgs/:id/members`.
  - `POST /api/orgs/switch`.
- **Permisos** (`medical-seed/002`): nuevo `organizations:manage` en el bundle del superadmin (rol con `allow_grant_all` ya tiene wildcard; agregar el permiso explícito para claridad). El **org-admin** se distingue por `user_organizations.role_in_org='admin'` (no es un rol global), y los endpoints lo verifican por org.
- Distinción: **superadmin** = `allow_grant_all` (global, gestiona orgs); **admin de org** = `role_in_org='admin'` en `user_organizations` (gestiona solo su org).

## 7. Frontend (cepi-frontend)
- **Selector de org activa** en el topbar (`App.vue`): muestra la org actual; si el usuario tiene varias, dropdown para cambiar → `POST /api/orgs/switch` → re-login con el nuevo token → recargar.
- **Búsqueda de paciente cross-org**: al abrir un paciente sin actividad en la org activa, el chat arranca vacío (ficha nueva) y la ficha pre-llena los **datos personales** del paciente global (ya sale del `entity_patient`).
- **Admin de orgs** (UI): superadmin → CRUD orgs + asignar usuarios/admins; org-admin → gestionar miembros de su(s) org(s).
- Mostrar la org en la card/ficha cuando sea útil.

## 8. Migración de datos existentes
- Crear org por defecto `"CEPI"` (slug `cepi`).
- Backfill: `UPDATE entity_episode SET org_id = <cepi>` y `entity_bot_session SET org_id = <cepi>` (y entidades hijas).
- `INSERT user_organizations (org=cepi, user, role_in_org)` para todos los usuarios existentes (admins existentes → `'admin'`).
- Verificar 0 filas con `org_id` nulo antes de poner `NOT NULL`.

---

## ESTADO
- **Fase 1 (modelo + migración) — HECHO** (local + prod): migración `016_organizations.sql`, `org_id` reservado en `columnSyncService`.
- **Fase 2 (identidad + scoping) — HECHO** (local + prod): `org_id` en JWT (login/me), `getUserOrgs/isOrgAdmin/isOrgMember`, `orgsRouter` (GET /api/orgs + POST /switch), estampado de `org_id` al crear (entityTableService), scoping por org en patient-thread/review-queue/patient-assignments/getList, y **dropdown de org activa** en el topbar. E2E verde (paciente global, chats/fichas aislados por org).
- **Fase 3 (administración) — HECHO** (local; deploy en curso): orgsRouter CRUD (crear/editar/desactivar org = superadmin; miembros = superadmin o admin-de-org), componente `AdminOrgs.vue` (tab en Admin). Gating verificado (req 5/6).
- **Pendiente menor**: reset-safety del `org_id` en reset fresco (las migraciones corren antes de materializar `entity_*`); request_review cross-org (impedir derivar a otra org).

## CHECKLIST (alto nivel)
- [x] Migración `016`: `organizations`, `user_organizations`, `org_id` en episode/bot_session (+hijas), índices.
- [x] `org_id` en `RESERVED_COLS` (columnSync no la borra).
- [ ] `entity_definition` episodio/bot_session: field `org_id` oculto (columnSync).
- [ ] JWT lleva `org_id` activa; `auth.whoami` lo expone; `POST /api/orgs/switch`.
- [ ] Helpers `getUserOrgs` / `isOrgAdmin`.
- [ ] Scoping por org en: patient-thread, review-queue, patient-assignments, getList(episodio/session/hijas), request_review.
- [ ] cepi-bot inyecta `org_id` al crear episodio y sesión.
- [ ] Paciente sigue global (sin org_id); dedupe por cédula.
- [ ] `orgsRouter` (CRUD orgs + miembros + switch) con gates superadmin vs org-admin.
- [ ] Seed: permiso `organizations:manage` (superadmin) + org `CEPI` por defecto.
- [ ] Frontend: selector de org activa + UI admin de orgs.
- [ ] Migración de datos existentes (backfill `org_id` + memberships) → luego `NOT NULL`.
- [ ] Tests (abajo) verdes; deploy.

## TAREAS (granular, por archivo)
1. **DB**: `database/migrations/016_organizations.sql` (tablas + columnas + índices + FKs). Backfill en `016` o script aparte `scripts/backfill-orgs.sh`.
2. **Seed**: `medical-seed/002` → permiso `organizations:manage`; nuevo `medical-seed/008_organizations.sql` (org `CEPI` + memberships base). Documentar en `apply.sh`.
3. **Definitions**: `medical-seed/001` → field `org_id` (hidden) en defs 12… y 17…; verificar `columnSyncService` lo materializa.
4. **authService.ts**: `org_id` en JWT (78-85); helpers `getUserOrgs`, `isOrgAdmin`; login elige org por defecto.
5. **authMiddleware.ts**: exponer `req.user.org_id`.
6. **orgsRouter.ts** (nuevo) + montar en `app.ts`.
7. **Gates**: editar `patientThreadRouter.ts`, `reviewQueueRouter.ts`, `patientAssignmentsRouter.ts`, `entities/getList.ts`, `entities/requestReview.ts` para filtrar por `org_id`.
8. **cepi-bot**: `server.ts` (openEpisodeFicha), `sessionStore.ts` (createSession), `auth.whoami`/MCP → propagar `org_id`.
9. **Frontend**: `App.vue` selector de org; `api.js` `switchOrg/listOrgs/...`; componente `AdminOrgs.vue`.
10. **Tests** (backend vitest + E2E) — ver abajo.

## TESTS (mapeados a los requerimientos)
Backend (`TodoERP/backend/tests/organizations.test.ts`) + bot (`cepi-bot/tests/`) + E2E manual con usuarios demo en 2 orgs.

- **T1 (req1)** Membresía múltiple: agregar un médico a Org A y Org B; `getUserOrgs` devuelve ambas; `switch` entre ellas reemite token con la `org_id` correcta.
- **T2 (req2 — aislamiento de chats/fichas)**: Med A (org A) crea paciente P + ficha + chat. Med B (org B) busca P por cédula → **encuentra P** (datos personales) pero `patient-thread` y `patient-assignments` devuelven **0 chats / 0 fichas** de org A.
- **T3 (req2 — empezar de cero)**: Med B abre P → crea **nueva** ficha + **nuevo** chat con `org_id = B`; no aparecen en la vista de org A (y viceversa).
- **T4 (req2 — solo personal)**: la ficha nueva en org B **pre-llena** nombre/cédula/fecha_nac/sexo (de `entity_patient`) pero **sin** historia clínica de org A.
- **T5 (req3)** Episodio creado en org A tiene `org_id=A`; `getList` de episodios como org B no lo retorna.
- **T6 (req4)** Sesión creada en org A tiene `org_id=A`; `patient-thread` como org B la excluye.
- **T7 (req5)** Superadmin: `POST/PUT/DELETE /api/orgs` OK; asigna usuarios y org-admins; ve todas las orgs.
- **T8 (req6)** Org-admin de A: gestiona miembros/datos de A; **403** al tocar org B o al `POST /api/orgs` (crear org global).
- **T9 (aislamiento transversal)** review-queue, patient-assignments y patient-thread quedan filtrados por org activa en todos los roles.
- **T10 (migración)** Tras backfill: 0 episodios/sesiones con `org_id` nulo; flujos existentes siguen funcionando; `NOT NULL` aplica sin error.
- **T11 (seguridad)** Un usuario sin membresía en org X **no** puede leer/escribir episodios/sesiones de X ni con `view_all` (view_all queda acotado a la org). Solo superadmin cruza orgs.
- **T12 (request_review cross-org)** No se puede derivar/escalar a un usuario o círculo de otra org; reviewers se resuelven dentro de la org.
- **E2E** con el bot-debugger: 2 orgs, med A y med B sobre el **mismo paciente** (misma cédula) → cada uno ve solo su hilo; la campana y "a cargo" respetan la org.
