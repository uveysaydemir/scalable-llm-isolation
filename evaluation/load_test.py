"""
Load test: single-node vs. multi-node edge topology.

Each virtual user sends one /generate request with a unique userId so
LTM/STM cache state never interferes between users. The only variable
is queuing pressure on the Ollama inference server.

Topologies tested:
  single  — all requests routed to edge-node-left (port 8080)
  multi   — round-robin across left (8080) and right (8083)

Concurrency levels: 1, 2, 4, 8

Metrics collected per run:
  ttft_ms      — time-to-first-token (reported by the service)
  total_ms     — end-to-end wall time measured client-side
  inference_ms — inference-only time (reported by the service)
  overhead_ms  — total_ms - inference_ms (queue wait + network)
"""

import asyncio
import json
import statistics
import time
import uuid

import httpx

NODE_URLS = [
    "http://localhost:8080",  # edge-node-left
    "http://localhost:8081",  # edge-node-2
    "http://localhost:8082",  # edge-node-3
    "http://localhost:8083",  # edge-node-right
]

PROMPT = "In one sentence, what is the capital of France?"
MAX_NEW_TOKENS = 30
REPEAT_PER_LEVEL = 3   # repeat each (topology, concurrency) combo N times and average
CONCURRENCY_LEVELS = [1, 2, 4, 8]
REQUEST_TIMEOUT = 120.0

TOPOLOGIES = {
    "single":  1,
    "multi-2": 2,
    "multi-4": 4,
}


def get_urls(topology: str, n: int) -> list[str]:
    pool_size = TOPOLOGIES[topology]
    pool = NODE_URLS[:pool_size]
    return [pool[i % pool_size] for i in range(n)]


async def single_request(client: httpx.AsyncClient, base_url: str, user_id: str) -> dict:
    payload = {
        "userId": user_id,
        "prompt": PROMPT,
        "maxNewTokens": MAX_NEW_TOKENS,
    }
    t0 = time.perf_counter()
    resp = await client.post(f"{base_url}/generate", json=payload, timeout=REQUEST_TIMEOUT)
    wall_ms = (time.perf_counter() - t0) * 1000
    resp.raise_for_status()
    data = resp.json()
    metrics = data.get("metrics", {})
    return {
        "ttft_ms": metrics.get("ttftMs"),
        "total_ms": metrics.get("totalMs"),
        "inference_ms": metrics.get("inferenceMs"),
        "wall_ms": round(wall_ms, 1),
        "node": base_url.split(":")[-1],
    }


async def run_concurrent(topology: str, concurrency: int) -> list[dict]:
    urls = get_urls(topology, concurrency)
    # unique userId per virtual user so no cache sharing
    user_ids = [f"loadtest-{uuid.uuid4().hex[:8]}" for _ in range(concurrency)]

    limits = httpx.Limits(max_connections=20, max_keepalive_connections=10)
    async with httpx.AsyncClient(limits=limits) as client:
        tasks = [
            single_request(client, url, uid)
            for url, uid in zip(urls, user_ids)
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    good = [r for r in results if isinstance(r, dict)]
    errors = [r for r in results if isinstance(r, Exception)]
    if errors:
        print(f"    WARNING: {len(errors)} request(s) failed: {errors[0]}")
    return good


def percentile(data: list[float], p: int) -> float:
    if not data:
        return float("nan")
    data_sorted = sorted(data)
    idx = max(0, int(len(data_sorted) * p / 100) - 1)
    return round(data_sorted[idx], 1)


async def bench(topology: str, concurrency: int) -> dict:
    all_results: list[dict] = []
    for rep in range(REPEAT_PER_LEVEL):
        results = await run_concurrent(topology, concurrency)
        all_results.extend(results)
        # small gap between repetitions so Ollama isn't immediately re-queued
        if rep < REPEAT_PER_LEVEL - 1:
            await asyncio.sleep(2)

    ttfts = [r["ttft_ms"] for r in all_results if r.get("ttft_ms") is not None]
    walls = [r["wall_ms"] for r in all_results]
    inferences = [r["inference_ms"] for r in all_results if r.get("inference_ms") is not None]

    n_ok = len(all_results)
    total_requests = concurrency * REPEAT_PER_LEVEL

    return {
        "topology": topology,
        "concurrency": concurrency,
        "n_ok": n_ok,
        "n_total": total_requests,
        "ttft_p50": percentile(ttfts, 50),
        "ttft_p95": percentile(ttfts, 95),
        "ttft_mean": round(statistics.mean(ttfts), 1) if ttfts else float("nan"),
        "wall_p50": percentile(walls, 50),
        "wall_p95": percentile(walls, 95),
        "wall_mean": round(statistics.mean(walls), 1),
        "inference_mean": round(statistics.mean(inferences), 1) if inferences else float("nan"),
    }


def print_table(rows: list[dict]):
    header = (
        f"{'Topology':<8} {'Concur':>7} {'TTFT P50':>9} {'TTFT P95':>9} "
        f"{'TTFT Mean':>10} {'Wall P50':>9} {'Wall P95':>9} {'Infer Mean':>11} {'OK/Total':>9}"
    )
    sep = "-" * len(header)
    print(sep)
    print(header)
    print(sep)
    for r in rows:
        print(
            f"{r['topology']:<8} {r['concurrency']:>7} "
            f"{r['ttft_p50']:>8.0f}ms {r['ttft_p95']:>8.0f}ms "
            f"{r['ttft_mean']:>9.0f}ms {r['wall_p50']:>8.0f}ms "
            f"{r['wall_p95']:>8.0f}ms {r['inference_mean']:>10.0f}ms "
            f"{r['n_ok']:>4}/{r['n_total']:<4}"
        )
    print(sep)


async def main():
    print(f"\nLoad test  —  {REPEAT_PER_LEVEL} reps per (topology × concurrency) cell")
    print(f"Prompt: \"{PROMPT}\"  |  maxNewTokens={MAX_NEW_TOKENS}\n")

    rows = []
    for topology in ("single", "multi-2", "multi-4"):
        for concurrency in CONCURRENCY_LEVELS:
            print(f"  Running topology={topology:6s}  concurrency={concurrency} ...", end=" ", flush=True)
            row = await bench(topology, concurrency)
            rows.append(row)
            print(f"done  (TTFT P50={row['ttft_p50']:.0f}ms, P95={row['ttft_p95']:.0f}ms)")
        print()

    print("\n=== RESULTS ===\n")
    print_table(rows)

    # also write JSON for report inclusion
    out_path = "evaluation/load_test_results.json"
    with open(out_path, "w") as f:
        json.dump(rows, f, indent=2)
    print(f"\nRaw results saved to {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
