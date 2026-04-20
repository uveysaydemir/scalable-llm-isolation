import os

EDGE_PORT = int(os.getenv("EDGE_PORT", "8080"))
EDGE_NODE_ID = os.getenv("EDGE_NODE_ID", "edge-node-1")
MODEL_NAME = os.getenv("MODEL_NAME", "distilgpt2")

# Memory-related envs
MEMORY_SEARCH_LIMIT = int(os.getenv("MEMORY_SEARCH_LIMIT", "5"))
LTM_CACHE_TTL_SECONDS = int(os.getenv("LTM_CACHE_TTL_SECONDS", "300"))
SESSION_TTL_SECONDS = int(
    os.getenv(
        "SESSION_TTL_SECONDS",
        os.getenv("HANDOVER_FRESHNESS_THRESHOLD_SECONDS", "120"),
    )
)
HANDOVER_FRESHNESS_THRESHOLD_SECONDS = SESSION_TTL_SECONDS

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
OLLAMA_LLM_MODEL = os.getenv("OLLAMA_LLM_MODEL", "llama3.2:1b")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
