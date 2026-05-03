import { performance } from "node:perf_hooks";

import type { EdgeBaselineConfig } from "../config.js";
import { generateOnce, healthCheck, type GenerateCallResult } from "../http.js";
import { summarizeScenario, type ScenarioSummary } from "../metrics.js";

export async function runEdgeBaseline(config: EdgeBaselineConfig): Promise<ScenarioSummary> {
  validateConfig(config);

  for (const endpoint of config.endpoints) {
    await healthCheck(endpoint, config.requestTimeoutMs);
  }

  for (let index = 0; index < config.warmupRequests; index += 1) {
    const endpoint = config.endpoints[index % config.endpoints.length];
    await generateOnce({
      endpoint,
      userId: `${config.userPrefix}-warmup-${index}`,
      prompt: config.prompt,
      maxNewTokens: config.maxNewTokens,
      timeoutMs: config.requestTimeoutMs,
      artificialRttMs: config.artificialRttMs,
    });
  }

  const startedAt = new Date();
  const started = performance.now();
  const results = await runPool(config);
  const durationMs = performance.now() - started;
  const finishedAt = new Date();

  return summarizeScenario({
    scenario: "edge-baseline",
    startedAt,
    finishedAt,
    durationMs,
    results,
  });
}

async function runPool(config: EdgeBaselineConfig): Promise<GenerateCallResult[]> {
  const results: GenerateCallResult[] = [];
  let nextUserIndex = 0;
  const perUserRequestCount = Math.ceil(config.requests / config.userCount);

  async function worker(): Promise<void> {
    while (nextUserIndex < config.userCount) {
      const userIndex = nextUserIndex;
      nextUserIndex += 1;
      const endpoint = config.endpoints[userIndex % config.endpoints.length];

      for (let userRequestIndex = 0; userRequestIndex < perUserRequestCount; userRequestIndex += 1) {
        const requestIndex = userRequestIndex * config.userCount + userIndex;
        if (requestIndex >= config.requests) {
          continue;
        }

        const result = await generateOnce({
          endpoint,
          userId: `${config.userPrefix}-${userIndex}`,
          prompt: config.prompt,
          maxNewTokens: config.maxNewTokens,
          timeoutMs: config.requestTimeoutMs,
          artificialRttMs: config.artificialRttMs,
        });
        results[requestIndex] = {
          ...result,
          requestIndex,
          userRequestIndex,
          cachePhase: userRequestIndex === 0 ? "cold" : "hot",
        };
      }
    }
  }

  const workerCount = Math.min(config.concurrency, config.userCount);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function validateConfig(config: EdgeBaselineConfig): void {
  if (config.endpoints.length === 0) {
    throw new Error("edge-baseline requires at least one endpoint");
  }
  if (config.requests <= 0) {
    throw new Error("edge-baseline requires --requests greater than 0");
  }
  if (config.concurrency <= 0) {
    throw new Error("edge-baseline requires --concurrency greater than 0");
  }
  if (config.userCount <= 0) {
    throw new Error("edge-baseline requires --users greater than 0");
  }
  if (config.maxNewTokens <= 0) {
    throw new Error("edge-baseline requires --max-new-tokens greater than 0");
  }
}
