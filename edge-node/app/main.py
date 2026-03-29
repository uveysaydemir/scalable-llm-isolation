import time
import uuid
from threading import Thread
from typing import List

from fastapi import BackgroundTasks, FastAPI, HTTPException
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from app.config import MODEL_NAME, MEMORY_SEARCH_LIMIT, LTM_CACHE_TTL_SECONDS
from app.logging_utils import log_event
from app.memory.cache import LTMCache
from app.memory.mem0_service import Mem0Service
from app.memory.stm_store import STMStore
from app.prompt_builder import build_prompt
from app.schemas import GenerateRequest, GenerateResponse, MemoryAddRequest, SessionEndRequest

app = FastAPI(title="Edge Node")

tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)

if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

memory_service = Mem0Service()
ltm_cache = LTMCache(ttl_seconds=LTM_CACHE_TTL_SECONDS)
stm_store = STMStore()

# Fetch long-term memory from the current edge node's Mem0 instance.
def fetch_memories_from_mem0(user_id: str, query: str, limit: int) -> List[str]:
    raw = memory_service.search(
        user_id=user_id,
        query=query,
        limit=limit,
    )

    results = raw.get("results", []) if isinstance(raw, dict) else []
    memories = [item["memory"] for item in results if item.get("memory")]
    return memories


def retrieve_memories(user_id: str, query: str, limit: int) -> tuple[List[str], str]:
    cached_memories = ltm_cache.get(user_id)
    if cached_memories is not None:
        return cached_memories, "cache"

    memories = fetch_memories_from_mem0(
        user_id=user_id,
        query=query,
        limit=limit,
    )
    ltm_cache.set(user_id, memories)
    return memories, "mem0"


# For persisting user input to the edge-local mem0 instance
def persist_memory_background(user_id: str, user_prompt: str, assistant_output: str) -> None:
    try:
        memory_service.add_messages(
            user_id=user_id,
            messages=[
                {"role": "user", "content": user_prompt},
                {"role": "assistant", "content": assistant_output},
            ],
        )

        log_event(
            "memory_persist_completed",
            {
                "userId": user_id,
                "storedMessages": 2,
                "cacheInvalidated": True,
            },
        )
    except Exception as e:
        log_event(
            "memory_persist_failed",
            {
                "userId": user_id,
                "error": str(e),
            },
        )


# Endpoints
@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "edge-node",
        "modelName": MODEL_NAME,
        "ltmCache": ltm_cache.stats(),
        "stm": stm_store.stats(),
    }


@app.post("/memory/search")
def debug_search_memory(payload: dict):
    try:
        user_id = payload["userId"]
        query = payload["query"]
        limit = payload.get("limit", 5)

        raw = memory_service.search(
            user_id=user_id,
            query=query,
            limit=limit,
        )

        results = raw.get("results", []) if isinstance(raw, dict) else []

        return {
            "ok": True,
            "userId": user_id,
            "query": query,
            "count": len(results),
            "results": results,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/memory/add")
def debug_add_memory(req: MemoryAddRequest):
    try:
        memory_service.add_messages(
            user_id=req.userId,
            messages=[
                {"role": "user", "content": req.userMessage},
                {"role": "assistant", "content": req.assistantMessage},
            ],
        )

        # Keep cache coherent with newly written memory.
        ltm_cache.invalidate(req.userId)

        return {
            "ok": True,
            "userId": req.userId,
            "message": "Memory stored successfully",
            "cacheInvalidated": True,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/memory/cache/invalidate")
def debug_invalidate_cache(payload: dict):
    try:
        user_id = payload["userId"]
        ltm_cache.invalidate(user_id)

        return {
            "ok": True,
            "userId": user_id,
            "message": "Cache invalidated",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest, background_tasks: BackgroundTasks):
    request_id = str(uuid.uuid4())
    session_id = req.sessionId or str(uuid.uuid4())
    started = time.perf_counter()

    try:
        try:
            stm_store.get_or_create(session_id=session_id, user_id=req.userId)
        except ValueError as e:
            raise HTTPException(status_code=403, detail=str(e))

        stm_history = stm_store.get_history(session_id)

        memories, memory_source = retrieve_memories(
            user_id=req.userId,
            query=req.prompt,
            limit=MEMORY_SEARCH_LIMIT,
        )

        final_prompt = build_prompt(
            user_prompt=req.prompt,
            memories=memories,
            history=stm_history,
        )

        inputs = tokenizer(final_prompt, return_tensors="pt")
        streamer = TextIteratorStreamer(
            tokenizer,
            skip_prompt=True,
            skip_special_tokens=True,
        )

        generation_kwargs = {
            **inputs,
            "streamer": streamer,
            "max_new_tokens": req.maxNewTokens or 64,
            "do_sample": True,
            "temperature": 0.7,
            "pad_token_id": tokenizer.eos_token_id,
        }

        # Creating a thread and will listen the streamer in the main thread to get the ttft.
        thread = Thread(target=model.generate, kwargs=generation_kwargs)
        thread.start()

        first_token_time = None
        chunks = []

        for chunk in streamer:
            if first_token_time is None:
                first_token_time = time.perf_counter()
            chunks.append(chunk)

        thread.join()

        finished = time.perf_counter()
        output = "".join(chunks).strip()

        ttft_ms = None
        if first_token_time is not None:
            ttft_ms = round((first_token_time - started) * 1000, 2)

        total_ms = round((finished - started) * 1000, 2)

        stm_store.append(session_id, "user", req.prompt)
        stm_store.append(session_id, "assistant", output)

        background_tasks.add_task(
            persist_memory_background,
            req.userId,
            req.prompt,
            output,
        )

        log_event(
            "generate_completed",
            {
                "requestId": request_id,
                "userId": req.userId,
                "sessionId": session_id,
                "model": MODEL_NAME,
                "promptChars": len(req.prompt),
                "memoryCount": len(memories),
                "memorySource": memory_source,
                "stmTurns": len(stm_history),
                "ttftMs": ttft_ms,
                "totalMs": total_ms,
                "status": "success",
            },
        )

        return GenerateResponse(
            ok=True,
            userId=req.userId,
            sessionId=session_id,
            output=output,
            metrics={
                "ttftMs": ttft_ms,
                "totalMs": total_ms,
                "modelName": MODEL_NAME,
                "memoryCount": len(memories),
                "memorySource": memory_source,
                "stmTurns": len(stm_history),
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        log_event(
            "generate_failed",
            {
                "requestId": request_id,
                "userId": req.userId,
                "model": MODEL_NAME,
                "status": "error",
                "error": str(e),
            },
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/session/end")
def end_session(req: SessionEndRequest):
    session = stm_store.export_session(req.sessionId)
    if session is not None and session["userId"] != req.userId:
        raise HTTPException(status_code=403, detail="Session belongs to a different user")

    cleared = stm_store.end_session(req.sessionId)
    return {
        "ok": True,
        "sessionId": req.sessionId,
        "cleared": cleared,
    }