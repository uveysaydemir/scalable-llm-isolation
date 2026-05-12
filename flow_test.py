#!/usr/bin/env python3
"""
End-to-end flow test.

Stages:
  1. Clean slate  — confirm user has no global LTM
  2. Message 1    — STM created, LTM fetched from memory-layer (cache miss)
  3. Message 2    — STM grows, LTM served from cache (cache hit)
  4. Message 3    — STM grows further, LTM still from cache
  5. End session  — STM exported + persisted to global LTM, session cleared
  6. Post-end     — confirm STM gone, global LTM populated
  7. New session  — fresh session, LTM cache miss → fetch from global LTM, correct memories returned
  8. Handover     — send message on left with direction=right, confirm proactive package sent to right
"""

import json
import time
import sys
import requests

LEFT  = "http://localhost:8080"
RIGHT = "http://localhost:8083"
MEM   = "http://localhost:8090"
USER  = f"flow-test-{int(time.time())}"   # unique per run

SEP   = "─" * 70

def p(title: str):
    print(f"\n{SEP}\n  {title}\n{SEP}")

def dump(label: str, data):
    print(f"\n[{label}]")
    print(json.dumps(data, indent=2))

def check(cond: bool, msg: str):
    if cond:
        print(f"  ✓  {msg}")
    else:
        print(f"  ✗  FAIL: {msg}", file=sys.stderr)

def health(base: str) -> dict:
    return requests.get(f"{base}/health").json()

def generate(base: str, prompt: str, session_id: str | None = None,
             direction: str | None = None, speed: float | None = None) -> dict:
    payload: dict = {"userId": USER, "prompt": prompt, "maxNewTokens": 32}
    if session_id:
        payload["sessionId"] = session_id
    if direction:
        payload["clientDirection"] = direction
        payload["clientSpeed"] = speed or 2.0
    return requests.post(f"{base}/generate", json=payload).json()

def global_ltm(user_id: str) -> list[str]:
    r = requests.get(f"{MEM}/memory/all", params={"userId": user_id})
    if r.status_code == 404:
        return []
    data = r.json()
    return [item["memory"] for item in data.get("results", []) if item.get("memory")]

def end_session(base: str, session_id: str) -> dict:
    return requests.post(f"{base}/session/end",
                         json={"userId": USER, "sessionId": session_id}).json()


# ─────────────────────────────────────────────────────────
p("STAGE 1 — Clean slate")
# ─────────────────────────────────────────────────────────

h = health(LEFT)
dump("left /health", h)
check(h["stm"]["activeSessions"] == 0, "no active STM sessions on left")
check(h["ltmCache"]["entryCount"] == 0, "no LTM cache entries on left")

memories_before = global_ltm(USER)
dump("global LTM before test", memories_before)
check(len(memories_before) == 0, f"user {USER} has no global LTM yet")


# ─────────────────────────────────────────────────────────
p("STAGE 2 — Message 1 (cache miss → fetch all from memory-layer)")
# ─────────────────────────────────────────────────────────

r1 = generate(LEFT, "My name is Alice and I love hiking in the mountains.")
dump("generate response", r1)
sid = r1["sessionId"]
m1 = r1.get("metrics", {})
check("sessionId" in r1, "sessionId returned")
check(m1.get("memorySource") == "memory-layer", "LTM source is memory-layer (cache miss)")
check(m1.get("stmTurns") == 0, "STM has 0 prior turns on message 1 (first ever)")

h1 = health(LEFT)
dump("left /health after msg 1", h1)
check(h1["stm"]["activeSessions"] == 1, "1 active STM session")
check(h1["ltmCache"]["entryCount"] == 1, "LTM cache entry created for user")


# ─────────────────────────────────────────────────────────
p("STAGE 3 — Message 2 (cache hit → local search)")
# ─────────────────────────────────────────────────────────

r2 = generate(LEFT, "I also enjoy rock climbing and bouldering.", session_id=sid)
dump("generate response", r2)
m2 = r2.get("metrics", {})
check(m2.get("memorySource") == "cache", "LTM source is cache (cache hit)")
check(m2.get("stmTurns") == 2, "STM has 2 turns (1 user + 1 assistant from msg 1)")

h2 = health(LEFT)
check(h2["stm"]["activeSessions"] == 1, "still 1 active session")
check(h2["ltmCache"]["entryCount"] == 1, "still 1 LTM cache entry")


# ─────────────────────────────────────────────────────────
p("STAGE 4 — Message 3 (cache still warm)")
# ─────────────────────────────────────────────────────────

r3 = generate(LEFT, "What outdoor activities would you recommend for me?", session_id=sid)
dump("generate response", r3)
m3 = r3.get("metrics", {})
check(m3.get("memorySource") == "cache", "LTM source still cache")
check(m3.get("stmTurns") == 4, "STM has 4 turns (2 exchanges)")


# ─────────────────────────────────────────────────────────
p("STAGE 5 — End session (persist STM → global LTM)")
# ─────────────────────────────────────────────────────────

end = end_session(LEFT, sid)
dump("session/end response", end)
check(end.get("ok") is True, "session end ok")
check(end.get("cleared") is True, "session cleared from STM")

h3 = health(LEFT)
check(h3["stm"]["activeSessions"] == 0, "STM has 0 sessions after end")


# ─────────────────────────────────────────────────────────
p("STAGE 6 — Post-end: global LTM populated (async, Ollama 3b on CPU)")
# ─────────────────────────────────────────────────────────

# Per-turn and session-end background persist tasks use Ollama llama3.2:3b for
# fact extraction. On CPU hardware this takes 60-120s per call and multiple
# tasks may be queued. We poll up to 5 minutes rather than blocking the test.
print("  polling global LTM (up to 300s — llama3.2:3b on CPU is slow)...")
deadline = time.time() + 300
memories_after = []
while time.time() < deadline:
    memories_after = global_ltm(USER)
    if memories_after:
        elapsed = int(300 - (deadline - time.time()))
        print(f"  → populated after ~{elapsed}s")
        break
    time.sleep(10)
    print(f"  → still waiting... ({int(deadline - time.time())}s left)")

dump("global LTM after session end", memories_after)
check(len(memories_after) > 0, f"global LTM has {len(memories_after)} entries persisted")

# Invalidate cache so next session triggers a fresh fetch
requests.post(f"{LEFT}/memory/cache/invalidate", json={"userId": USER})
h4 = health(LEFT)
check(h4["ltmCache"]["entryCount"] == 0, "LTM cache cleared for fresh fetch test")

if not memories_after:
    print("\n  ⚠  Skipping stages 7–8 global-LTM checks: persist timed out (hardware limit)")
    print("  ⚠  Run: curl 'http://localhost:8090/memory/all?userId=" + USER + "' to verify later")


# ─────────────────────────────────────────────────────────
p("STAGE 7 — New session: LTM cache miss → memories retrieved from global")
# ─────────────────────────────────────────────────────────

r4 = generate(LEFT, "Do you remember what I told you about myself?")
dump("generate response (new session)", r4)
sid2 = r4["sessionId"]
check(sid2 != sid, "new sessionId issued")
m4 = r4.get("metrics", {})
check(m4.get("memorySource") == "memory-layer", "LTM fetched fresh from memory-layer")
check(m4.get("stmTurns") == 0, "new session has 0 prior turns")

h5 = health(LEFT)
check(h5["ltmCache"]["entryCount"] == 1, "LTM cache re-populated after new session fetch")
check(h5["stm"]["activeSessions"] == 1, "1 active STM session for new session")
if memories_after:
    check(m4.get("memoryCount", 0) > 0, f"new session prompt included {m4.get('memoryCount',0)} LTM memories")

# Check that the LTM snapshot on the edge includes the persisted memories
ltm_debug = requests.get(f"{LEFT}/memory/cache/snapshot", params={"userId": USER})
if ltm_debug.status_code == 200:
    snap = ltm_debug.json()
    dump("LTM cache snapshot on left edge", snap)
    check(snap.get("present") is True, "LTM snapshot present")
    check(len(snap.get("memories", [])) > 0, f"cached {len(snap.get('memories',[]))} memories on edge")
else:
    print(f"  (no /memory/cache/snapshot endpoint, skipping snapshot check)")


# ─────────────────────────────────────────────────────────
p("STAGE 8 — Proactive handover (left → right)")
# ─────────────────────────────────────────────────────────

r5 = generate(LEFT, "I'm heading right.", session_id=sid2, direction="right", speed=3.0)
dump("generate response (with direction=right)", r5)
m5 = r5.get("metrics", {})
check(m5.get("proactiveHandover", {}).get("scheduled") is True, "proactive handover triggered")

time.sleep(2)  # let background push arrive

h_right = health(RIGHT)
dump("right /health after proactive push", h_right)
check(h_right["stm"]["activeSessions"] >= 1, "right edge has STM session after proactive push")
check(h_right["ltmCache"]["entryCount"] >= 1, "right edge has LTM cache after proactive push")

# Continue conversation on right (should use transferred STM, LTM from cache)
r6 = generate(RIGHT, "What did I tell you about myself?", session_id=sid2)
dump("generate response on RIGHT edge", r6)
m6 = r6.get("metrics", {})
check(m6.get("handover", {}).get("mode") == "local_session", "right edge serves session locally (no recovery needed)")
check(m6.get("memorySource") == "cache", "right edge LTM from cache (transferred in handover package)")
check(m6.get("stmTurns", 0) >= 2, "right edge has multiple STM turns (history transferred)")


# ─────────────────────────────────────────────────────────
p("SUMMARY")
# ─────────────────────────────────────────────────────────
print(f"""
  User ID  : {USER}
  Session 1: {sid}
  Session 2: {sid2}

  Global LTM entries persisted after session end: {len(memories_after)}
  Global LTM samples:
""")
for m in memories_after[:5]:
    print(f"    • {m}")
print()
