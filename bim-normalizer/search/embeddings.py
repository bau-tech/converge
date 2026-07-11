"""
Local, CPU-only semantic search for BIM elements — no external API, no pgvector.

Elements are embedded once at ingest time (see pipeline/normalize.py) into
bim_element_embeddings; searches embed the query with the same model and rank
stored vectors by cosine similarity in Python/numpy. Fine at current model
sizes (hundreds-to-low-thousands of elements per model); would need a real ANN
index (pgvector, faiss, ...) well before that if models grow much larger.
"""
import logging
import threading

import numpy as np

logger = logging.getLogger(__name__)

_MODEL_NAME = "BAAI/bge-small-en-v1.5"

# Lazy singleton: fastembed's TextEmbedding loads an ONNX model from disk (or
# downloads it on first use) — expensive enough that it must happen once per
# process, not on every call, but importing this module must stay cheap so it
# doesn't slow down bim-normalizer's startup for requests that never touch
# semantic search at all.
_model = None
_model_lock = threading.Lock()


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from fastembed import TextEmbedding
                logger.info("Loading semantic search embedding model %s ...", _MODEL_NAME)
                _model = TextEmbedding(model_name=_MODEL_NAME)
                logger.info("Embedding model %s ready", _MODEL_NAME)
    return _model


# Parameters that add noise rather than signal to a semantic description —
# mirrors the spirit of ifc/classify.py's own noise-filtering, but for text
# embedding rather than classification.
_SKIP_PARAM_KEYS = {"guid", "globalid", "ifcguid", "tag"}
_MAX_PARAMS_IN_TEXT = 20


def build_embed_text(element: dict, params: list[dict]) -> str:
    """
    Compose a short natural-language description of an element for embedding.
    `element` needs ifc_class/category/name/storey; `params` is a list of
    {pset, key, value} dicts (as returned by bim_parameters rows).
    """
    parts = []
    if element.get("ifc_class"):
        parts.append(element["ifc_class"])
    if element.get("category"):
        parts.append(f"category {element['category']}")
    if element.get("name"):
        parts.append(element["name"])
    if element.get("storey"):
        parts.append(f"on {element['storey']}")

    seen_keys = set()
    for p in params:
        key = (p.get("key") or "").strip()
        value = (p.get("value") or "").strip()
        if not key or not value:
            continue
        if key.lower() in _SKIP_PARAM_KEYS or key.lower() in seen_keys:
            continue
        seen_keys.add(key.lower())
        parts.append(f"{key}: {value}")
        if len(seen_keys) >= _MAX_PARAMS_IN_TEXT:
            break

    return ", ".join(parts) if parts else "unnamed element"


def embed_many(texts: list[str]) -> list[list[float]]:
    """Embed a batch of element descriptions for indexing/storage."""
    if not texts:
        return []
    model = _get_model()
    return [vec.tolist() for vec in model.embed(texts)]


def embed_query(text: str) -> list[float]:
    """
    Embed a search query. Prefers query_embed() over embed() — bge-* models
    are trained asymmetrically (a different instruction prefix for queries vs.
    the documents they're matched against), so this meaningfully improves
    match quality over embedding the query the same way as an element. Falls
    back to embed() for fastembed versions/models without query_embed.
    """
    model = _get_model()
    embed_fn = getattr(model, "query_embed", None) or model.embed
    return next(iter(embed_fn([text]))).tolist()


def cosine_top_k(
    query_vec: list[float], rows: list[tuple[str, list[float]]], k: int
) -> list[tuple[str, float]]:
    """
    rows: [(element_id, embedding), ...]. Returns the k highest-scoring
    (element_id, cosine_similarity) pairs, sorted descending.
    """
    if not rows:
        return []
    q = np.asarray(query_vec, dtype=np.float32)
    q_norm = np.linalg.norm(q)
    if q_norm == 0:
        return []

    ids = [r[0] for r in rows]
    mat = np.asarray([r[1] for r in rows], dtype=np.float32)
    mat_norms = np.linalg.norm(mat, axis=1)
    mat_norms[mat_norms == 0] = 1e-9  # avoid div-by-zero for any degenerate stored vector

    scores = (mat @ q) / (mat_norms * q_norm)
    top_idx = np.argsort(-scores)[:k]
    return [(ids[i], float(scores[i])) for i in top_idx]
