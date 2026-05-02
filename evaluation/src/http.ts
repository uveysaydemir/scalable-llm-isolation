import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

export type GenerateResponse = {
  ok: boolean;
  userId: string;
  sessionId: string;
  output: string;
  metrics?: {
    ttftMs?: number | null;
    totalMs?: number;
    inferenceMs?: number;
    inferenceExcludedMs?: number | null;
    timings?: Record<string, number | null>;
    memoryCount?: number;
    memorySource?: string;
    edgeNodeId?: string;
    handover?: {
      mode?: string;
      reason?: string;
    };
    [key: string]: unknown;
  };
};

export type GenerateCallResult = {
  endpoint: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  userId: string;
  requestIndex?: number;
  userRequestIndex?: number;
  cachePhase?: "cold" | "hot";
  sessionId?: string;
  edgeNodeId?: string;
  ttftMs?: number | null;
  serviceTotalMs?: number;
  inferenceMs?: number;
  inferenceExcludedMs?: number | null;
  timings?: Record<string, number | null>;
  memorySource?: string;
  handoverMode?: string;
  error?: string;
};

export async function healthCheck(endpoint: string, timeoutMs: number): Promise<void> {
  const response = await fetchWithTimeout(`${endpoint}/health`, {
    method: "GET",
    timeoutMs,
  });
  if (!response.ok) {
    throw new Error(`${endpoint}/health returned ${response.status}`);
  }
}

export async function generateOnce(params: {
  endpoint: string;
  userId: string;
  prompt: string;
  maxNewTokens: number;
  timeoutMs: number;
  artificialRttMs: number;
}): Promise<GenerateCallResult> {
  const started = performance.now();

  try {
    await sleepHalfRtt(params.artificialRttMs);
    const response = await fetchWithTimeout(`${params.endpoint}/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userId: params.userId,
        prompt: params.prompt,
        maxNewTokens: params.maxNewTokens,
      }),
      timeoutMs: params.timeoutMs,
    });
    await sleepHalfRtt(params.artificialRttMs);

    const latencyMs = roundMs(performance.now() - started);
    const text = await response.text();

    if (!response.ok) {
      return {
        endpoint: params.endpoint,
        ok: false,
        status: response.status,
        latencyMs,
        userId: params.userId,
        error: text,
      };
    }

    const payload = JSON.parse(text) as GenerateResponse;
    return {
      endpoint: params.endpoint,
      ok: payload.ok,
      status: response.status,
      latencyMs,
      userId: payload.userId,
      sessionId: payload.sessionId,
      edgeNodeId: payload.metrics?.edgeNodeId,
      ttftMs: payload.metrics?.ttftMs,
      serviceTotalMs: payload.metrics?.totalMs,
      inferenceMs: payload.metrics?.inferenceMs,
      inferenceExcludedMs: payload.metrics?.inferenceExcludedMs,
      timings: payload.metrics?.timings,
      memorySource: payload.metrics?.memorySource,
      handoverMode: payload.metrics?.handover?.mode,
    };
  } catch (error) {
    return {
      endpoint: params.endpoint,
      ok: false,
      status: null,
      latencyMs: roundMs(performance.now() - started),
      userId: params.userId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function sleepHalfRtt(artificialRttMs: number): Promise<void> {
  if (artificialRttMs <= 0) {
    return;
  }
  await sleep(artificialRttMs / 2);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
