import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Literal, Optional, Tuple


RecoveryMode = Literal["neighbor_recovery", "global_recovery", "local_session"]


@dataclass(frozen=True)
class HandoverDetectionInput:
    user_id: str
    session_id: Optional[str]
    last_message_timestamp: Optional[float]
    current_edge_id: str


@dataclass(frozen=True)
class HandoverDecision:
    mode: RecoveryMode
    user_id: str
    session_id: Optional[str]
    current_edge_id: str
    freshness_threshold_seconds: int
    has_local_session: bool
    last_message_age_seconds: Optional[float]
    reason: str

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "userId": self.user_id,
            "sessionId": self.session_id,
            "currentEdgeId": self.current_edge_id,
            "freshnessThresholdSeconds": self.freshness_threshold_seconds,
            "hasLocalSession": self.has_local_session,
            "lastMessageAgeSeconds": self.last_message_age_seconds,
            "reason": self.reason,
        }


@dataclass
class LocalSessionRecord:
    user_id: str
    session_id: str
    edge_id: str
    last_seen_at: float


class LocalSessionRegistry:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._sessions: Dict[Tuple[str, str], LocalSessionRecord] = {}

    def has_fresh_session(
        self,
        *,
        user_id: str,
        session_id: Optional[str],
        now: Optional[float] = None,
    ) -> bool:
        if not session_id:
            return False

        record = self._sessions.get((user_id, session_id))
        if record is None:
            return False

        now_seconds = now if now is not None else time.time()
        if now_seconds - record.last_seen_at > self.ttl_seconds:
            self._sessions.pop((user_id, session_id), None)
            return False

        return True

    def touch(
        self,
        *,
        user_id: str,
        session_id: Optional[str],
        edge_id: str,
        now: Optional[float] = None,
    ) -> None:
        if not session_id:
            return

        now_seconds = now if now is not None else time.time()
        self._sessions[(user_id, session_id)] = LocalSessionRecord(
            user_id=user_id,
            session_id=session_id,
            edge_id=edge_id,
            last_seen_at=now_seconds,
        )

    def stats(self) -> dict:
        return {
            "ttlSeconds": self.ttl_seconds,
            "entryCount": len(self._sessions),
        }


def parse_timestamp_seconds(value: object) -> Optional[float]:
    if value is None:
        return None

    if isinstance(value, datetime):
        timestamp = value
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return timestamp.timestamp()

    if isinstance(value, (int, float)):
        return normalize_epoch_timestamp(float(value))

    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None

        try:
            return normalize_epoch_timestamp(float(stripped))
        except ValueError:
            pass

        iso_value = stripped.replace("Z", "+00:00")
        timestamp = datetime.fromisoformat(iso_value)
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return timestamp.timestamp()

    raise TypeError("lastMessageTimestamp must be ISO-8601 text or epoch time")


def normalize_epoch_timestamp(value: float) -> float:
    # Browser clients often send Date.now() milliseconds. Unix seconds are
    # currently 10 digits, while milliseconds are 13 digits.
    if value > 10_000_000_000:
        return value / 1000
    return value


def decide_handover(
    *,
    detection_input: HandoverDetectionInput,
    has_local_session: bool,
    freshness_threshold_seconds: int,
    now: Optional[float] = None,
) -> HandoverDecision:
    now_seconds = now if now is not None else time.time()
    last_message_age_seconds = None

    if detection_input.last_message_timestamp is not None:
        last_message_age_seconds = round(
            max(0, now_seconds - detection_input.last_message_timestamp),
            3,
        )

    if has_local_session:
        return HandoverDecision(
            mode="local_session",
            user_id=detection_input.user_id,
            session_id=detection_input.session_id,
            current_edge_id=detection_input.current_edge_id,
            freshness_threshold_seconds=freshness_threshold_seconds,
            has_local_session=True,
            last_message_age_seconds=last_message_age_seconds,
            reason="session_found_on_current_edge",
        )

    if not detection_input.session_id:
        return HandoverDecision(
            mode="local_session",
            user_id=detection_input.user_id,
            session_id=detection_input.session_id,
            current_edge_id=detection_input.current_edge_id,
            freshness_threshold_seconds=freshness_threshold_seconds,
            has_local_session=False,
            last_message_age_seconds=last_message_age_seconds,
            reason="no_session_id_supplied",
        )

    if detection_input.last_message_timestamp is None:
        return HandoverDecision(
            mode="local_session",
            user_id=detection_input.user_id,
            session_id=detection_input.session_id,
            current_edge_id=detection_input.current_edge_id,
            freshness_threshold_seconds=freshness_threshold_seconds,
            has_local_session=False,
            last_message_age_seconds=None,
            reason="no_last_message_timestamp_supplied",
        )

    if last_message_age_seconds is not None and (
        last_message_age_seconds <= freshness_threshold_seconds
    ):
        return HandoverDecision(
            mode="neighbor_recovery",
            user_id=detection_input.user_id,
            session_id=detection_input.session_id,
            current_edge_id=detection_input.current_edge_id,
            freshness_threshold_seconds=freshness_threshold_seconds,
            has_local_session=False,
            last_message_age_seconds=last_message_age_seconds,
            reason="recent_session_missing_on_current_edge",
        )

    return HandoverDecision(
        mode="global_recovery",
        user_id=detection_input.user_id,
        session_id=detection_input.session_id,
        current_edge_id=detection_input.current_edge_id,
        freshness_threshold_seconds=freshness_threshold_seconds,
        has_local_session=False,
        last_message_age_seconds=last_message_age_seconds,
        reason="stale_session_missing_on_current_edge",
    )
