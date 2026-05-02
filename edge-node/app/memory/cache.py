import time
from dataclasses import dataclass
from typing import Dict, List, Optional


@dataclass
class LTMCacheEntry:
    memories: List[str]
    cached_at: float
    expires_at: float


class LTMCache:
    def __init__(self, ttl_seconds: int = 300) -> None:
        self.ttl_seconds = ttl_seconds
        self._store: Dict[str, LTMCacheEntry] = {}

    def get(self, user_id: str) -> Optional[List[str]]:
        entry = self._store.get(user_id)
        if entry is None:
            return None

        now = time.time()
        if now >= entry.expires_at:
            self._store.pop(user_id, None)
            return None

        return entry.memories

    def set(self, user_id: str, memories: List[str]) -> None:
        now = time.time()
        self._store[user_id] = LTMCacheEntry(
            memories=memories,
            cached_at=now,
            expires_at=now + self.ttl_seconds,
        )

    def touch(self, user_id: str) -> bool:
        entry = self._store.get(user_id)
        if entry is None:
            return False

        now = time.time()
        if now >= entry.expires_at:
            self._store.pop(user_id, None)
            return False

        entry.expires_at = now + self.ttl_seconds
        return True

    def invalidate(self, user_id: str) -> None:
        self._store.pop(user_id, None)

    def clear(self) -> None:
        self._store.clear()

    def stats(self) -> dict:
        return {
            "ttlSeconds": self.ttl_seconds,
            "entryCount": len(self._store),
        }
