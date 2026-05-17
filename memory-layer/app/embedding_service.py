import time
import uuid
from typing import Any, Dict, List

import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from app.config import (
    OLLAMA_BASE_URL,
    OLLAMA_EMBED_MODEL,
    QDRANT_COLLECTION,
    QDRANT_HOST,
    QDRANT_PORT,
)

VECTOR_DIM = 768  # nomic-embed-text output dimension


class EmbeddingService:
    def __init__(self) -> None:
        self.client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        existing = {c.name for c in self.client.get_collections().collections}
        if QDRANT_COLLECTION not in existing:
            self.client.create_collection(
                collection_name=QDRANT_COLLECTION,
                vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
            )

    def _embed(self, text: str) -> List[float]:
        resp = httpx.post(
            f"{OLLAMA_BASE_URL}/api/embeddings",
            json={"model": OLLAMA_EMBED_MODEL, "prompt": text},
            timeout=30.0,
        )
        resp.raise_for_status()
        return resp.json()["embedding"]

    def _user_filter(self, user_id: str) -> Filter:
        return Filter(
            must=[FieldCondition(key="userId", match=MatchValue(value=user_id))]
        )

    def add_messages(
        self, *, user_id: str, messages: List[Dict[str, str]]
    ) -> Dict[str, Any]:
        stored = []
        for msg in messages:
            if msg.get("role") != "user":
                continue
            content = (msg.get("content") or "").strip()
            if len(content) < 5:
                continue
            vector = self._embed(content)
            point_id = str(uuid.uuid4())
            self.client.upsert(
                collection_name=QDRANT_COLLECTION,
                points=[
                    PointStruct(
                        id=point_id,
                        vector=vector,
                        payload={
                            "memory": content,
                            "userId": user_id,
                            "updated_at": time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                            ),
                        },
                    )
                ],
            )
            stored.append({"id": point_id})
        return {"results": stored}

    def search(
        self, *, user_id: str, query: str, limit: int = 5
    ) -> Dict[str, Any]:
        vector = self._embed(query)
        hits = self.client.search(
            collection_name=QDRANT_COLLECTION,
            query_vector=vector,
            query_filter=self._user_filter(user_id),
            limit=limit,
        )
        return {
            "results": [
                {
                    "memory": h.payload.get("memory", ""),
                    "id": str(h.id),
                    "score": h.score,
                    "updated_at": h.payload.get("updated_at"),
                }
                for h in hits
            ]
        }

    def get_all(self, *, user_id: str) -> Dict[str, Any]:
        records, _ = self.client.scroll(
            collection_name=QDRANT_COLLECTION,
            scroll_filter=self._user_filter(user_id),
            limit=200,
            with_payload=True,
        )
        return {
            "results": [
                {
                    "memory": r.payload.get("memory", ""),
                    "id": str(r.id),
                    "updated_at": r.payload.get("updated_at"),
                }
                for r in records
            ]
        }
