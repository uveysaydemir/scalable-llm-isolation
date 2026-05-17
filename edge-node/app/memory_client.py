from typing import List
import httpx

from app.config import MEMORY_LAYER_URL


class MemoryClient:
    async def search(self, *, user_id: str, query: str, limit: int = 5) -> List[str]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{MEMORY_LAYER_URL}/memory/search",
                json={
                    "userId": user_id,
                    "query": query,
                    "limit": limit,
                },
            )
            res.raise_for_status()
            payload = res.json()

        results = payload.get("results", [])
        memories: List[str] = []

        for item in results:
            memory_text = item.get("memory")
            if memory_text:
                memories.append(memory_text)

        return memories

    async def get_all(self, *, user_id: str) -> List[str]:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(
                f"{MEMORY_LAYER_URL}/memory/all",
                params={"userId": user_id},
            )
            res.raise_for_status()
            payload = res.json()

        results = payload.get("results", [])
        return [item["memory"] for item in results if item.get("memory")]

    async def add_messages(self, *, user_id: str, messages: list[dict]) -> int:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(
                f"{MEMORY_LAYER_URL}/memory/add",
                json={"userId": user_id, "messages": messages},
            )
            res.raise_for_status()
            return res.json().get("extractedFacts", 0)

    async def replace_messages(self, *, user_id: str, facts: list[str]) -> int:
        """Delete all existing LTM for user and replace with the merged fact list.
        Returns the number of facts stored."""
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(
                f"{MEMORY_LAYER_URL}/memory/replace",
                json={"userId": user_id, "facts": facts},
            )
            res.raise_for_status()
            return res.json().get("replacedWith", 0)