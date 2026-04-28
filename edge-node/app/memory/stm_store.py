"""
Short-Term Memory (STM) store for edge-node sessions.

Holds per-session conversation history in-process.  Data is ephemeral —
it lives only as long as the edge-node process is running and is cleared
explicitly when a session ends.

Thread-safe via a single re-entrant lock (matches the LTMCache pattern).
"""

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class STMMessage:
    role: str  # "user" | "assistant"
    content: str
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
        }


class SessionMemory:
    """Conversation buffer for a single session."""

    def __init__(self, session_id: str, user_id: str) -> None:
        self.session_id = session_id
        self.user_id = user_id
        self.created_at = time.time()
        self.last_active_at = self.created_at
        self._messages: List[STMMessage] = []

    def append(self, role: str, content: str) -> None:
        self._messages.append(STMMessage(role=role, content=content))
        self.last_active_at = time.time()

    def append_imported(self, role: str, content: str, timestamp: float) -> None:
        self._messages.append(
            STMMessage(role=role, content=content, timestamp=timestamp)
        )

    def get_history(self) -> List[dict]:
        return [msg.to_dict() for msg in self._messages]

    def export(self) -> dict:
        return {
            "sessionId": self.session_id,
            "userId": self.user_id,
            "createdAt": self.created_at,
            "lastActiveAt": self.last_active_at,
            "messages": self.get_history(),
        }


class STMStore:
    """In-memory store for all active sessions on this edge node."""

    def __init__(self, session_ttl_seconds: Optional[int] = None) -> None:
        self._sessions: Dict[str, SessionMemory] = {}
        self._lock = threading.Lock()
        self.session_ttl_seconds = session_ttl_seconds

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    def get_or_create(self, session_id: str, user_id: str) -> SessionMemory:
        """Return existing session or create a new one.

        Raises ``ValueError`` if the session already exists but belongs to a
        different ``user_id`` (cross-user leakage guard).
        """
        with self._lock:
            existing = self._sessions.get(session_id)
            if existing is not None:
                if existing.user_id != user_id:
                    raise ValueError(
                        f"Session {session_id} belongs to a different user"
                    )
                return existing

            session = SessionMemory(session_id=session_id, user_id=user_id)
            self._sessions[session_id] = session
            return session

    def append(self, session_id: str, role: str, content: str) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return
            session.append(role, content)

    def get_history(self, session_id: str) -> List[dict]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return []
            return session.get_history()

    def end_session(self, session_id: str) -> bool:
        """Remove a session entirely.  Returns True if it existed."""
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    # ------------------------------------------------------------------
    # Handover helpers
    # ------------------------------------------------------------------

    def export_session(self, session_id: str) -> Optional[dict]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return None
            return session.export()

    def import_session(self, data: dict) -> str:
        """Hydrate a session from a handover payload.

        Returns the ``session_id`` of the imported session.
        """
        session_id: str = data["sessionId"]
        user_id: str = data["userId"]
        messages: List[dict] = data.get("messages", [])

        with self._lock:
            session = SessionMemory(session_id=session_id, user_id=user_id)
            session.created_at = data.get("createdAt", time.time())
            session.last_active_at = data.get("lastActiveAt", time.time())

            for msg in messages:
                session.append_imported(
                    msg["role"],
                    msg["content"],
                    msg.get("timestamp", session.last_active_at),
                )

            self._sessions[session_id] = session
            return session_id

    # ------------------------------------------------------------------
    # TTL expiry
    # ------------------------------------------------------------------

    def get_expired_sessions(self) -> List[dict]:
        """Return expired sessions without removing them."""
        if self.session_ttl_seconds is None:
            return []

        now = time.time()
        with self._lock:
            return [
                session.export()
                for session in self._sessions.values()
                if now - session.last_active_at >= self.session_ttl_seconds
            ]

    # ------------------------------------------------------------------
    # Observability
    # ------------------------------------------------------------------

    def stats(self) -> dict:
        with self._lock:
            return {
                "activeSessions": len(self._sessions),
            }
