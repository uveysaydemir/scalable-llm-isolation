import os

EDGE_PORT = int(os.getenv("EDGE_PORT", "8080"))
EDGE_NODE_ID = os.getenv("EDGE_NODE_ID", "edge-node-left")
MODEL_NAME = os.getenv("MODEL_NAME", "Qwen/Qwen2.5-0.5B-Instruct")

# Memory-related envs
MEMORY_LAYER_URL = os.getenv("MEMORY_LAYER_URL", "http://memory-layer:8090")
MEMORY_SEARCH_LIMIT = int(os.getenv("MEMORY_SEARCH_LIMIT", "5"))
LTM_CACHE_TTL_SECONDS = int(os.getenv("LTM_CACHE_TTL_SECONDS", "300"))
SESSION_TTL_SECONDS = int(
    os.getenv(
        "SESSION_TTL_SECONDS",
        os.getenv("HANDOVER_FRESHNESS_THRESHOLD_SECONDS", "120"),
    )
)
STM_TTL_SECONDS = SESSION_TTL_SECONDS
HANDOVER_FRESHNESS_THRESHOLD_SECONDS = SESSION_TTL_SECONDS

# Linear two-edge topology for the mobility simulation.
EDGE_TOPOLOGY = [
    node.strip()
    for node in os.getenv(
        "EDGE_TOPOLOGY",
        "edge-node-left,edge-node-right",
    ).split(",")
    if node.strip()
]
EDGE_NEIGHBOR_LEFT_URL = os.getenv("EDGE_NEIGHBOR_LEFT_URL")
EDGE_NEIGHBOR_RIGHT_URL = os.getenv("EDGE_NEIGHBOR_RIGHT_URL")
MIN_HANDOVER_PREFETCH_SPEED = float(os.getenv("MIN_HANDOVER_PREFETCH_SPEED", "0"))

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
OLLAMA_LLM_MODEL = os.getenv("OLLAMA_LLM_MODEL", "llama3.2:1b")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
