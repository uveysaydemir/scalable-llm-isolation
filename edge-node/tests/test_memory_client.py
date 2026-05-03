import pathlib
import sys
import unittest
from unittest.mock import patch


sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.memory_client import MemoryClient  # noqa: E402


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.raise_for_status_called = False

    def raise_for_status(self) -> None:
        self.raise_for_status_called = True

    def json(self) -> dict:
        return self.payload


class FakeAsyncClient:
    requests = []
    next_response = FakeResponse({})

    def __init__(self, timeout: float) -> None:
        self.timeout = timeout

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None

    async def post(self, url: str, json: dict) -> FakeResponse:
        self.requests.append({"url": url, "json": json, "timeout": self.timeout})
        return self.next_response


class MemoryClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        FakeAsyncClient.requests = []
        FakeAsyncClient.next_response = FakeResponse({})

    async def test_search_sends_expected_payload_and_extracts_memory_text(self) -> None:
        FakeAsyncClient.next_response = FakeResponse(
            {
                "results": [
                    {"memory": "likes short answers"},
                    {"memory": ""},
                    {"other": "ignored"},
                    {"memory": "prefers Python"},
                ]
            }
        )

        with patch("app.memory_client.httpx.AsyncClient", FakeAsyncClient):
            memories = await MemoryClient().search(user_id="u1", query="prefs", limit=2)

        self.assertEqual(memories, ["likes short answers", "prefers Python"])
        self.assertEqual(
            FakeAsyncClient.requests[0]["json"],
            {"userId": "u1", "query": "prefs", "limit": 2},
        )
        self.assertTrue(FakeAsyncClient.next_response.raise_for_status_called)

    async def test_search_tolerates_missing_results_field(self) -> None:
        FakeAsyncClient.next_response = FakeResponse({"ok": True})

        with patch("app.memory_client.httpx.AsyncClient", FakeAsyncClient):
            memories = await MemoryClient().search(user_id="u1", query="prefs")

        self.assertEqual(memories, [])

    async def test_add_messages_sends_expected_payload(self) -> None:
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        FakeAsyncClient.next_response = FakeResponse({"ok": True})

        with patch("app.memory_client.httpx.AsyncClient", FakeAsyncClient):
            await MemoryClient().add_messages(user_id="u1", messages=messages)

        self.assertEqual(
            FakeAsyncClient.requests[0]["json"],
            {"userId": "u1", "messages": messages},
        )
        self.assertTrue(FakeAsyncClient.next_response.raise_for_status_called)


if __name__ == "__main__":
    unittest.main()
