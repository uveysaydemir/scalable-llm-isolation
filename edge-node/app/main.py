import time
import uuid
from threading import Thread
from typing import List

from fastapi import BackgroundTasks, FastAPI, HTTPException
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from app.config import MODEL_NAME, MEMORY_SEARCH_LIMIT
from app.logging_utils import log_event
from app.memory.mem0_service import Mem0Service
from app.prompt_builder import build_prompt
from app.schemas import GenerateRequest, GenerateResponse, MemoryAddRequest

app = FastAPI(title="Edge Node")

tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)

if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

memory_service = Mem0Service()


def retrieve_memories(user_id: str, query: str, limit: int) -> List[str]:
    raw = memory_service.search(
        user_id=user_id,
        query=query,
        limit=limit,
    )

    results = raw.get("results", []) if isinstance(raw, dict) else []
    memories = [item["memory"] for item in results if item.get("memory")]
    return memories


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

#Endpoints
@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "edge-node",
        "modelName": MODEL_NAME,
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

        return {
            "ok": True,
            "userId": req.userId,
            "message": "Memory stored successfully",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest, background_tasks: BackgroundTasks):
    request_id = str(uuid.uuid4())
    started = time.perf_counter()

    try:
        memories = retrieve_memories(
            user_id=req.userId,
            query=req.prompt,
            limit=MEMORY_SEARCH_LIMIT,
        )

        final_prompt = build_prompt(
            user_prompt=req.prompt,
            memories=memories,
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
        
        #Creating a thread and will listen the streamer in the main thread to get the ttft.
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
                "model": MODEL_NAME,
                "promptChars": len(req.prompt),
                "memoryCount": len(memories),
                "ttftMs": ttft_ms,
                "totalMs": total_ms,
                "status": "success",
            },
        )

        return GenerateResponse(
            ok=True,
            userId=req.userId,
            output=output,
            metrics={
                "ttftMs": ttft_ms,
                "totalMs": total_ms,
                "modelName": MODEL_NAME,
                "memoryCount": len(memories),
            },
        )

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