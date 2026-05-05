import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from threading import Thread
from typing import List, Optional

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

from app.config import (
    EDGE_NODE_ID,
    EDGE_NEIGHBOR_LEFT_URL,
    EDGE_NEIGHBOR_RIGHT_URL,
    EDGE_TOPOLOGY,
    HANDOVER_FRESHNESS_THRESHOLD_SECONDS,
    MIN_HANDOVER_PREFETCH_SPEED,
    MODEL_NAME,
    MEMORY_SEARCH_LIMIT,
    LTM_CACHE_TTL_SECONDS,
    STM_TTL_SECONDS,
)
from app.handover import (
    HandoverDecision,
    HandoverDetectionInput,
    LocalSessionRegistry,
    decide_handover,
    estimate_neighbor_edge_id,
    opposite_direction,
    parse_timestamp_seconds,
)
from app.handover_package import (
    build_handover_package as build_handover_package_payload,
)
from app.handover_package import (
    export_handover_package as export_handover_package_payload,
)
from app.handover_package import (
    import_handover_package as import_handover_package_payload,
)
from app.logging_utils import log_event
from app.memory.cache import LTMCache
from app.memory.stm_store import STMStore
from app.memory_client import MemoryClient
from app.prompt_builder import build_messages, build_prompt
from app.schemas import (
    GenerateRequest,
    GenerateResponse,
    HandoverDecisionRequest,
    HandoverExportRequest,
    HandoverPackageRequest,
    MemoryAddRequest,
    RuntimeSettingsRequest,
    SessionEndRequest,
)

memory_client = MemoryClient()
ltm_cache = LTMCache(ttl_seconds=LTM_CACHE_TTL_SECONDS)
stm_store = STMStore(session_ttl_seconds=STM_TTL_SECONDS)


async def _flush_expired_stm_loop() -> None:
    """Background loop: flush expired STM sessions to the global memory-layer."""
    while True:
        await asyncio.sleep(60)
        try:
            expired = stm_store.get_expired_sessions()
            for session_data in expired:
                session_id: str = session_data["sessionId"]
                user_id: str = session_data["userId"]
                messages: list = session_data["messages"]
                try:
                    if messages:
                        await memory_client.add_messages(
                            user_id=user_id,
                            messages=[
                                {"role": m["role"], "content": m["content"]}
                                for m in messages
                            ],
                        )
                    stm_store.end_session(session_id)
                    log_event(
                        "stm_flushed_to_memory",
                        {"userId": user_id, "sessionId": session_id, "messageCount": len(messages)},
                    )
                except Exception as e:
                    log_event(
                        "stm_flush_failed",
                        {"userId": user_id, "sessionId": session_id, "error": str(e)},
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

local_session_registry = LocalSessionRegistry(
    ttl_seconds=HANDOVER_FRESHNESS_THRESHOLD_SECONDS
)


def elapsed_ms(start: float, end: float | None = None) -> float:
    finish = end if end is not None else time.perf_counter()
    return round((finish - start) * 1000, 2)


def classify_handover(
    *,
    user_id: str,
    session_id: str | None,
    last_message_timestamp: object,
) -> HandoverDecision:
    try:
        last_message_timestamp_seconds = parse_timestamp_seconds(
            last_message_timestamp
        )
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    now = time.time()
    has_local_session = local_session_registry.has_fresh_session(
        user_id=user_id,
        session_id=session_id,
        now=now,
    )

    return decide_handover(
        detection_input=HandoverDetectionInput(
            user_id=user_id,
            session_id=session_id,
            last_message_timestamp=last_message_timestamp_seconds,
            current_edge_id=EDGE_NODE_ID,
        ),
        has_local_session=has_local_session,
        freshness_threshold_seconds=local_session_registry.ttl_seconds,
        now=now,
    )


def neighbor_url(direction: str) -> Optional[str]:
    if direction == "left":
        return EDGE_NEIGHBOR_LEFT_URL
    if direction == "right":
        return EDGE_NEIGHBOR_RIGHT_URL
    return None


def estimate_neighbor(direction: str | None) -> tuple[Optional[str], Optional[str]]:
    if direction is None:
        return None, None

    target_edge_id = estimate_neighbor_edge_id(
        current_edge_id=EDGE_NODE_ID,
        direction=direction,
        topology=EDGE_TOPOLOGY,
    )
    target_url = neighbor_url(direction)
    return target_edge_id, target_url


def build_handover_package(
    *,
    user_id: str,
    session_id: str,
    target_edge_id: str,
    transfer_reason: str,
    client_direction: str | None,
    client_speed: float | None,
    memories: List[str],
) -> dict:
    return build_handover_package_payload(
        edge_node_id=EDGE_NODE_ID,
        stm_store=stm_store,
        user_id=user_id,
        session_id=session_id,
        target_edge_id=target_edge_id,
        transfer_reason=transfer_reason,
        client_direction=client_direction,
        client_speed=client_speed,
        memories=memories,
    )


def import_handover_package(package: HandoverPackageRequest) -> dict:
    return import_handover_package_payload(
        edge_node_id=EDGE_NODE_ID,
        stm_store=stm_store,
        ltm_cache=ltm_cache,
        local_session_registry=local_session_registry,
        package=package,
    )


async def send_handover_package(
    *,
    target_url: str,
    package: dict,
) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.post(f"{target_url}/handover/package", json=package)
            res.raise_for_status()

        log_event(
            "handover_package_sent",
            {
                "sourceEdgeId": EDGE_NODE_ID,
                "targetEdgeId": package["targetEdgeId"],
                "targetUrl": target_url,
                "userId": package["userId"],
                "sessionId": package["sessionId"],
                "transferReason": package["transferReason"],
                "stmIncluded": package["stm"] is not None,
                "ltmCount": len(package["ltm"]),
            },
        )
    except Exception as e:
        log_event(
            "handover_package_send_failed",
            {
                "sourceEdgeId": EDGE_NODE_ID,
                "targetEdgeId": package.get("targetEdgeId"),
                "targetUrl": target_url,
                "userId": package.get("userId"),
                "sessionId": package.get("sessionId"),
                "error": str(e),
            },
        )


async def recover_from_neighbor(
    *,
    user_id: str,
    session_id: str,
    client_direction: str | None,
) -> dict:
    if client_direction is None:
        return {"attempted": False, "reason": "no_client_direction"}

    source_direction = opposite_direction(client_direction)
    source_edge_id, source_url = estimate_neighbor(source_direction)
    if source_edge_id is None or source_url is None:
        return {
            "attempted": False,
            "reason": "source_neighbor_not_configured",
            "sourceDirection": source_direction,
        }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.post(
                f"{source_url}/handover/export",
                json={
                    "userId": user_id,
                    "sessionId": session_id,
                    "targetEdgeId": EDGE_NODE_ID,
                },
            )

        if res.status_code == 404:
            return {
                "attempted": True,
                "recovered": False,
                "sourceEdgeId": source_edge_id,
                "sourceUrl": source_url,
                "reason": "source_session_not_found",
            }

        res.raise_for_status()
        package = HandoverPackageRequest(**res.json()["package"])
        import_result = import_handover_package(package)

        return {
            "attempted": True,
            "recovered": True,
            "sourceEdgeId": source_edge_id,
            "sourceUrl": source_url,
            **import_result,
        }
    except Exception as e:
        return {
            "attempted": True,
            "recovered": False,
            "sourceEdgeId": source_edge_id,
            "sourceUrl": source_url,
            "error": str(e),
        }


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
        "edgeNodeId": EDGE_NODE_ID,
        "modelName": MODEL_NAME,
        "ltmCache": ltm_cache.stats(),
        "localSessionRegistry": local_session_registry.stats(),
        "stm": stm_store.stats(),
        "handover": {
            "topology": EDGE_TOPOLOGY,
            "leftNeighborUrl": EDGE_NEIGHBOR_LEFT_URL,
            "rightNeighborUrl": EDGE_NEIGHBOR_RIGHT_URL,
            "minPrefetchSpeed": MIN_HANDOVER_PREFETCH_SPEED,
        },
    }


@app.get("/settings")
def get_runtime_settings():
    return {
        "ok": True,
        "edgeNodeId": EDGE_NODE_ID,
        "sessionTtlSeconds": local_session_registry.ttl_seconds,
        "stmTtlSeconds": stm_store.session_ttl_seconds,
        "ltmCacheTtlSeconds": ltm_cache.ttl_seconds,
    }


@app.post("/settings")
def update_runtime_settings(req: RuntimeSettingsRequest):
    local_session_registry.ttl_seconds = req.sessionTtlSeconds
    stm_store.session_ttl_seconds = req.sessionTtlSeconds
    ltm_cache.update_ttl(req.ltmCacheTtlSeconds)

    log_event(
        "runtime_settings_updated",
        {
            "edgeNodeId": EDGE_NODE_ID,
            "sessionTtlSeconds": req.sessionTtlSeconds,
            "ltmCacheTtlSeconds": req.ltmCacheTtlSeconds,
        },
    )

    return {
        "ok": True,
        "edgeNodeId": EDGE_NODE_ID,
        "sessionTtlSeconds": local_session_registry.ttl_seconds,
        "stmTtlSeconds": stm_store.session_ttl_seconds,
        "ltmCacheTtlSeconds": ltm_cache.ttl_seconds,
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


@app.get("/debug/user-state")
def debug_user_state(userId: str, sessionId: Optional[str] = None):
    try:
        stm = None
        if sessionId:
            exported = stm_store.export_session(sessionId)
            if exported is not None and exported["userId"] == userId:
                stm = exported

        ltm = ltm_cache.snapshot(userId)

        return {
            "ok": True,
            "edgeNodeId": EDGE_NODE_ID,
            "userId": userId,
            "sessionId": sessionId,
            "stm": stm,
            "ltm": ltm
            or {
                "present": False,
                "memories": [],
                "cachedAt": None,
                "expiresAt": None,
                "ttlSeconds": ltm_cache.ttl_seconds,
            },
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/handover/decision")
def debug_handover_decision(req: HandoverDecisionRequest):
    try:
        decision = classify_handover(
            user_id=req.userId,
            session_id=req.sessionId,
            last_message_timestamp=req.lastMessageTimestamp,
        )

        log_event(
            "handover_decision",
            {
                "requestPath": "/handover/decision",
                **decision.to_dict(),
            },
        )

        return {
            "ok": True,
            "decision": decision.to_dict(),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/handover/package")
def receive_handover_package(req: HandoverPackageRequest):
    try:
        import_result = import_handover_package(req)

        log_event(
            "handover_package_received",
            {
                "sourceEdgeId": req.sourceEdgeId,
                "targetEdgeId": EDGE_NODE_ID,
                "userId": req.userId,
                "sessionId": req.sessionId,
                "transferReason": req.transferReason,
                **import_result,
            },
        )

        return {
            "ok": True,
            "edgeNodeId": EDGE_NODE_ID,
            **import_result,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/handover/export")
def export_handover_package(req: HandoverExportRequest):
    package = export_handover_package_payload(
        edge_node_id=EDGE_NODE_ID,
        stm_store=stm_store,
        ltm_cache=ltm_cache,
        request=req,
    )

    log_event(
        "handover_package_exported",
        {
            "sourceEdgeId": EDGE_NODE_ID,
            "targetEdgeId": req.targetEdgeId,
            "userId": req.userId,
            "sessionId": req.sessionId,
            "stmIncluded": package["stm"] is not None,
            "ltmCount": len(package["ltm"]),
        },
    )

    return {
        "ok": True,
        "package": package,
    }


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest, background_tasks: BackgroundTasks):
    request_id = str(uuid.uuid4())
    session_id = req.sessionId or str(uuid.uuid4())
    started = time.perf_counter()
    timings: dict[str, float | None] = {}

    try:
        handover_decision_started = time.perf_counter()
        handover_decision = classify_handover(
            user_id=req.userId,
            session_id=req.sessionId,
            last_message_timestamp=req.lastMessageTimestamp,
        )
        timings["handoverDecisionMs"] = elapsed_ms(handover_decision_started)

        log_event(
            "handover_decision",
            {
                "requestId": request_id,
                "requestPath": "/generate",
                **handover_decision.to_dict(),
            },
        )

        neighbor_recovery = {"attempted": False}
        timings["neighborRecoveryMs"] = 0
        if handover_decision.mode == "neighbor_recovery" and req.sessionId:
            neighbor_recovery_started = time.perf_counter()
            neighbor_recovery = await recover_from_neighbor(
                user_id=req.userId,
                session_id=req.sessionId,
                client_direction=req.clientDirection,
            )
            timings["neighborRecoveryMs"] = elapsed_ms(neighbor_recovery_started)
            log_event(
                "neighbor_recovery_completed",
                {
                    "requestId": request_id,
                    "userId": req.userId,
                    "sessionId": req.sessionId,
                    "edgeNodeId": EDGE_NODE_ID,
                    **neighbor_recovery,
                },
            )

            if neighbor_recovery.get("recovered"):
                handover_reclassify_started = time.perf_counter()
                handover_decision = classify_handover(
                    user_id=req.userId,
                    session_id=req.sessionId,
                    last_message_timestamp=req.lastMessageTimestamp,
                )
                timings["handoverReclassifyMs"] = elapsed_ms(
                    handover_reclassify_started
                )

        stm_started = time.perf_counter()
        try:
            stm_store.get_or_create(session_id=session_id, user_id=req.userId)
        except ValueError as e:
            raise HTTPException(status_code=403, detail=str(e))

        local_session_registry.touch(
            user_id=req.userId,
            session_id=session_id,
            edge_id=EDGE_NODE_ID,
        )
        ltm_cache.touch(req.userId)

        stm_history = stm_store.get_history(session_id)
        timings["stmReadMs"] = elapsed_ms(stm_started)

        memory_started = time.perf_counter()
        memories, memory_source = await retrieve_memories(
            user_id=req.userId,
            query=req.prompt,
            limit=MEMORY_SEARCH_LIMIT,
        )
        timings["memoryRetrievalMs"] = elapsed_ms(memory_started)

        prompt_started = time.perf_counter()
        messages = build_messages(
            user_prompt=req.prompt,
            memories=memories,
            history=stm_history,
        )

        if getattr(tokenizer, "chat_template", None):
            model_input = tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        else:
            model_input = build_prompt(
                user_prompt=req.prompt,
                memories=memories,
                history=stm_history,
            )
        timings["promptBuildMs"] = elapsed_ms(prompt_started)

        tokenization_started = time.perf_counter()
        inputs = tokenizer(model_input, return_tensors="pt")
        timings["tokenizationMs"] = elapsed_ms(tokenization_started)
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
            "temperature": 0.2,
            "top_p": 0.9,
            "pad_token_id": tokenizer.eos_token_id,
        }

        inference_started = time.perf_counter()
        thread = Thread(target=model.generate, kwargs=generation_kwargs)
        thread.start()

        first_token_time = None
        chunks = []

        for chunk in streamer:
            if first_token_time is None:
                first_token_time = time.perf_counter()
            chunks.append(chunk)

        thread.join()

        inference_finished = time.perf_counter()
        output = "".join(chunks).strip()
        timings["inferenceMs"] = elapsed_ms(inference_started, inference_finished)

        ttft_ms = None
        if first_token_time is not None:
            ttft_ms = round((first_token_time - started) * 1000, 2)
            timings["inferenceTtftMs"] = elapsed_ms(
                inference_started,
                first_token_time,
            )

        postprocess_started = time.perf_counter()

        stm_store.append(session_id, "user", req.prompt)
        stm_store.append(session_id, "assistant", output)

        proactive_handover = {
            "scheduled": False,
            "reason": "no_client_direction",
        }
        if req.clientDirection is not None:
            target_edge_id, target_url = estimate_neighbor(req.clientDirection)
            speed = req.clientSpeed if req.clientSpeed is not None else 0

            if speed <= MIN_HANDOVER_PREFETCH_SPEED:
                proactive_handover = {
                    "scheduled": False,
                    "reason": "client_speed_below_threshold",
                    "clientDirection": req.clientDirection,
                    "clientSpeed": speed,
                    "minPrefetchSpeed": MIN_HANDOVER_PREFETCH_SPEED,
                }
            elif target_edge_id is None or target_url is None:
                proactive_handover = {
                    "scheduled": False,
                    "reason": "target_neighbor_not_configured",
                    "clientDirection": req.clientDirection,
                    "clientSpeed": speed,
                }
            else:
                package = build_handover_package(
                    user_id=req.userId,
                    session_id=session_id,
                    target_edge_id=target_edge_id,
                    transfer_reason="predictive_client_mobility",
                    client_direction=req.clientDirection,
                    client_speed=speed,
                    memories=memories,
                )
                background_tasks.add_task(
                    send_handover_package,
                    target_url=target_url,
                    package=package,
                )
                proactive_handover = {
                    "scheduled": True,
                    "targetEdgeId": target_edge_id,
                    "targetUrl": target_url,
                    "clientDirection": req.clientDirection,
                    "clientSpeed": speed,
                    "stmIncluded": package["stm"] is not None,
                    "ltmCount": len(memories),
                }
        timings["postInferenceMs"] = elapsed_ms(postprocess_started)

        background_tasks.add_task(
            persist_memory_background,
            req.userId,
            req.prompt,
            output,
        )

        finished = time.perf_counter()
        total_ms = elapsed_ms(started, finished)
        inference_ms = timings.get("inferenceMs")
        inference_excluded_ms = None
        if isinstance(inference_ms, (int, float)):
            inference_excluded_ms = round(total_ms - inference_ms, 2)
        timings["inferenceExcludedMs"] = inference_excluded_ms

        log_event(
            "generate_completed",
            {
                "requestId": request_id,
                "userId": req.userId,
                "sessionId": req.sessionId,
                "edgeNodeId": EDGE_NODE_ID,
                "handoverMode": handover_decision.mode,
                "sessionId": session_id,
                "clientDirection": req.clientDirection,
                "clientSpeed": req.clientSpeed,
                "model": MODEL_NAME,
                "promptChars": len(req.prompt),
                "memoryCount": len(memories),
                "memorySource": memory_source,
                "stmTurns": len(stm_history),
                "neighborRecovery": neighbor_recovery,
                "proactiveHandover": proactive_handover,
                "ttftMs": ttft_ms,
                "totalMs": total_ms,
                "timings": timings,
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
                "inferenceMs": timings["inferenceMs"],
                "inferenceExcludedMs": timings["inferenceExcludedMs"],
                "timings": timings,
                "modelName": MODEL_NAME,
                "memoryCount": len(memories),
                "memorySource": memory_source,
                "edgeNodeId": EDGE_NODE_ID,
                "sessionId": session_id,
                "handover": handover_decision.to_dict(),
                "neighborRecovery": neighbor_recovery,
                "proactiveHandover": proactive_handover,
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
                "sessionId": req.sessionId,
                "edgeNodeId": EDGE_NODE_ID,
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
