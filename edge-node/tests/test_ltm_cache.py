import pathlib
import sys
import unittest
from unittest.mock import patch


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.memory.cache import LTMCache  # noqa: E402


class LTMCacheTests(unittest.TestCase):
    def test_returns_cached_memories_before_ttl_expires(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1059):
            self.assertEqual(cache.get("u1"), ["memory"])

    def test_snapshot_returns_cached_memories_and_expiry_metadata(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1059):
            self.assertEqual(
                cache.snapshot("u1"),
                {
                    "present": True,
                    "memories": ["memory"],
                    "cachedAt": 1000,
                    "expiresAt": 1060,
                    "ttlSeconds": 60,
                },
            )

    def test_expires_cached_memories_at_ttl_boundary(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1060):
            self.assertIsNone(cache.get("u1"))

        self.assertEqual(cache.stats()["entryCount"], 0)

    def test_snapshot_expires_cached_memories_at_ttl_boundary(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1060):
            self.assertIsNone(cache.snapshot("u1"))

        self.assertEqual(cache.stats()["entryCount"], 0)

    def test_invalidate_removes_only_requested_user(self) -> None:
        cache = LTMCache()
        cache.set("u1", ["one"])
        cache.set("u2", ["two"])

        cache.invalidate("u1")

        self.assertIsNone(cache.get("u1"))
        self.assertEqual(cache.get("u2"), ["two"])

    def test_touch_extends_existing_cache_entry(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1050):
            self.assertTrue(cache.touch("u1"))

        with patch("app.memory.cache.time.time", return_value=1109):
            self.assertEqual(cache.get("u1"), ["memory"])

    def test_update_ttl_rebases_existing_cache_expiry(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1020):
            cache.update_ttl(10)
            snapshot = cache.snapshot("u1")

        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["ttlSeconds"], 10)
        self.assertEqual(snapshot["expiresAt"], 1030)

    def test_touch_returns_false_for_missing_or_expired_entry(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        self.assertFalse(cache.touch("missing"))

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1060):
            self.assertFalse(cache.touch("u1"))

        self.assertEqual(cache.stats()["entryCount"], 0)

    def test_clear_removes_all_entries(self) -> None:
        cache = LTMCache()
        cache.set("u1", ["one"])
        cache.set("u2", ["two"])

        cache.clear()

        self.assertEqual(cache.stats()["entryCount"], 0)
        self.assertIsNone(cache.get("u1"))
        self.assertIsNone(cache.get("u2"))

    def test_stats_prunes_expired_entries(self) -> None:
        cache = LTMCache(ttl_seconds=60)

        with patch("app.memory.cache.time.time", return_value=1000):
            cache.set("u1", ["memory"])

        with patch("app.memory.cache.time.time", return_value=1060):
            self.assertEqual(cache.stats()["entryCount"], 0)


if __name__ == "__main__":
    unittest.main()
