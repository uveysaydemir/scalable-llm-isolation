import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.handover import (  # noqa: E402
    HandoverDetectionInput,
    LocalSessionRegistry,
    decide_handover,
    parse_timestamp_seconds,
)


class HandoverDecisionTests(unittest.TestCase):
    def test_known_local_session_stays_local(self) -> None:
        decision = decide_handover(
            detection_input=HandoverDetectionInput(
                user_id="u1",
                session_id="s1",
                last_message_timestamp=950,
                current_edge_id="edge-a",
            ),
            has_local_session=True,
            freshness_threshold_seconds=120,
            now=1000,
        )

        self.assertEqual(decision.mode, "local_session")
        self.assertEqual(decision.reason, "session_found_on_current_edge")

    def test_recent_unknown_session_uses_neighbor_recovery(self) -> None:
        decision = decide_handover(
            detection_input=HandoverDetectionInput(
                user_id="u1",
                session_id="s1",
                last_message_timestamp=950,
                current_edge_id="edge-b",
            ),
            has_local_session=False,
            freshness_threshold_seconds=120,
            now=1000,
        )

        self.assertEqual(decision.mode, "neighbor_recovery")
        self.assertEqual(decision.reason, "recent_session_missing_on_current_edge")
        self.assertEqual(decision.last_message_age_seconds, 50)

    def test_stale_unknown_session_uses_global_recovery(self) -> None:
        decision = decide_handover(
            detection_input=HandoverDetectionInput(
                user_id="u1",
                session_id="s1",
                last_message_timestamp=800,
                current_edge_id="edge-b",
            ),
            has_local_session=False,
            freshness_threshold_seconds=120,
            now=1000,
        )

        self.assertEqual(decision.mode, "global_recovery")
        self.assertEqual(decision.reason, "stale_session_missing_on_current_edge")
        self.assertEqual(decision.last_message_age_seconds, 200)

    def test_missing_session_timestamp_is_treated_as_local(self) -> None:
        decision = decide_handover(
            detection_input=HandoverDetectionInput(
                user_id="u1",
                session_id="s1",
                last_message_timestamp=None,
                current_edge_id="edge-a",
            ),
            has_local_session=False,
            freshness_threshold_seconds=120,
            now=1000,
        )

        self.assertEqual(decision.mode, "local_session")
        self.assertEqual(decision.reason, "no_last_message_timestamp_supplied")

    def test_local_registry_expires_sessions(self) -> None:
        registry = LocalSessionRegistry(ttl_seconds=120)
        registry.touch(user_id="u1", session_id="s1", edge_id="edge-a", now=1000)

        self.assertTrue(
            registry.has_fresh_session(user_id="u1", session_id="s1", now=1060)
        )
        self.assertFalse(
            registry.has_fresh_session(user_id="u1", session_id="s1", now=1121)
        )

    def test_timestamp_parser_supports_browser_epoch_milliseconds(self) -> None:
        self.assertEqual(parse_timestamp_seconds(1_700_000_000_000), 1_700_000_000)


if __name__ == "__main__":
    unittest.main()
