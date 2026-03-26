import os

EDGE_PORT = int(os.getenv("EDGE_PORT", "8080"))
MODEL_NAME = os.getenv("MODEL_NAME", "distilgpt2")

# Memory-related envs
MEMORY_SEARCH_LIMIT = int(os.getenv("MEMORY_SEARCH_LIMIT", "5"))
QDRANT_HOST = os.getenv("QDRANT_HOST", "qdrant")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", "6333"))
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION", "edge_memory")
LTM_CACHE_TTL_SECONDS = int(os.getenv("LTM_CACHE_TTL_SECONDS", "300"))

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
OLLAMA_LLM_MODEL = os.getenv("OLLAMA_LLM_MODEL", "llama3.2:1b")
OLLAMA_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")