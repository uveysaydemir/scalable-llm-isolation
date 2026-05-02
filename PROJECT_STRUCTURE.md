# Project Structure

This repository implements a context-privacy aware edge LLM system with distributed memory. The active runtime is built around two Python FastAPI services:

- `edge-node`: serves user requests, runs local LLM inference, keeps short-term memory on the current edge, and coordinates handover.
- `memory-layer`: provides global long-term memory through Mem0, Qdrant, and Ollama.

The repository also contains scaffolded workspaces for a dashboard and simulator, plus an evaluation workspace with an initial edge-baseline benchmark.

## Runtime Architecture

```text
Client
  |
  | POST /generate
  v
Edge Node
  |-- local STM store: active session conversation history
  |-- local LTM cache: short-lived cache of retrieved user memories
  |-- local model inference: Hugging Face Transformers
  |
  | memory search/add
  v
Memory Layer
  |-- Mem0 middleware
  |-- Qdrant vector store
  |-- Ollama LLM and embedding models
```

In the Docker Compose setup, two edge nodes are deployed by default:

- `edge-node-left` on host port `8080`
- `edge-node-right` on host port `8083`

All edge nodes talk to the shared `memory-layer` on host port `8090`. The memory layer persists vector memory in Qdrant on port `6333` and uses Ollama on port `11434`.

## Top-Level Directories

### `edge-node/`

The edge inference service. This is the main request-serving component.

Important files:

- `app/main.py`: FastAPI application, endpoint definitions, model inference, memory retrieval, STM updates, background memory persistence, and handover orchestration.
- `app/handover.py`: pure handover decision logic, timestamp parsing, local session registry, topology neighbor estimation, and movement direction helpers.
- `app/schemas.py`: Pydantic request and response models for generation, memory debugging, handover, and session ending.
- `app/config.py`: environment-driven edge configuration, model names, memory-layer URL, TTLs, topology, and neighbor URLs.
- `app/memory_client.py`: HTTP client used by the edge node to call `memory-layer`.
- `app/prompt_builder.py`: constructs chat messages from system instructions, long-term memories, STM history, and the current user prompt.
- `app/memory/stm_store.py`: in-process short-term memory store for active sessions.
- `app/memory/cache.py`: per-user long-term memory cache with TTL.
- `app/logging_utils.py`: structured event logging helper.
- `tests/test_handover.py`: unit tests for handover decisions, timestamp normalization, and neighbor estimation.
- `tests/test_prompt_builder.py`: unit tests for message and prompt construction.
- `Dockerfile`: production container for the edge service.
- `Dockerfile.handover-test`: test container used by the Compose `handover-tests` profile.
- `README.md`: brief service-specific run notes.

The edge node is responsible for:

1. Accepting `POST /generate` requests.
2. Deciding whether the request belongs to a local, neighbor-recovered, or globally recovered session.
3. Reading STM from local process memory.
4. Retrieving LTM from the local cache or global memory layer.
5. Building the model prompt.
6. Running local LLM generation through `transformers`.
7. Appending the user and assistant messages to STM.
8. Persisting the turn to global memory asynchronously.
9. Sending or importing handover packages when mobility is detected.

### `memory-layer/`

The global long-term memory service.

Important files:

- `app/main.py`: FastAPI service exposing health, memory search, and memory add endpoints.
- `app/mem0_service.py`: Mem0 wrapper configured with Qdrant, Ollama LLM, and Ollama embedder.
- `app/config.py`: memory-layer environment configuration.
- `requirements.txt`: Python dependencies for FastAPI, Mem0, Qdrant, Ollama, and Pydantic.
- `Dockerfile`: production container for the memory service.
- `src/index.ts` and `tsconfig.json`: TypeScript workspace scaffold; not part of the active Python runtime.

The memory layer is responsible for:

1. Receiving normalized memory add/search requests from edge nodes.
2. Storing user-specific memories through Mem0.
3. Searching relevant memories by `userId` and query text.
4. Using Qdrant as the vector database.
5. Using Ollama for Mem0 LLM and embedding operations.

### `dashboard/`

A Vite/React scaffold for visualization. The current `src/App.tsx` renders a placeholder `Dashboard` view, and `src/lib/api.ts` is available for API integration.

### `simulator/`

A TypeScript workspace intended for simulation of latency, mobility, and failure scenarios. The current `index.ts` is empty, so this is scaffolded rather than implemented.

### `evaluation/`

A TypeScript workspace for benchmark scripts and metric collection.

Current implemented scenario:

- `edge-baseline`: sends `/generate` traffic to a single configured edge endpoint and reports request latency, service-reported TTFT, service-reported total time, throughput, memory source counts, handover mode counts, and errors.
- `edge-baseline` also reports `inferenceMs` and `inferenceExcludedMs`. The second value subtracts local model generation time from service total time, which helps isolate edge-system overhead from slow laptop CPU inference.
- `edge-baseline` labels the first request per user as `cold` and later requests from the same user as `hot`, so the result summary includes mean hot-request latency and mean hot-request inference-excluded latency.
- `edge-baseline-matrix`: runs `edge-baseline` against one edge across multiple user-count and concurrency combinations, then saves all outputs under `evaluation/results`.

Run the default single-edge baseline with:

```bash
pnpm --filter evaluation scenario:edge-baseline
```

Useful options:

```bash
pnpm --filter evaluation scenario:edge-baseline -- \
  --requests 30 \
  --concurrency 3 \
  --warmup 3 \
  --max-new-tokens 8 \
  --endpoints http://localhost:8080
```

The evaluator also supports `--artificial-rtt-ms`. This is currently optional for edge tests, but it will be reused for the planned single-cloud baseline.

Run the default laptop-safe matrix with:

```bash
pnpm --filter evaluation scenario:edge-baseline-matrix
```

Default matrix:

- users: `1`, `2`, `3`
- concurrency modes: `serial`, `concurrent`
- requests per user: `3`, where request `0` is cold and requests `1..n` are hot
- concurrent mode cap: `2`

This is intentionally a laptop-scale profile. The local machine has much less memory and no edge-grade accelerator, so it should not use the same concurrent-user counts as a real edge server.

Why these local user counts were chosen:

- `1` user measures the minimum baseline with no meaningful contention.
- `2` users measures light concurrent pressure on one edge while preserving per-user request order.
- `3` users adds more local contention on one edge without mixing in topology or handover effects.
- `5` users was tested as an upper local stress point, but it produced partial or complete failures on this laptop because local CPU inference and local Mem0/Ollama memory retrieval dominated the result. It is therefore excluded from the default matrix.
- Concurrent mode is capped at `2` because the local machine has about `11.4 GB` available RAM and no edge-grade GPU. Higher local concurrency mostly measures laptop resource exhaustion rather than realistic edge-system behavior.

For a real edge server, the evaluation target would be larger. A modest production edge node may have `64-256 GB` RAM plus an accelerator, while stronger rugged/near-edge servers may have more. Those larger scenarios should be represented later through a cloud/edge simulation profile or a dedicated server run, not by overloading the local laptop.

This produces a timestamped directory under `evaluation/results` with:

- `config.json`: the matrix configuration.
- one JSON file per parameter combination.
- `summary.json`: compact cross-run comparison.

Example custom matrix:

```bash
pnpm --filter evaluation scenario:edge-baseline-matrix -- \
  --users 1,2,3 \
  --concurrency-modes serial,concurrent \
  --requests-per-user 3 \
  --max-concurrent-users 2 \
  --max-new-tokens 8
```

## Docker Compose Services

`docker-compose.yml` wires the local stack together:

- `qdrant`: vector database used by Mem0.
- `ollama`: local model server for memory-layer LLM and embedding operations.
- `ollama-init`: pulls the configured Ollama LLM and embedding models before the memory layer starts.
- `memory-layer`: global memory API.
- `edge-node-left`: first edge server.
- `edge-node-right`: right edge server.
- `handover-tests`: optional test profile for edge handover unit tests.

Run the full stack with:

```bash
docker compose up --build
```

Run the handover tests through Compose with:

```bash
docker compose --profile test up --build handover-tests
```

## Edge Node API Surface

### `GET /health`

Returns service health, edge identity, model name, LTM cache stats, local session registry stats, STM stats, topology, and neighbor configuration.

### `POST /generate`

Main inference endpoint. Request fields are defined by `GenerateRequest`:

- `userId`: user identifier.
- `sessionId`: optional existing session identifier. A new UUID is created if omitted.
- `lastMessageTimestamp`: optional client timestamp used for handover classification.
- `clientDirection`: optional `left` or `right` mobility hint.
- `clientSpeed`: optional mobility speed used for proactive handover thresholding.
- `prompt`: user prompt.
- `maxNewTokens`: optional generation token limit.

The response includes generated output and metrics such as TTFT, total latency, memory source, edge ID, handover decision, neighbor recovery status, proactive handover status, and STM turn count.

### Memory Debug Endpoints

- `POST /memory/search`: searches long-term memory through the memory layer.
- `POST /memory/add`: manually adds a user/assistant turn to long-term memory.
- `POST /memory/cache/invalidate`: clears a user's edge-local LTM cache entry.

### Handover Endpoints

- `POST /handover/decision`: returns the handover classification for a request.
- `POST /handover/package`: imports STM and cached LTM from another edge.
- `POST /handover/export`: exports a session package for reactive neighbor recovery.

### Session Endpoint

- `POST /session/end`: removes a session from local STM.

## Memory Model

### Short-Term Memory

Short-term memory is local to each edge-node process and lives in `STMStore`.

Properties:

- Keyed by `sessionId`.
- Guarded by `userId` to reduce cross-user leakage risk.
- Stores ordered user and assistant messages.
- Exportable and importable for handover.
- Expires after `SESSION_TTL_SECONDS` / `STM_TTL_SECONDS`.
- Expired sessions are flushed to the memory layer by a background loop.

### Long-Term Memory

Long-term memory is global and user-specific.

Properties:

- Stored by Mem0.
- Persisted in Qdrant.
- Queried by the edge node before inference.
- Cached per user on the edge node by `LTMCache`.
- Cache TTL defaults to `300` seconds.
- Existing user cache entries are refreshed when that user continues an active local session, so the edge does not drop LTM cache while the session is still active.
- New turns are persisted asynchronously after generation.

Important client behavior:

- To benefit from STM and refreshed LTM cache, a client must reuse the returned `sessionId` on later `/generate` requests.
- Requests without `sessionId` are treated as new sessions, so they may trigger cold LTM lookups for new users.

## Handover Model

Handover is timestamp-based and implemented in `edge-node/app/handover.py` plus orchestration in `edge-node/app/main.py`.

The system classifies requests into three modes:

- `local_session`: the current edge already has the session, or there is not enough handover signal.
- `neighbor_recovery`: the session is missing locally, but the last message is recent enough to try fetching STM from the previous neighboring edge.
- `global_recovery`: the session is missing locally and stale, so the edge falls back to global memory rather than neighbor STM recovery.

The freshness boundary is controlled by:

```text
HANDOVER_FRESHNESS_THRESHOLD_SECONDS
```

This is currently tied to `SESSION_TTL_SECONDS`.

### Reactive Neighbor Recovery

When a request arrives at an edge without local STM but with a recent timestamp:

1. The edge classifies the request as `neighbor_recovery`.
2. It estimates the source edge as the opposite of `clientDirection`.
3. It calls the source edge's `POST /handover/export`.
4. If the source has the STM session, the current edge imports it through the handover package.
5. Generation continues with recovered STM.

### Proactive Handover

After successful generation, if the client provides direction and speed:

1. The edge estimates the target neighbor from `clientDirection`.
2. It checks `MIN_HANDOVER_PREFETCH_SPEED`.
3. If eligible, it builds a handover package with STM and retrieved LTM.
4. It sends the package to the target edge in a background task.

## Prompt Construction

Prompt construction happens in `edge-node/app/prompt_builder.py`.

The model input includes:

1. A base system message.
2. A system memory block containing relevant long-term memories.
3. Short-term session history from STM.
4. The current user prompt.

If the tokenizer has a chat template, `tokenizer.apply_chat_template` is used. Otherwise the service falls back to a plain text prompt format.

## Important Environment Variables

### Edge Node

- `EDGE_NODE_ID`: identity of the current edge.
- `MODEL_NAME`: Hugging Face model used for edge inference.
- `MEMORY_LAYER_URL`: URL of the memory-layer service.
- `MEMORY_SEARCH_LIMIT`: number of memories retrieved per request.
- `LTM_CACHE_TTL_SECONDS`: edge-local LTM cache TTL.
- `SESSION_TTL_SECONDS`: STM and handover freshness TTL.
- `HANDOVER_FRESHNESS_THRESHOLD_SECONDS`: fallback source for session TTL.
- `EDGE_TOPOLOGY`: comma-separated ordered edge IDs.
- `EDGE_NEIGHBOR_LEFT_URL`: URL for the left neighbor.
- `EDGE_NEIGHBOR_RIGHT_URL`: URL for the right neighbor.
- `MIN_HANDOVER_PREFETCH_SPEED`: minimum speed required for proactive handover.

### Memory Layer

- `MEMORY_PORT`: memory service port.
- `QDRANT_HOST`: Qdrant host.
- `QDRANT_PORT`: Qdrant port.
- `QDRANT_COLLECTION`: Qdrant collection name.
- `OLLAMA_BASE_URL`: Ollama API URL.
- `OLLAMA_LLM_MODEL`: Ollama model used by Mem0.
- `OLLAMA_EMBED_MODEL`: Ollama embedding model used by Mem0.

## Testing

Current tests are focused on pure edge-node logic:

- Handover mode selection.
- Handover package export/import, target validation, and user/session mismatch rejection.
- STM creation, user isolation, export/import, expiry detection, and cleanup.
- LTM cache hit, expiry, invalidation, and clear behavior.
- Edge-to-memory client payloads and Mem0-style result parsing.
- Timestamp parsing and browser epoch millisecond normalization.
- Linear topology neighbor estimation.
- Prompt/message construction.

Run locally from `edge-node/` with:

```bash
python -m unittest discover -s tests
```

Or use the Docker Compose test profile:

```bash
docker compose --profile test up --build handover-tests
```

## Evaluation Plan

The evaluation track is being built around five main questions:

1. How fast is the multi-edge system without mobility or congestion?
2. How does latency degrade under congestion?
3. How well does handover preserve STM when users move between edges?
4. How much does the memory layer and LTM cache affect latency?
5. How does the edge design compare to a single centralized cloud-style LLM service?

The first implemented scenario is `edge-baseline`. It measures the single-edge baseline before adding congestion, mobility, or topology effects, which gives later scenarios a stable comparison point. The `edge-baseline-matrix` scenario repeats that baseline across user-count and concurrency combinations, and separates cold first requests from hot cache-eligible follow-up requests.

Local evaluation uses scaled-down user counts because this development machine is not representative of a production edge server. For local runs, prefer `1`, `2`, and `3` logical users with concurrent mode capped at `2`. Real edge-server scenarios can be modeled later with larger synthetic counts and artificial/cloud baselines rather than running all inference locally.

Because local inference can dominate latency on a laptop, `/generate` returns component timings:

- `handoverDecisionMs`
- `neighborRecoveryMs`
- `stmReadMs`
- `memoryRetrievalMs`
- `promptBuildMs`
- `tokenizationMs`
- `inferenceMs`
- `inferenceTtftMs`
- `postInferenceMs`
- `inferenceExcludedMs`

Future congestion tests should compare both total latency and `inferenceExcludedMs`. Total latency captures user-visible delay, while `inferenceExcludedMs` better reflects queueing, memory lookup, handover, and edge coordination overhead.

Planned cloud baseline:

- Add a `cloud-node` service later using the same edge-node image and inference path, but configured as a centralized endpoint with no neighbors.
- Route all synthetic users to that one endpoint.
- Add configurable artificial RTT in the evaluator using `--artificial-rtt-ms`.
- Use the same prompt, output-token cap, request count, and concurrency settings as the edge scenarios.

Why configurable cloud RTT is needed:

- Public LLM latency benchmarks show normal TTFT often in the hundreds of milliseconds, with large variation by provider and model.
- Under load, queueing can push tail latency into multi-second territory.
- Because provider latency varies by region, prompt size, model, queue depth, and streaming behavior, the evaluator should not hard-code one cloud number.

Useful cloud-delay presets for later experiments:

- `--artificial-rtt-ms 80`: nearby regional cloud.
- `--artificial-rtt-ms 150`: common cross-region or moderately distant cloud.
- `--artificial-rtt-ms 300`: distant cloud or congested network path.

Research references used for these assumptions:

- DeployBase, "LLM API Latency Comparison: Time-to-First-Token Analysis", reports provider TTFT p50/p95 ranges across major LLM APIs.
- LLM Benchmarks, OpenAI provider benchmark page, reports average OpenAI time to first token and token throughput measurements.
- SitePoint, "Ollama vs vLLM: Performance Benchmark 2026", shows queueing-driven latency growth under concurrent load.
- Together AI, "Cache-aware prefill-decode disaggregation", discusses TTFT rising sharply as QPS approaches saturation.

## Current Implementation Status

Implemented:

- Edge inference API.
- Long-term memory integration through a memory-layer service.
- Edge-local STM.
- Edge-local LTM cache.
- Timestamp-based handover decision logic.
- Reactive neighbor STM recovery.
- Proactive handover prefetch.
- Background persistence of generated turns.
- Unit tests for handover and prompt construction.
- Three-edge Docker Compose topology: left, middle, and right.
- Evaluation CLI with the initial `edge-baseline` scenario.

Scaffolded or minimal:

- Dashboard UI.
- Simulator.
- Congestion, handover, memory-cache, failure, and cloud-baseline evaluation scenarios.
- TypeScript entrypoints in `memory-layer/src`.
