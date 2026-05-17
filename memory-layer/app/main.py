import logging

from fastapi import FastAPI, HTTPException

from app.embedding_service import EmbeddingService

logger = logging.getLogger("memory-layer")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Memory Layer")

memory_service = EmbeddingService()


@app.get("/health")
def health():
    return {"ok": True, "service": "memory-layer"}


@app.post("/memory/search")
def search_memory(payload: dict):
    user_id = payload.get("userId")
    query = payload.get("query")
    limit = payload.get("limit", 5)

    if not user_id or not query:
        raise HTTPException(status_code=400, detail="userId and query are required")

    raw = memory_service.search(user_id=user_id, query=query, limit=limit)
    results = raw.get("results", [])

    return {
        "ok": True,
        "userId": user_id,
        "query": query,
        "count": len(results),
        "results": results,
    }


@app.get("/memory/all")
def get_all_memories(userId: str):
    if not userId:
        raise HTTPException(status_code=400, detail="userId is required")

    raw = memory_service.get_all(user_id=userId)
    results = raw.get("results", [])

    return {
        "ok": True,
        "userId": userId,
        "count": len(results),
        "results": results,
    }


@app.post("/memory/add")
def add_memory(payload: dict):
    user_id = payload.get("userId")
    messages = payload.get("messages", [])

    if not user_id or not messages:
        raise HTTPException(status_code=400, detail="userId and messages are required")

    try:
        result = memory_service.add_messages(user_id=user_id, messages=messages)
        stored = len(result.get("results", []))
        logger.info(
            "embedding add completed userId=%s messages=%d stored=%d",
            user_id,
            len(messages),
            stored,
        )
        return {
            "ok": True,
            "userId": user_id,
            "storedMessages": len(messages),
            "extractedFacts": stored,
        }
    except Exception as e:
        logger.error("embedding add failed userId=%s error=%s", user_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"embedding add failed: {e}")


@app.post("/memory/replace")
def replace_memory(payload: dict):
    user_id = payload.get("userId")
    facts = payload.get("facts", [])

    if not user_id:
        raise HTTPException(status_code=400, detail="userId is required")

    try:
        result = memory_service.replace_all(user_id=user_id, facts=facts)
        stored = len(result.get("results", []))
        logger.info(
            "memory replace completed userId=%s facts_in=%d stored=%d",
            user_id,
            len(facts),
            stored,
        )
        return {
            "ok": True,
            "userId": user_id,
            "replacedWith": stored,
        }
    except Exception as e:
        logger.error("memory replace failed userId=%s error=%s", user_id, e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"memory replace failed: {e}")
