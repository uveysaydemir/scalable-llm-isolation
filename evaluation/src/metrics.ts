import type { GenerateCallResult } from "./http.js";

export type NumericSummary = {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type ScenarioSummary = {
  scenario: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  throughputRps: number;
  latencyMs: NumericSummary;
  ttftMs: NumericSummary;
  serviceTotalMs: NumericSummary;
  inferenceMs: NumericSummary;
  inferenceExcludedMs: NumericSummary;
  coldRequests: PhaseSummary;
  hotRequests: PhaseSummary;
  componentTimingsMs: Record<string, NumericSummary>;
  byEndpoint: Record<string, {
    requestCount: number;
    successCount: number;
    errorCount: number;
    latencyMs: NumericSummary;
  }>;
  memorySources: Record<string, number>;
  handoverModes: Record<string, number>;
  errors: Array<{
    endpoint: string;
    status: number | null;
    error: string;
  }>;
};

export type PhaseSummary = {
  requestCount: number;
  successCount: number;
  errorCount: number;
  latencyMs: NumericSummary;
  serviceTotalMs: NumericSummary;
  inferenceMs: NumericSummary;
  inferenceExcludedMs: NumericSummary;
  memorySources: Record<string, number>;
};

export function summarizeScenario(params: {
  scenario: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  results: GenerateCallResult[];
}): ScenarioSummary {
  const success = params.results.filter((result) => result.ok);
  const errors = params.results.filter((result) => !result.ok);
  const byEndpoint: ScenarioSummary["byEndpoint"] = {};

  for (const result of params.results) {
    byEndpoint[result.endpoint] ??= {
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      latencyMs: summarizeNumbers([]),
    };
    byEndpoint[result.endpoint].requestCount += 1;
    if (result.ok) {
      byEndpoint[result.endpoint].successCount += 1;
    } else {
      byEndpoint[result.endpoint].errorCount += 1;
    }
  }

  for (const [endpoint, endpointSummary] of Object.entries(byEndpoint)) {
    endpointSummary.latencyMs = summarizeNumbers(
      params.results
        .filter((result) => result.endpoint === endpoint)
        .map((result) => result.latencyMs),
    );
  }

  return {
    scenario: params.scenario,
    startedAt: params.startedAt.toISOString(),
    finishedAt: params.finishedAt.toISOString(),
    durationMs: round(params.durationMs),
    requestCount: params.results.length,
    successCount: success.length,
    errorCount: errors.length,
    throughputRps: round(success.length / (params.durationMs / 1000)),
    latencyMs: summarizeNumbers(params.results.map((result) => result.latencyMs)),
    ttftMs: summarizeNumbers(
      success
        .map((result) => result.ttftMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    serviceTotalMs: summarizeNumbers(
      success
        .map((result) => result.serviceTotalMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    inferenceMs: summarizeNumbers(
      success
        .map((result) => result.inferenceMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    inferenceExcludedMs: summarizeNumbers(
      success
        .map((result) => result.inferenceExcludedMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    coldRequests: summarizePhase(params.results, "cold"),
    hotRequests: summarizePhase(params.results, "hot"),
    componentTimingsMs: summarizeComponentTimings(success),
    byEndpoint,
    memorySources: countBy(success.map((result) => result.memorySource ?? "unknown")),
    handoverModes: countBy(success.map((result) => result.handoverMode ?? "unknown")),
    errors: errors.slice(0, 10).map((result) => ({
      endpoint: result.endpoint,
      status: result.status,
      error: result.error ?? "unknown error",
    })),
  };
}

function summarizePhase(results: GenerateCallResult[], phase: "cold" | "hot"): PhaseSummary {
  const phaseResults = results.filter((result) => result.cachePhase === phase);
  const success = phaseResults.filter((result) => result.ok);

  return {
    requestCount: phaseResults.length,
    successCount: success.length,
    errorCount: phaseResults.length - success.length,
    latencyMs: summarizeNumbers(phaseResults.map((result) => result.latencyMs)),
    serviceTotalMs: summarizeNumbers(
      success
        .map((result) => result.serviceTotalMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    inferenceMs: summarizeNumbers(
      success
        .map((result) => result.inferenceMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    inferenceExcludedMs: summarizeNumbers(
      success
        .map((result) => result.inferenceExcludedMs)
        .filter((value): value is number => typeof value === "number"),
    ),
    memorySources: countBy(success.map((result) => result.memorySource ?? "unknown")),
  };
}

function summarizeComponentTimings(
  results: GenerateCallResult[],
): Record<string, NumericSummary> {
  const grouped: Record<string, number[]> = {};

  for (const result of results) {
    if (!result.timings) {
      continue;
    }

    for (const [key, value] of Object.entries(result.timings)) {
      if (typeof value !== "number") {
        continue;
      }
      grouped[key] ??= [];
      grouped[key].push(value);
    }
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([key, values]) => [key, summarizeNumbers(values)]),
  );
}

export function summarizeNumbers(values: number[]): NumericSummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(total / sorted.length),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) {
    return sorted[0];
  }
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
