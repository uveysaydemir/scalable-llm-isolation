import pathlib
import sys
import unittest


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.memory.stm_store import STMStore  # noqa: E402


class STMStoreTests(unittest.TestCase):
    def test_creates_session_and_preserves_message_order(self) -> None:
        store = STMStore()
        store.get_or_create(session_id="s1", user_id="u1")

        store.append("s1", "user", "hello")
        store.append("s1", "assistant", "hi")
        store.append("s1", "user", "remember this")

        history = store.get_history("s1")

        self.assertEqual(
            [(message["role"], message["content"]) for message in history],
            [
                ("user", "hello"),
                ("assistant", "hi"),
                ("user", "remember this"),
            ],
        )

    def test_rejects_existing_session_for_different_user(self) -> None:
        store = STMStore()
        store.get_or_create(session_id="shared-session", user_id="u1")

        with self.assertRaisesRegex(ValueError, "different user"):
            store.get_or_create(session_id="shared-session", user_id="u2")

    def test_export_and_import_preserves_session_identity_and_messages(self) -> None:
        source = STMStore()
        source.get_or_create(session_id="s1", user_id="u1")
        source.append("s1", "user", "first")
        source.append("s1", "assistant", "second")

        exported = source.export_session("s1")
        self.assertIsNotNone(exported)

        target = STMStore()
        imported_session_id = target.import_session(exported)

        self.assertEqual(imported_session_id, "s1")
        self.assertEqual(target.export_session("s1")["userId"], "u1")
        self.assertEqual(
            [(message["role"], message["content"]) for message in target.get_history("s1")],
            [("user", "first"), ("assistant", "second")],
        )

    def test_expired_sessions_are_reported_without_removing_them(self) -> None:
        store = STMStore(session_ttl_seconds=0)
        store.get_or_create(session_id="s1", user_id="u1")
        store.append("s1", "user", "expired immediately")

        expired = store.get_expired_sessions()

        self.assertEqual(len(expired), 1)
        self.assertEqual(expired[0]["sessionId"], "s1")
        self.assertEqual(expired[0]["userId"], "u1")
        self.assertIsNotNone(store.export_session("s1"))

    def test_end_session_removes_only_existing_session(self) -> None:
        store = STMStore()
        store.get_or_create(session_id="s1", user_id="u1")

        self.assertTrue(store.end_session("s1"))
        self.assertFalse(store.end_session("s1"))
        self.assertEqual(store.get_history("s1"), [])


if __name__ == "__main__":
    unittest.main()
