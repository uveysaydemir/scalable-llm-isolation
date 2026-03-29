import os

EDGE_PORT = int(os.getenv("EDGE_PORT", "8080"))
MODEL_NAME = os.getenv("MODEL_NAME", "distilgpt2")

# Memory-related envs
MEMORY_SEARCH_LIMIT = int(os.getenv("MEMORY_SEARCH_LIMIT", "5"))
LTM_CACHE_TTL_SECONDS = int(os.getenv("LTM_CACHE_TTL_SECONDS", "300"))
STM_TTL_SECONDS = int(os.getenv("STM_TTL_SECONDS", "1800"))

# Global memory-layer URL
MEMORY_LAYER_URL = os.getenv("MEMORY_LAYER_URL", "http://memory-layer:8090")
