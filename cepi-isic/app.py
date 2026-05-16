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
  POST /inspect           { attachment_id, file_url, auth? }
                          → { width, height, brightness, adequate,
                              reasons[], has_face }   (real, not stub)
"""
import hashlib
import io
import os
import random
from typing import List, Optional

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel

import cv2
from PIL import Image
import urllib.request

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


# ── Image inspection (real, not stub) ──────────────────────────────────────
# Quality (resolution + lighting) + face detection on a clinical image.
# The caller (cepi-bot) passes a fully-qualified, authenticated file URL so
# this service stays decoupled from TodoERP's DB and auth.

# Quality thresholds (PAPER §10 — lesion image acceptance).
MIN_SIDE_PX = 480          # shorter side must be at least this many pixels
BRIGHTNESS_MIN = 40.0      # mean luma below this → underexposed
BRIGHTNESS_MAX = 220.0     # mean luma above this → overexposed

_FACE_CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)


class InspectReq(BaseModel):
    attachment_id: str
    # Fully-qualified URL to fetch the image binary (e.g. TodoERP
    # /api/attachments/<id>/file). Optional only for tests that pass bytes.
    file_url: Optional[str] = None
    # Bearer token forwarded to the file URL, if it needs auth.
    auth: Optional[str] = None
    # API-key fallback (machine-to-machine) for the file URL.
    api_key: Optional[str] = None


def _fetch_image_bytes(req: InspectReq) -> bytes:
    if not req.file_url:
        raise ValueError("file_url is required")
    headers = {}
    if req.auth:
        headers["Authorization"] = req.auth
    if req.api_key:
        headers["x-api-key"] = req.api_key
    http_req = urllib.request.Request(req.file_url, headers=headers)
    with urllib.request.urlopen(http_req, timeout=20) as resp:
        return resp.read()


def inspect_bytes(data: bytes) -> dict:
    """Real image stats: dimensions, mean brightness, face presence."""
    pil = Image.open(io.BytesIO(data)).convert("RGB")
    width, height = pil.size

    gray = pil.convert("L")
    brightness = float(np.asarray(gray, dtype=np.float32).mean())

    reasons: List[str] = []
    short_side = min(width, height)
    if short_side < MIN_SIDE_PX:
        reasons.append(
            f"resolución insuficiente ({width}x{height}px, mínimo "
            f"{MIN_SIDE_PX}px en el lado menor)"
        )
    if brightness < BRIGHTNESS_MIN:
        reasons.append(f"imagen subexpuesta (brillo medio {brightness:.0f}/255)")
    elif brightness > BRIGHTNESS_MAX:
        reasons.append(f"imagen sobreexpuesta (brillo medio {brightness:.0f}/255)")

    # Face detection via OpenCV haar cascade.
    cv_img = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    cv_gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    faces = _FACE_CASCADE.detectMultiScale(
        cv_gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60)
    )
    has_face = len(faces) > 0

    return {
        "width": width,
        "height": height,
        "brightness": round(brightness, 1),
        "adequate": len(reasons) == 0,
        "reasons": reasons,
        "has_face": has_face,
        "face_count": int(len(faces)),
    }


@app.post("/inspect")
def inspect(req: InspectReq):
    """Real quality + face inspection of a lesion image. Returns
    {width, height, brightness, adequate, reasons[], has_face}."""
    try:
        data = _fetch_image_bytes(req)
    except Exception as exc:  # noqa: BLE001
        return {
            "attachment_id": req.attachment_id,
            "error": f"no pude leer la imagen: {exc}",
            "adequate": False,
            "reasons": ["no se pudo descargar/abrir la imagen"],
            "has_face": False,
        }
    try:
        result = inspect_bytes(data)
    except Exception as exc:  # noqa: BLE001
        return {
            "attachment_id": req.attachment_id,
            "error": f"no pude procesar la imagen: {exc}",
            "adequate": False,
            "reasons": ["el archivo no es una imagen válida"],
            "has_face": False,
        }
    result["attachment_id"] = req.attachment_id
    return result


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
