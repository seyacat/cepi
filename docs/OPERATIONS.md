# cepi — Operaciones

Manual operacional para administradores del despliegue. Cubre arranque, monitoreo, backup/restore, retención, troubleshooting y endurecimiento.

Para arquitectura y plan de fases ver [`PAPER.md`](PAPER.md). Para estado actual de capacidades ver [`STATUS.md`](STATUS.md).

---

## 1. Topología

```
host (Windows + WSL2)
├── postgres (WSL Ubuntu, :5432)            datos + pgvector
├── todoerp-backend  (PM2, :3001)           ERP + hooks médicos (CEPI_MEDICAL=1)
├── todoerp-frontend (PM2, :5173)           admin TodoERP
├── cepi-bot         (PM2, :3002)           agente conversacional + MCP loop
├── cepi-frontend    (PM2, :5174)           UI de chat médico
└── cepi-isic        (PM2, :8000, opcional) servicio Python ISIC (stub o GPU)
```

PM2 controla los 5 procesos vía `ecosystem.config.cjs`. PostgreSQL corre dentro de WSL y el host la consume por `localhost:5432`.

---

## 2. Variables de entorno por proceso

### todoerp-backend
| Var | Default DEV | Producción |
|---|---|---|
| `STAGE` | `DEVELOP` | `PROD` |
| `JWT_SECRET` | (cualquiera) | obligatorio, ≥32 chars |
| `DB_HOST/PORT/NAME/USER/PASSWORD` | localhost / 5432 / cepi / postgres / cerebro | secretos rotables |
| `CORS_ORIGINS` | `*` | lista explícita (admite globs `https://*.dominio.com`) |
| `CEPI_MEDICAL` | `1` | `1` (registra hooks médicos) |
| `LOGIN_RATE_LIMIT_MAX` | 200 | 10 |
| `BREVO_API_KEY` | — | requerido si usas el canal `email` de reminders |

### cepi-bot
| Var | Notas |
|---|---|
| `TODOERP_API_URL` | URL del backend ERP (default `http://localhost:3001`) |
| `CEPI_LLM_PROVIDER` | `stub` (default) o `deepseek` |
| `DEEPSEEK_API_KEY` | requerido cuando provider=deepseek |
| `CEPI_GUEST_API_KEY` | API key con rol `guest` para chat anónimo |

### cepi-isic
Configuración en `cepi-isic/.env` (puerto 8000, modo stub/torch). Ver `cepi-isic/README.md`.

---

## 3. Operación diaria

```powershell
pm2 status                               # estado de los 5 servicios
pm2 logs cepi-bot --lines 100            # logs en vivo
pm2 restart todoerp-backend              # rotar un proceso
pm2 reload all                           # recarga sin downtime (zero-downtime si cluster)
pm2 save                                 # persistir lista para `pm2 resurrect` post-reboot
pm2 startup                              # generar script de auto-arranque (Linux/macOS)
```

En Windows el equivalente a `pm2 startup` es:

```powershell
npm i -g pm2-windows-startup
pm2-startup install
pm2 save
```

### Endpoints de salud
- `GET http://localhost:3001/health` — TodoERP backend
- `GET http://localhost:3002/health` — cepi-bot
- `GET http://localhost:8000/health` — cepi-isic (cuando esté arriba)

Cualquier monitoreo externo (Uptime Kuma, Grafana, etc.) puede pollearlos cada 30s.

---

## 4. Backup y restore

### 4.1 Backup manual

WSL / Linux / macOS:
```bash
bash scripts/backup-db.sh
```

Windows nativo (sin WSL):
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-db.ps1
```

Ambos producen `backups/cepi_<UTC-timestamp>.sql.gz`, podan archivos > `BACKUP_PRUNE_DAYS` (default 14) y respetan las variables `DB_HOST/PORT/NAME/USER/PASSWORD`.

### 4.2 Backup automatizado

**Linux (cron del usuario):**
```cron
# /etc/cron.d/cepi-backup — diario 02:30 local
30 2 * * *  cepi  cd /opt/cepi && bash scripts/backup-db.sh >> /var/log/cepi-backup.log 2>&1
```

**Windows (Task Scheduler):**
```powershell
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File D:\cepi\scripts\backup-db.ps1' `
    -WorkingDirectory 'D:\cepi'
$trigger = New-ScheduledTaskTrigger -Daily -At 2:30am
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
Register-ScheduledTask -TaskName 'cepi-backup-db' -Action $action -Trigger $trigger -Principal $principal
```

**Verificación periódica:** restaurar el backup más reciente en una BD efímera al menos una vez por trimestre — un backup que nunca se restauró no es un backup.

### 4.3 Restore

```bash
# preparar BD destino vacía
sudo -u postgres dropdb cepi_restore || true
sudo -u postgres createdb cepi_restore

# restaurar
gunzip -c backups/cepi_<stamp>.sql.gz | psql -h localhost -U postgres -d cepi_restore

# si la extensión pgvector no estaba precreada, agregar antes:
psql -U postgres -d cepi_restore -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Para activar el restore como producción: parar PM2, renombrar las BDs (`ALTER DATABASE`), reiniciar PM2.

### 4.4 Volumen de `vector_embeddings`

PAPER §15 advierte que esta tabla puede crecer. Si los dumps superan ~500MB:
- Considerar `pg_dump --exclude-table=vector_embeddings` para backups frecuentes y un dump completo semanal.
- Los embeddings son re-computables desde `clinical_image` corriendo el worker `clinicalImageProcessor`, así que pueden tratarse como cache.

---

## 5. Retención y purga

> Estado: política y herramientas listas, automatización vía reminders nocturnos pendiente (Phase 9). Hasta entonces, ejecutar manualmente.

Datos que típicamente se purgan:
- `bot_session` con `estado='cerrada'` y `updated_at < now() - 90 días`.
- `reminders` con `status in ('sent','failed','cancelled')` y `last_attempt_at < now() - 180 días`.
- `chatter` huérfano (entity ya eliminada por cascada — la cascada lo cubre).
- `clinical_image` con `created_at` > N años (definir con cumplimiento legal antes de borrar; preferir anonimizar imagen y dejar el episodio).

**Plantilla de purga ad hoc:**
```sql
BEGIN;
-- Sesiones de bot cerradas hace > 90d
DELETE FROM entity_bot_session
 WHERE estado = 'cerrada' AND updated_at < NOW() - INTERVAL '90 days';

-- Reminders despachados o caídos hace > 180d
DELETE FROM reminders
 WHERE status IN ('sent','failed','cancelled')
   AND COALESCE(last_attempt_at, updated_at) < NOW() - INTERVAL '180 days';

-- Permisos temporales caducados hace > 30d (audit ya está en chatter)
DELETE FROM temporary_permissions
 WHERE expires_at < NOW() - INTERVAL '30 days';
COMMIT;
```

Correr siempre **después** de un backup verde.

---

## 6. Logs y observabilidad

- **PM2** — `pm2 logs <name>`, `~/.pm2/logs/`. Rotación: `pm2 install pm2-logrotate`.
- **TodoERP backend** — formato lineal con prefijo `[modulo]`. En `STAGE=DEVELOP` envía `X-Security-Report` con cada respuesta (no exponer en prod).
- **cepi-bot** — loggea cada tool-call con tipo y tiempo. La transcripción de chat se persiste como `bot_session.data.turns[]`.
- **PostgreSQL** — `log_min_duration_statement = 500` para detectar queries lentas; `auto_explain` para los planes.

Métricas útiles para alertar:
| Métrica | Umbral |
|---|---|
| `5xx` rate en `/api/*` | > 1 req/min sostenido |
| `p95` latencia POST `/api/bot/chat` | > 5s |
| `reminders` con `status='failed'` (último día) | > 0 |
| Espacio libre en disco de PG | < 20% |
| Edad del último backup | > 26h |

---

## 7. Endurecimiento (checklist de promoción a producción)

- [ ] `STAGE=PROD` (cierra el bypass DEV de escalación de privilegios y baja el rate limit del login).
- [ ] `JWT_SECRET` en secret manager (≥32 chars aleatorios), distinto del de staging.
- [ ] `CORS_ORIGINS` con lista explícita (sin `*`).
- [ ] HTTPS terminado en reverse proxy (Caddy/Traefik/nginx), HSTS habilitado.
- [ ] Postgres: `pg_hba.conf` `scram-sha-256`, sin `trust`. Usuario aplicación distinto de `postgres`.
- [ ] `CEPI_GUEST_API_KEY` rotable; rol `guest` con permisos mínimos.
- [ ] Backup automatizado configurado **y** restore probado (§4).
- [ ] Pseudoanonimización outbound al LLM verificada — el agente debe recibir tools result ya redactados (PAPER §13.3.1; Phase 9 pendiente).
- [ ] Política de retención agendada (§5).
- [ ] Monitoreo de `5xx`, latencia de bot, edad del backup.
- [ ] Plan de rotación de `DEEPSEEK_API_KEY` / `BREVO_API_KEY`.
- [ ] Runbook de incidente (sección 8) impreso/al alcance.

---

## 8. Runbook de incidentes comunes

### "Demasiados intentos de login"
Rate limit de express-rate-limit. En DEVELOP el contador es in-memory; reiniciar `pm2 restart todoerp-backend` lo resetea. En producción, esperar la ventana (15 min) o ajustar `LOGIN_RATE_LIMIT_MAX` y reiniciar.

### El bot responde "tool call falló: …"
1. `pm2 logs cepi-bot` — revisar el error MCP.
2. `pm2 logs todoerp-backend` — ¿la API del ERP responde?
3. `curl http://localhost:3001/health` — descartar caída.
4. Si MCP arrancó con stale build: `cd TodoERP/mcp && npx tsc && pm2 restart cepi-bot`.

### Reminders no se envían
1. `SELECT status, count(*) FROM reminders GROUP BY 1;` — distribución actual.
2. `pm2 logs todoerp-backend | rg reminderScheduler` — ¿el scheduler está ticking? (cada 30s).
3. Si todos están `failed` con error de canal: revisar `BREVO_API_KEY` o el driver del canal.
4. Reset puntual: `UPDATE reminders SET status='pending', attempts=0 WHERE id=...;`.

### El frontend no carga datos / 401
1. Verificar token en `localStorage.cepi.jwt` no esté caducado.
2. CORS: revisar `CORS_ORIGINS` incluya el origen del frontend.
3. Network tab: ¿el backend responde 503? Probable que Postgres se cayó.

### Postgres se quedó sin espacio
1. `du -sh ~/postgres-data` (o donde esté el cluster).
2. Mayor culpable habitual: `vector_embeddings`. `VACUUM FULL vector_embeddings;` o moverlas a otro tablespace.
3. Backups dentro del mismo disco: revisar `BACKUP_PRUNE_DAYS`.

### Worker `clinicalImageProcessor` no procesa imágenes
1. ¿`cepi-isic` está arriba? `curl http://localhost:8000/health`.
2. Logs del backend: `pm2 logs todoerp-backend | rg clinicalImageProcessor`.
3. La cola se inspecciona con `SELECT id, status, last_error FROM entity_clinical_image WHERE status IS NULL OR status = 'queued';`.

---

## 9. Tests pre-deploy

```bash
# Backend ERP — full suite
cd TodoERP/backend && npx vitest run

# Bot
cd cepi-bot && npx vitest run

# Frontend admin (Playwright, serial para 100% reliability)
cd TodoERP/frontend && npm run test:e2e -- --workers=1
```

Total ~202 tests entre backend ERP y bot. Cero regresiones acumuladas según `STATUS.md`.

---

## 10. Despliegue alternativo: docker-compose

`docker-compose.yml` levanta postgres + todoerp-backend en contenedor. No es la vía soportada para producción todavía (el frontend admin y cepi-bot no están dockerizados aún). Útil para reproducir bugs en una BD limpia sin tocar la del host:

```bash
docker compose up -d postgres todoerp-backend
docker compose logs -f todoerp-backend
docker compose down -v       # destruye datos también
```
