"""
cepi-isic — FastAPI service for image embeddings and classifications.

PAPER §10.3 / §10.4 Fase 6. This first cut runs in **stub mode**:
deterministic random embeddings (per attachment_id seed) and
plausibly-distributed multiclass + binary triage scores. No real
GPU/model dependency, so the rest of the medical stack can integrate
end-to-end without waiting on weights.

Swap the stub for a real ResNet/EfficientNet by replacing
`embed_image()` and `classify_image()` — the HTTP contract stays the same.

Endpoints:
  GET  /health
  POST /embed             { attachment_id, model_id }
                          → { embedding: number[], dim }
  POST /classify/triage   { attachment_id, model_id }
                          → { labels: [{label, confidence}], raw }
  POST /classify/multiclass { attachment_id, model_id }
                          → { labels: [{label, confidence} x7], raw }
"""
import hashlib
import os
import random
from typing import List

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

PORT = int(os.environ.get("CEPI_ISIC_PORT", "8000"))

# Default dims must match models_registry seeds in TodoERP.
DEFAULT_EMBED_DIM = 2048   # isic-resnet50-v1

HAM10000_LABELS = ["akiec", "bcc", "bkl", "df", "mel", "nv", "vasc"]

app = FastAPI(title="cepi-isic", version="0.1.0")


def _seeded_rng(seed: str) -> random.Random:
    """Deterministic RNG keyed off attachment_id so re-classifying the same
    image yields the same numbers."""
    h = int(hashlib.sha256(seed.encode("utf-8")).hexdigest(), 16) & 0xFFFFFFFF
    return random.Random(h)


class EmbedReq(BaseModel):
    attachment_id: str
    model_id: str = "isic-resnet50-v1"
    dim: int | None = None


class ClassifyReq(BaseModel):
    attachment_id: str
    model_id: str


@app.get("/health")
def health():
    return {"ok": True, "service": "cepi-isic", "mode": "stub"}


@app.post("/embed")
def embed(req: EmbedReq):
    rng = _seeded_rng(f"emb:{req.model_id}:{req.attachment_id}")
    dim = req.dim or DEFAULT_EMBED_DIM
    # Random unit-ish vector with a stable seed.
    vec = np.array([rng.gauss(0, 1) for _ in range(dim)], dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec = vec / norm
    return {"embedding": vec.tolist(), "dim": dim, "stub": True}


@app.post("/classify/triage")
def classify_triage(req: ClassifyReq):
    """Binary triage (melanoma sospechoso / no melanoma). ~12% positive rate
    so the agent's escalation logic actually fires sometimes in dev."""
    rng = _seeded_rng(f"triage:{req.model_id}:{req.attachment_id}")
    melanoma = rng.random() < 0.12
    p_mel = rng.uniform(0.65, 0.97) if melanoma else rng.uniform(0.02, 0.35)
    labels = [
        {"label": "melanoma",    "confidence": round(p_mel,        3)},
        {"label": "no_melanoma", "confidence": round(1 - p_mel,    3)},
    ]
    labels.sort(key=lambda x: -x["confidence"])
    return {"labels": labels, "raw": {"source": "stub", "p_melanoma": p_mel}}


@app.post("/classify/multiclass")
def classify_multiclass(req: ClassifyReq):
    """HAM10000 7-class multiclass; returns full distribution sorted by
    confidence so the bot can pick the top-3."""
    rng = _seeded_rng(f"multi:{req.model_id}:{req.attachment_id}")
    raw = [(lbl, rng.expovariate(1.0)) for lbl in HAM10000_LABELS]
    s = sum(v for _, v in raw)
    dist = [(lbl, v / s) for lbl, v in raw]
    dist.sort(key=lambda x: -x[1])
    labels = [{"label": lbl, "confidence": round(p, 3)} for lbl, p in dist]
    return {"labels": labels, "raw": {"source": "stub"}}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
