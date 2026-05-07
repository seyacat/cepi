# cepi-isic

Servicio Python (FastAPI) que provee embeddings y clasificaciones de imagen
para el pipeline médico de cepi (PAPER §10.3 / §10.4 / Fase 6).

Por ahora corre en **modo stub**: vectores aleatorios deterministas por
`attachment_id` y distribuciones plausibles para HAM10000 + triage binario.
Reemplaza `embed_image()` y `classify_image()` en `app.py` por un modelo real
(ResNet/EfficientNet sobre HAM10000) sin tocar el contrato HTTP.

## Endpoints

```
GET  /health
POST /embed                  { attachment_id, model_id, dim? }
POST /classify/triage        { attachment_id, model_id }
POST /classify/multiclass    { attachment_id, model_id }
```

## Setup (WSL Ubuntu)

```bash
# Una sola vez (necesita sudo):
sudo apt install -y python3-venv python3-pip

# Local del proyecto:
cd /mnt/d/cepi/cepi-isic
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Levantar manual:
.venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000

# O dejarlo bajo PM2 (ver ecosystem.config.cjs / app cepi-isic).
```

## Cómo lo consume el resto del stack

`TodoERP/backend/src/services/clinicalImageProcessor.ts` (opt-in vía
`CEPI_MEDICAL=1`) hace polling cada 15s sobre `entity_clinical_image`
buscando filas con `data.embedding_status='pending'`. Por cada fila:

1. Llama a este servicio con `attachment_id`.
2. Persiste embedding en `vector_embeddings` por modelo activo.
3. Persiste clasificaciones en `entity_classifications` por modelo activo.
4. Marca la fila como `embedding_status='done'`.

`models_registry.config.endpoint` puede sobrescribir la URL por modelo;
si ausente, el worker usa `CEPI_ISIC_URL` (default `http://localhost:8000`)
+ `/embed`, `/classify/triage`, `/classify/multiclass`.

## Modo stub vs real

El stub es deterministico: `hash(attachment_id + model_id)` define la semilla
RNG, así que re-procesar la misma imagen produce el mismo vector y los
mismos labels. Es lo que querés en dev: el agente puede mostrar "casos
similares" y "Sugerencia IA" sin levantar GPU.

Cuando quieras un modelo real:

```python
import torch
from torchvision import models, transforms
# carga pesos, etc., reemplaza embed_image / classify_image
```

El contrato HTTP queda igual; el worker no se entera.
