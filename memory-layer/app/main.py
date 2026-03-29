from fastapi import FastAPI, HTTPException

from app.mem0_service import Mem0Service

app = FastAPI(title="Memory Layer")

memory_service = Mem0Service()


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
    results = raw.get("results", []) if isinstance(raw, dict) else []

    return {
        "ok": True,
        "userId": user_id,
        "query": query,
        "count": len(results),
        "results": results,
    }


@app.post("/memory/add")
def add_memory(payload: dict):
    user_id = payload.get("userId")
    messages = payload.get("messages", [])

    if not user_id or not messages:
        raise HTTPException(status_code=400, detail="userId and messages are required")

    memory_service.add_messages(user_id=user_id, messages=messages)

    return {
        "ok": True,
        "userId": user_id,
        "storedMessages": len(messages),
    }
