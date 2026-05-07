# CLAUDE.md — repositorio cepi

Guía para Claude Code y para devs nuevos.

## Lo que vive aquí

```
cepi/
├── docs/PAPER.md         arquitectura + plan de fases (LEER PRIMERO)
├── docs/STATUS.md        progreso al cierre de sesión
├── README.md             quick start operacional
├── ecosystem.config.cjs  PM2 con los 4 servicios JS + 1 Python
├── docker-compose.yml    deploy alternativo
├── scripts/              reset, dev-token, dev-chat, backup
├── TodoERP/              submódulo: ERP genérico + MCP server
├── cepi-bot/             agente conversacional (HTTP + MCP client)
├── cepi-frontend/        UI de chat (Vue 3 + Vite)
├── cepi-isic/            servicio Python de embeddings/clasificación
├── backend/              chatbot legacy (DeepSeek + tree.js) — sin PM2
└── frontend/             site público legacy CEPI — sin PM2
```

`backend/` y `frontend/` quedan como referencia histórica y no se
mantienen activamente. La capa medical vive en `cepi-bot` + `cepi-frontend`.

## Reglas de trabajo

- **Paper-first**: cambios estructurales pasan primero por `docs/PAPER.md`. El plan de fases del paper §15 manda.
- **TodoERP genérico, cepi medical**: `TodoERP/` no debe contener vocabulario clínico. Si una capacidad parece útil para más de un dominio, vive en TodoERP. La opt-in al pipeline médico se hace con `CEPI_MEDICAL=1` en el backend.
- **Confirmation gate**: ninguna escritura clínica se persiste sin confirmación explícita del usuario (PAPER §13.3.1, D-Aux-1). El patrón vive en `cepi-bot/src/server.ts` (pending_action).
- **PII**: campos con `pii: true` en `entity_definitions.config.fields` se redactan al cruzar dos fronteras: `cepi-bot → LLM` (PAPER §13.3.1) y `TodoERP → role sin pii:read:<slug>` (R4 de REFACTOR_PLAN). Ambas implementadas.
- **Tests verde antes de commit**: `npx vitest run` en `TodoERP/backend` y `cepi-bot`. Total actual ~202 tests.
- **Git**: el subm `TodoERP/` tiene su propio remote (`seyacat/TodoERP`); el cepi raíz lo apunta por SHA. Hay una rama feature por concern (`feat/generic-fase1` en TodoERP, `feat/medical-assistant` en cepi).

## Cuando agregás...

### un comando del bot
1. Regex en `cepi-bot/src/server.ts` antes del fallthrough al LLM.
2. Si es escritura: `pending_action`. Si lectura: tool call directo.
3. Línea en `/help` (`cepi-bot/src/llm.ts`).
4. Botón en `cepi-frontend/src/components/Chat.vue` si es de uso frecuente.
5. Test de regex en `cepi-bot/tests/server_commands.test.ts`.

### una tool MCP
1. Entrada en `TodoERP/mcp/src/tools.ts`.
2. Restart MCP. El bot lo detecta vía `listTools()`.
3. Si la tool exige permisos nuevos, agregarlos a `database/seeds/*.sql`.

### una capacidad del ERP (genérica)
1. Migración SQL en `TodoERP/database/migrations/`.
2. Permisos en `TodoERP/database/seeds/`.
3. Router/service nuevo siguiendo la convención R9 (>300 LOC ⇒ split).
4. Test en `TodoERP/backend/tests/`.
5. Documentar en `TodoERP/CLAUDE.md` si introduce un patrón.

### una entidad clínica nueva
1. Definir el `entity_definition` en `medical-seed/001`.
2. Form + nav en `medical-seed/005`.
3. Permisos en `002` si aplica.
4. Si tiene relaciones, no olvides los inversos.
5. Idempotencia: usar `ON CONFLICT (id) DO UPDATE`.

### un hook de ciclo de vida
1. Handler en `TodoERP/backend/src/hooks/medical.ts` (o `domain.ts`).
2. Registrar vía `registerHook(...)` en una factory; llamarla en `app.ts` con la guarda env adecuada.
3. Declarar `config.hooks.on_create|on_update|on_delete` en el `entity_definition` correspondiente.
4. Test que dispara el evento y verifica el efecto.

## Atajos útiles

```powershell
# Levantar todo
pm2 start ecosystem.config.cjs

# Reset DB con datos médicos + ficticios
bash scripts/reset-cepi.sh --with-fake-data

# Smoke conversacional
bash scripts/dev-chat.sh --new "/help"

# Backup
bash scripts/backup-db.sh
```
