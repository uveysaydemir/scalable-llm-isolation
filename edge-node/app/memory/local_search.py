"""
Local semantic search over a user's cached LTM entries.

Embeddings are fetched from Ollama (nomic-embed-text, 768-dim),
L2-normalised so dot-product == cosine similarity.
"""

from __future__ import annotations

import logging
from typing import List

import httpx
import numpy as np

from app.config import OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL

logger = logging.getLogger(__name__)

_EMBEDDING_DIM = 768  # nomic-embed-text output dimension


async def embed(texts: List[str]) -> np.ndarray:
    """Return an (n, 768) float32 array of L2-normalised embeddings."""
    if not texts:
        return np.empty((0, _EMBEDDING_DIM), dtype=np.float32)

    vectors: list[list[float]] = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for text in texts:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/embeddings",
                json={"model": OLLAMA_EMBED_MODEL, "prompt": text},
            )
            resp.raise_for_status()
            vectors.append(resp.json()["embedding"])

    arr = np.array(vectors, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    return arr / norms


async def search_relevant(
    query: str,
    memories: List[str],
    embeddings: np.ndarray,
    top_k: int,
) -> List[str]:
    """Return the top_k memories most semantically similar to query."""
    if not memories or embeddings.shape[0] == 0:
        return []

    query_vec = (await embed([query]))[0]   # (768,)
    scores = embeddings @ query_vec          # (n,)
    k = min(top_k, len(memories))
    top_indices = np.argsort(scores)[::-1][:k]
    return [memories[i] for i in top_indices]
