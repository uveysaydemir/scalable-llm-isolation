import time
from typing import Any, Dict, List, Optional

from mem0 import Memory

from app.config import (
    OLLAMA_BASE_URL,
    OLLAMA_EMBED_MODEL,
    OLLAMA_LLM_MODEL,
    QDRANT_COLLECTION,
    QDRANT_HOST,
    QDRANT_PORT,
)


class Mem0Service:
    def __init__(self) -> None:
        self.config: Dict[str, Any] = {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": QDRANT_COLLECTION,
                    "host": QDRANT_HOST,
                    "port": QDRANT_PORT,
                    "embedding_model_dims": 768,
                },
            },
            "llm": {
                "provider": "ollama",
                "config": {
                    "model": OLLAMA_LLM_MODEL,
                    "temperature": 0,
                    "max_tokens": 2000,
                    "ollama_base_url": OLLAMA_BASE_URL,
                },
            },
            "embedder": {
                "provider": "ollama",
                "config": {
                    "model": OLLAMA_EMBED_MODEL,
                    "ollama_base_url": OLLAMA_BASE_URL,
                },
            },
        }
        self.memory = self._init_with_retry()


    # A function to retry mem0 instace initialization in case of any service memor depends on ,like ollama, is not available yet
    def _init_with_retry(self) -> Memory:
        last_error = None
        for _ in range(20):
            try:
                return Memory.from_config(self.config)
            except Exception as e:
                last_error = e
                time.sleep(3)
        raise last_error

    def search(
        self,
        *,
        user_id: str,
        query: str,
        limit: int = 5,
        filters: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return self.memory.search(
            query=query,
            user_id=user_id,
            filters=filters or {},
            limit=limit,
        )

    def add_messages(
        self,
        *,
        user_id: str,
        messages: List[Dict[str, str]],
    ) -> Dict[str, Any]:
        return self.memory.add(messages, user_id=user_id)