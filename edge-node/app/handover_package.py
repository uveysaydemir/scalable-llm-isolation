from fastapi import HTTPException

from app.memory.cache import LTMCache
from app.memory.stm_store import STMStore
from app.schemas import HandoverExportRequest, HandoverPackageRequest


def build_handover_package(
    *,
    edge_node_id: str,
    stm_store: STMStore,
    user_id: str,
    session_id: str,
    target_edge_id: str,
    transfer_reason: str,
    client_direction: str | None,
    client_speed: float | None,
    memories: list[str],
) -> dict:
    return {
        "userId": user_id,
        "sessionId": session_id,
        "sourceEdgeId": edge_node_id,
        "targetEdgeId": target_edge_id,
        "transferReason": transfer_reason,
        "clientDirection": client_direction,
        "clientSpeed": client_speed,
        "stm": stm_store.export_session(session_id),
        "ltm": memories,
    }


def import_handover_package(
    *,
    edge_node_id: str,
    stm_store: STMStore,
    ltm_cache: LTMCache,
    local_session_registry,
    package: HandoverPackageRequest,
) -> dict:
    if package.targetEdgeId != edge_node_id:
        raise HTTPException(
            status_code=409,
            detail=f"Package target is {package.targetEdgeId}, not {edge_node_id}",
        )

    if package.stm is not None:
        stm_user_id = package.stm.get("userId")
        stm_session_id = package.stm.get("sessionId")
        if stm_user_id != package.userId or stm_session_id != package.sessionId:
            raise HTTPException(
                status_code=400,
                detail="STM package userId/sessionId does not match handover package",
            )
        stm_store.import_session(package.stm)
    else:
        stm_store.get_or_create(
            session_id=package.sessionId,
            user_id=package.userId,
        )

    ltm_cache.set(package.userId, package.ltm)
    local_session_registry.touch(
        user_id=package.userId,
        session_id=package.sessionId,
        edge_id=edge_node_id,
    )

    return {
        "stmImported": package.stm is not None,
        "ltmCount": len(package.ltm),
    }


def export_handover_package(
    *,
    edge_node_id: str,
    stm_store: STMStore,
    ltm_cache: LTMCache,
    request: HandoverExportRequest,
) -> dict:
    session = stm_store.export_session(request.sessionId)
    if session is None or session["userId"] != request.userId:
        raise HTTPException(status_code=404, detail="Session not found on this edge")

    memories = ltm_cache.get(request.userId) or []
    return build_handover_package(
        edge_node_id=edge_node_id,
        stm_store=stm_store,
        user_id=request.userId,
        session_id=request.sessionId,
        target_edge_id=request.targetEdgeId,
        transfer_reason="reactive_neighbor_recovery",
        client_direction=None,
        client_speed=None,
        memories=memories,
    )
