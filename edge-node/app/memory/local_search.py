"""
Local semantic search over a user's cached LTM entries.

Loads all-MiniLM-L6-v2 once (lazily) and keeps it in process memory.
Embeddings are L2-normalised so dot-product == cosine similarity.
"""

from __future__ import annotations

import logging
from typing import List

import numpy as np
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

_MODEL_NAME = "all-MiniLM-L6-v2"
_EMBEDDING_DIM = 384
_model: SentenceTransformer | None = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        logger.info("Loading sentence-transformer model %s", _MODEL_NAME)
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def embed(texts: List[str]) -> np.ndarray:
    """Return an (n, 384) float32 array of L2-normalised embeddings.

    Returns an empty (0, 384) array for empty input so callers can always
    do matrix operations without branching.
    """
    if not texts:
        return np.empty((0, _EMBEDDING_DIM), dtype=np.float32)
    return _get_model().encode(
        texts,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )


def search_relevant(
    query: str,
    memories: List[str],
    embeddings: np.ndarray,
    top_k: int,
) -> List[str]:
    """Return the top_k memories most semantically similar to query."""
    if not memories or embeddings.shape[0] == 0:
        return []

    query_vec = embed([query])[0]           # (384,)
    scores = embeddings @ query_vec         # (n,)
    k = min(top_k, len(memories))
    top_indices = np.argsort(scores)[::-1][:k]
    return [memories[i] for i in top_indices]
