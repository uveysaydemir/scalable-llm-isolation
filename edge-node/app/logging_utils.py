import json
import logging
from datetime import datetime

#Logger for edge-node
logger = logging.getLogger("edge-node")
logging.basicConfig(level=logging.INFO)

def log_event(event: str, payload: dict):
    data = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "event": event,
        **payload
    }
    logger.info(json.dumps(data))