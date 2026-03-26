#Logger for edge-node
    
import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger("edge-node")
logging.basicConfig(level=logging.INFO)


def log_event(event: str, payload: dict) -> None:
    data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **payload,
    }
    logger.info(json.dumps(data))