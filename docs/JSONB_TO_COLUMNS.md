# Migración JSONB → columnas reales en `entity_<slug>`

**Borrador 0.1 · 2026-05-06**
**Autor:** Equipo CEPI / asistente
**Estado:** plan en discusión; Fase 1 implementada (gated)

---

## 1. Problema

Hoy, post-R1 del REFACTOR_PLAN, cada `entity_definition` tiene una tabla tipada `entity_<slug>` con shape fijo:

```sql
CREATE TABLE entity_paciente (
  id UUID PRIMARY KEY,
  title VARCHAR(500),
  parent_id UUID,
  data JSONB NOT NULL DEFAULT '{}',
  created_by UUID, active BOOL, created_at, updated_at
);
```

Toda la información de dominio vive dentro de `data JSONB`. Eso conlleva:

- **Sin tipado real**. Una `cedula` que debe ser texto puede caer como número; `fecha_nac` puede ser un string mal formado. La validación queda en application code y se olvida.
- **Sin constraints estructurales**. No podemos pedir `NOT NULL`, `CHECK`, `FK` sobre campos que el dominio define como tales (`patient_id` en `entity_episode` debería ser FK a `entity_paciente.id`).
- **Stats degradadas para el planner**. `pg_stats` no acumula histogramas por campo individual dentro de JSONB; el planner navega ciegamente.
- **Índices indirectos**. Hoy son sobre `(data->>'cedula')` — funcionan, pero cada lookup paga una extracción JSONB.
- **Lectura/serialización costosas**. Cada `SELECT data` deserializa todo el blob; cada cliente que solo necesita `nombre` paga el costo del resto.
- **Renames son frágiles**. Renombrar un campo es reescribir JSONB en N filas; un crash a mitad deja datos huérfanos bajo la key vieja.

La arquitectura JSONB hizo sentido en la fase de exploración (definir tipos sin migraciones). Hoy los tipos centrales (Paciente, Episodio, Diagnóstico, Factura) están razonablemente estables — el costo se paga sin recibir el beneficio de la flexibilidad.

## 2. Objetivo

Convertir cada campo declarado en `entity_definitions.config.fields[]` en una **columna real** de `entity_<slug>`, manteniendo `data JSONB` durante una ventana de compatibilidad para no romper lectores existentes.

Al terminar la migración:

- `entity_paciente` tiene columnas reales: `nombre TEXT NOT NULL`, `apellidos TEXT NOT NULL`, `cedula TEXT`, `fecha_nac DATE`, `sexo TEXT CHECK (sexo IN (...))`, etc.
- Los índices de `indexSyncService` apuntan a columnas, no a expresiones JSONB.
- El renderer y el router siguen leyendo/escribiendo `record.data[key]` durante la transición; un trigger mantiene `data` sincronizada con las columnas.
- Al finalizar la transición, el contrato API expone columnas planas y `data` se elimina.

## 3. Mapeo de tipos

| `field.type` | Columna SQL | Notas |
|---|---|---|
| `text`, `email`, `textarea` | `TEXT` | `email` podría tener un `CHECK` regex; lo dejamos para fase 4. |
| `number` | `NUMERIC` | Permite nullable salvo `status='required'`. |
| `date` | `DATE` | |
| `select` | `TEXT` | `CHECK (col IN (...))` generado a partir de `field.options`. |
| `boolean` | `BOOLEAN` | |
| `system` | (no se materializa) | Son derivados (created_at, etc.). |
| `relationship` (single, no inverse) | `UUID REFERENCES entities(id)` | FK válida; el target es polimórfico hacia `entities`. |
| `relationship` (multiple) | (no se materializa) | Vive en `entity_relationships`. |
| `relationship` (inverse) | (no se materializa) | Derivado. |
| `attachment`, `attachments` | (no se materializa) | Viven en `attachments`. |
| `separator`, `label` | (no se materializa) | Decoraciones. |

### Naming

- Las keys con prefijo UUID (`<uuid>:patient_id`) **no** se pueden usar como nombre de columna. Estrategia: usar la parte local (`patient_id`). Si dos relationship fields apuntan al mismo target, se desambigua con `_<n>`.
- Sanitizar a `[a-z][a-z0-9_]*`. Reusar `slugify` ya existente.

### Nullability

- `status='required'` → `NOT NULL` (con default `''` o `NULL` según tipo, evaluado en migración).
- Otros → nullable.

## 4. Estrategia: migración directa

No hay ambiente productivo, así que no se hace dual-write ni feature flag por entidad. Se migra en un solo paso:

1. Crear columnas reales en cada `entity_<slug>` derivadas de su `entity_definitions.config.fields[]`.
2. Backfill desde `data JSONB` a las columnas en bloque (`UPDATE … SET col = data->>'key'` con casts).
3. Cambiar routers (`post`, `put`, `getOne`, `getList`) para leer/escribir columnas.
4. Reescribir `fn_sync_entity_shadow` para que componga `entities.data` a partir de columnas (mantener la polimórfica como única superficie con `data` para chatter/accounting/atajos cross-type por ahora).
5. `DROP COLUMN data` en cada `entity_<slug>`.
6. `indexSyncService` apunta a columnas reales.

### Implementación: `columnSyncService` (fundación)

- `scheduleColumnSync(entityDefId, fields)`: encola DDL idempotente (`ADD/DROP/ALTER COLUMN`).
- `reconcileColumnsOnStartup()`: al boot recorre todas las definiciones y reconcilia. Después corre el backfill (`UPDATE` desde `data` JSONB) y dropea `data` cuando la entidad ya está completamente alineada.
- API contract: la respuesta JSON sigue siendo `{ ..., data: { ... } }` para no tocar el frontend; `data` se reconstruye en lectura desde las columnas.

## 5. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| ALTER TABLE bloqueante con datos grandes | `ALTER TABLE ... ADD COLUMN` en PG ≥11 es instantáneo si no hay default; agregar defaults / NOT NULL por separado. |
| Trigger bidireccional entra en loop | Usar `IS DISTINCT FROM` y solo escribir si hay cambio real; cubrir con test. |
| Renames pierden datos | Detectar rename como (drop, add) si el `field.id` se mantiene; preservar `field.id` en el config como key estable. (Hoy ya existe `id` en cada field — usarlo.) |
| Cambio de tipo (text→number) con data sucia | Fase 1 intenta `ALTER COLUMN ... TYPE` con `USING`; si falla, log y skip — el flag queda en pendiente hasta que humano resuelva. |
| Relationship FK rota | `ON DELETE SET NULL` en la FK generada para no cascade-delete pacientes al borrar facturas. |
| Migración parcial deja a algunos tipos en JSONB y otros en columnas | El flag `materialize_columns` es per-entidad; la API y el renderer ya tratan a `data` como dict abstracto, así que conviven sin problema. |

## 6. Decisiones abiertas

- **Materializar `relationship` con FK real?** Beneficio: integridad. Costo: si el target apunta a `entities` (polimórfica) en vez de a `entity_<target_slug>`, la FK es a `entities(id)` — válida pero no constriñe el tipo. Decisión propuesta: **sí, FK a `entities(id)`** y validar el tipo en application code.
- **Enums vs CHECK** para `select`: `CHECK` es más simple de mutar; ENUMs son más eficientes pero requieren `ALTER TYPE`. Decisión: **CHECK constraint**, regenerable en cada `columnSync`.
- **`title`** ya es columna; no la tocamos.
- **PII**: campos con `pii: true` podrían materializarse en una tabla aparte cifrada. Fuera de scope de este plan.

## 7. Estado actual

- [x] **Fase 1 — DDL + backfill + sync trigger** (todas las entidades, no gated).
  - `backend/src/services/columnSyncService.ts`: `syncColumnsForEntity`, `scheduleColumnSync`, `reconcileColumnsOnStartup`.
  - Genera por cada `entity_<slug>` un trigger `BEFORE INSERT OR UPDATE` (`fn_sync_<tbl>_data_to_cols`) que copia `NEW.data->>'key'` a las columnas reales con cast por tipo. Bidireccional no — la dirección hoy es **`data` → columnas**, escritura sigue posteando JSONB.
  - Backfill al boot. 13 entidades, 96 columnas, 500 registros existentes alineados sin pérdida.
  - CHECK constraints generados para campos `select` con `options`.
  - Hooked a `entitiesRouter` post/put: cada cambio de `entity_definition` o `config_form` reagenda `scheduleColumnSync`.
- [x] **`indexSyncService` migrado a columnas reales** (en lugar de `(data->>'k')`). Re-habilitado en boot.
- [ ] **Fase 2 — escrituras directas a columnas**: cambiar `insertBusinessRecord` y la rama `business` de `put.ts` para que escriban columnas directamente, no `data`. El trigger se invierte (columnas → data) o se elimina si se dropea `data`.
- [ ] **Fase 3 — readers ensamblan `data` desde columnas**: `getOne`/`getList` construyen el response a partir de columnas + tablas auxiliares (`entity_relationships`, `attachments`).
- [ ] **Fase 4 — `DROP COLUMN data`** en cada `entity_<slug>`.

### Diferencia con el plan original

Quedamos en un estado intermedio estable: las columnas existen, son la fuente para queries/índices, y se mantienen sincronizadas con `data` JSONB en cada write vía trigger. La API y el frontend no cambiaron — siguen viendo `record.data[k]`. Para completar la migración hay que invertir el flujo de escritura (Fase 2-4) y eso sí toca el shape de los handlers. Está aislado: ninguna otra parte del código toca columnas directamente todavía.
