import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from threading import Thread
from typing import List

from fastapi import BackgroundTasks, FastAPI, HTTPException
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from app.config import LTM_CACHE_TTL_SECONDS, MEMORY_SEARCH_LIMIT, MODEL_NAME, STM_TTL_SECONDS
from app.logging_utils import log_event
from app.memory.cache import LTMCache
from app.memory.stm_store import STMStore
from app.memory_client import MemoryClient
from app.prompt_builder import build_prompt
from app.schemas import GenerateRequest, GenerateResponse, MemoryAddRequest, SessionEndRequest

memory_client = MemoryClient()
ltm_cache = LTMCache(ttl_seconds=LTM_CACHE_TTL_SECONDS)
stm_store = STMStore(session_ttl_seconds=STM_TTL_SECONDS)


async def _flush_expired_stm_loop() -> None:
    """Background loop: flush expired STM sessions to the global memory-layer."""
    while True:
        await asyncio.sleep(60)
        try:
            expired = stm_store.pop_expired_sessions()
            for session_data in expired:
                user_id: str = session_data["userId"]
                messages: list = session_data["messages"]
                if not messages:
                    continue
                try:
                    await memory_client.add_messages(
                        user_id=user_id,
                        messages=[
                            {"role": m["role"], "content": m["content"]}
                            for m in messages
                        ],
                    )
                    log_event(
                        "stm_flushed_to_memory",
                        {"userId": user_id, "messageCount": len(messages)},
                    )
                except Exception as e:
                    log_event(
                        "stm_flush_failed",
                        {"userId": user_id, "error": str(e)},
                    )
        except Exception as e:
            log_event("stm_flush_loop_error", {"error": str(e)})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_flush_expired_stm_loop())
    yield
    task.cancel()


app = FastAPI(title="Edge Node", lifespan=lifespan)

tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)

if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token


async def retrieve_memories(user_id: str, query: str, limit: int) -> tuple[List[str], str]:
    cached = ltm_cache.get(user_id)
    if cached is not None:
        return cached, "cache"

    memories = await memory_client.search(user_id=user_id, query=query, limit=limit)
    ltm_cache.set(user_id, memories)
    return memories, "memory-layer"


async def persist_memory_background(
    user_id: str, user_prompt: str, assistant_output: str
) -> None:
    try:
        await memory_client.add_messages(
            user_id=user_id,
            messages=[
                {"role": "user", "content": user_prompt},
                {"role": "assistant", "content": assistant_output},
            ],
        )
        log_event(
            "memory_persist_completed",
            {"userId": user_id, "storedMessages": 2},
        )
    except Exception as e:
        log_event("memory_persist_failed", {"userId": user_id, "error": str(e)})


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
async def debug_search_memory(payload: dict):
    try:
        user_id = payload["userId"]
        query = payload["query"]
        limit = payload.get("limit", 5)

        memories = await memory_client.search(user_id=user_id, query=query, limit=limit)

        return {
            "ok": True,
            "userId": user_id,
            "query": query,
            "count": len(memories),
            "results": memories,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/memory/add")
async def debug_add_memory(req: MemoryAddRequest):
    try:
        await memory_client.add_messages(
            user_id=req.userId,
            messages=[
                {"role": "user", "content": req.userMessage},
                {"role": "assistant", "content": req.assistantMessage},
            ],
        )
        return {
            "ok": True,
            "userId": req.userId,
            "message": "Memory stored successfully",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/memory/cache/invalidate")
def debug_invalidate_cache(payload: dict):
    try:
        user_id = payload["userId"]
        ltm_cache.invalidate(user_id)
        return {"ok": True, "userId": user_id, "message": "Cache invalidated"}
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

        memories, memory_source = await retrieve_memories(
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
