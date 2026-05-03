import pathlib
import sys
import unittest

from fastapi import HTTPException


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.handover import LocalSessionRegistry  # noqa: E402
from app.handover_package import (  # noqa: E402
    build_handover_package,
    export_handover_package,
    import_handover_package,
)
from app.memory.cache import LTMCache  # noqa: E402
from app.memory.stm_store import STMStore  # noqa: E402
from app.schemas import HandoverExportRequest, HandoverPackageRequest  # noqa: E402


class HandoverPackageTests(unittest.TestCase):
    def test_build_package_includes_stm_and_ltm(self) -> None:
        stm_store = STMStore()
        stm_store.get_or_create(session_id="s1", user_id="u1")
        stm_store.append("s1", "user", "before moving")

        package = build_handover_package(
            edge_node_id="edge-left",
            stm_store=stm_store,
            user_id="u1",
            session_id="s1",
            target_edge_id="edge-right",
            transfer_reason="predictive_client_mobility",
            client_direction="right",
            client_speed=3.5,
            memories=["likes concise answers"],
        )

        self.assertEqual(package["sourceEdgeId"], "edge-left")
        self.assertEqual(package["targetEdgeId"], "edge-right")
        self.assertEqual(package["stm"]["sessionId"], "s1")
        self.assertEqual(package["stm"]["userId"], "u1")
        self.assertEqual(package["stm"]["messages"][0]["content"], "before moving")
        self.assertEqual(package["ltm"], ["likes concise answers"])

    def test_export_package_rejects_wrong_user_for_session(self) -> None:
        stm_store = STMStore()
        ltm_cache = LTMCache()
        stm_store.get_or_create(session_id="s1", user_id="owner")

        with self.assertRaises(HTTPException) as raised:
            export_handover_package(
                edge_node_id="edge-left",
                stm_store=stm_store,
                ltm_cache=ltm_cache,
                request=HandoverExportRequest(
                    userId="attacker",
                    sessionId="s1",
                    targetEdgeId="edge-right",
                ),
            )

        self.assertEqual(raised.exception.status_code, 404)

    def test_export_package_includes_cached_ltm_for_user(self) -> None:
        stm_store = STMStore()
        ltm_cache = LTMCache()
        stm_store.get_or_create(session_id="s1", user_id="u1")
        stm_store.append("s1", "assistant", "context")
        ltm_cache.set("u1", ["memory one", "memory two"])

        package = export_handover_package(
            edge_node_id="edge-left",
            stm_store=stm_store,
            ltm_cache=ltm_cache,
            request=HandoverExportRequest(
                userId="u1",
                sessionId="s1",
                targetEdgeId="edge-right",
            ),
        )

        self.assertEqual(package["transferReason"], "reactive_neighbor_recovery")
        self.assertEqual(package["ltm"], ["memory one", "memory two"])
        self.assertEqual(package["stm"]["messages"][0]["content"], "context")

    def test_import_package_rejects_wrong_target_edge(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            import_handover_package(
                edge_node_id="edge-right",
                stm_store=STMStore(),
                ltm_cache=LTMCache(),
                local_session_registry=LocalSessionRegistry(ttl_seconds=120),
                package=HandoverPackageRequest(
                    userId="u1",
                    sessionId="s1",
                    sourceEdgeId="edge-left",
                    targetEdgeId="edge-other",
                    transferReason="predictive_client_mobility",
                    stm=None,
                    ltm=[],
                ),
            )

        self.assertEqual(raised.exception.status_code, 409)

    def test_import_package_rejects_mismatched_stm_identity(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            import_handover_package(
                edge_node_id="edge-right",
                stm_store=STMStore(),
                ltm_cache=LTMCache(),
                local_session_registry=LocalSessionRegistry(ttl_seconds=120),
                package=HandoverPackageRequest(
                    userId="u1",
                    sessionId="s1",
                    sourceEdgeId="edge-left",
                    targetEdgeId="edge-right",
                    transferReason="predictive_client_mobility",
                    stm={
                        "userId": "u2",
                        "sessionId": "s1",
                        "createdAt": 1000,
                        "lastActiveAt": 1001,
                        "messages": [],
                    },
                    ltm=[],
                ),
            )

        self.assertEqual(raised.exception.status_code, 400)

    def test_import_package_hydrates_stm_ltm_cache_and_local_registry(self) -> None:
        stm_store = STMStore()
        ltm_cache = LTMCache()
        registry = LocalSessionRegistry(ttl_seconds=120)

        result = import_handover_package(
            edge_node_id="edge-right",
            stm_store=stm_store,
            ltm_cache=ltm_cache,
            local_session_registry=registry,
            package=HandoverPackageRequest(
                userId="u1",
                sessionId="s1",
                sourceEdgeId="edge-left",
                targetEdgeId="edge-right",
                transferReason="predictive_client_mobility",
                stm={
                    "userId": "u1",
                    "sessionId": "s1",
                    "createdAt": 1000,
                    "lastActiveAt": 1001,
                    "messages": [
                        {
                            "role": "user",
                            "content": "carry this over",
                            "timestamp": 1000,
                        }
                    ],
                },
                ltm=["cached memory"],
            ),
        )

        self.assertEqual(result, {"stmImported": True, "ltmCount": 1})
        self.assertEqual(stm_store.get_history("s1")[0]["content"], "carry this over")
        self.assertEqual(ltm_cache.get("u1"), ["cached memory"])
        self.assertTrue(
            registry.has_fresh_session(user_id="u1", session_id="s1")
        )

    def test_import_package_without_stm_creates_empty_session(self) -> None:
        stm_store = STMStore()

        result = import_handover_package(
            edge_node_id="edge-right",
            stm_store=stm_store,
            ltm_cache=LTMCache(),
            local_session_registry=LocalSessionRegistry(ttl_seconds=120),
            package=HandoverPackageRequest(
                userId="u1",
                sessionId="s1",
                sourceEdgeId="edge-left",
                targetEdgeId="edge-right",
                transferReason="predictive_client_mobility",
                stm=None,
                ltm=[],
            ),
        )

        self.assertEqual(result, {"stmImported": False, "ltmCount": 0})
        self.assertEqual(stm_store.get_history("s1"), [])
        self.assertEqual(stm_store.export_session("s1")["userId"], "u1")


if __name__ == "__main__":
    unittest.main()
