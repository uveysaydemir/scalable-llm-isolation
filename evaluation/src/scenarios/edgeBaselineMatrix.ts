import path from "node:path";

import type { EdgeBaselineConfig, EdgeBaselineMatrixConfig } from "../config.js";
import { createResultRunDir, writeJsonFile } from "../results.js";
import { runEdgeBaseline } from "./edgeBaseline.js";

export type MatrixRunSummary = {
  runName: string;
  userCount: number;
  concurrencyMode: "serial" | "concurrent";
  requests: number;
  concurrency: number;
  outputFile: string;
  successCount: number;
  errorCount: number;
  throughputRps: number;
  latencyMeanMs: number | null;
  latencyP95Ms: number | null;
  serviceTotalMeanMs: number | null;
  inferenceMeanMs: number | null;
  inferenceExcludedMeanMs: number | null;
  coldLatencyMeanMs: number | null;
  hotLatencyMeanMs: number | null;
  hotInferenceExcludedMeanMs: number | null;
};

export type MatrixSummary = {
  scenario: "edge-baseline-matrix";
  startedAt: string;
  finishedAt: string;
  outputDir: string;
  config: EdgeBaselineMatrixConfig;
  runs: MatrixRunSummary[];
};

export async function runEdgeBaselineMatrix(
  config: EdgeBaselineMatrixConfig,
): Promise<MatrixSummary> {
  validateMatrixConfig(config);

  const startedAt = new Date();
  const outputDir = await createResultRunDir(config.resultsDir, config.runLabel);
  const runs: MatrixRunSummary[] = [];

  await writeJsonFile(path.join(outputDir, "config.json"), config);

  for (const userCount of config.userCounts) {
    for (const concurrencyMode of config.concurrencyModes) {
      const runName = `${userCount}-users-${concurrencyMode}`;
      const runConfig = buildRunConfig(config, userCount, concurrencyMode);

      console.error(
        `Running ${runName}: requests=${runConfig.requests}, concurrency=${runConfig.concurrency}`,
      );

      const summary = await runEdgeBaseline(runConfig);
      const outputFile = `${runName}.json`;
      await writeJsonFile(path.join(outputDir, outputFile), {
        runName,
        userCount,
        concurrencyMode,
        config: runConfig,
        summary,
      });

      runs.push({
        runName,
        userCount,
        concurrencyMode,
        requests: runConfig.requests,
        concurrency: runConfig.concurrency,
        outputFile,
        successCount: summary.successCount,
        errorCount: summary.errorCount,
        throughputRps: summary.throughputRps,
        latencyMeanMs: summary.latencyMs.mean,
        latencyP95Ms: summary.latencyMs.p95,
        serviceTotalMeanMs: summary.serviceTotalMs.mean,
        inferenceMeanMs: summary.inferenceMs.mean,
        inferenceExcludedMeanMs: summary.inferenceExcludedMs.mean,
        coldLatencyMeanMs: summary.coldRequests.latencyMs.mean,
        hotLatencyMeanMs: summary.hotRequests.latencyMs.mean,
        hotInferenceExcludedMeanMs: summary.hotRequests.inferenceExcludedMs.mean,
      });
    }
  }

  const matrixSummary: MatrixSummary = {
    scenario: "edge-baseline-matrix",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    outputDir,
    config,
    runs,
  };

  await writeJsonFile(path.join(outputDir, "summary.json"), matrixSummary);
  return matrixSummary;
}

function buildRunConfig(
  config: EdgeBaselineMatrixConfig,
  userCount: number,
  concurrencyMode: "serial" | "concurrent",
): EdgeBaselineConfig {
  const requests = userCount * config.requestsPerUser;
  const concurrency = concurrencyMode === "serial"
    ? 1
    : Math.min(userCount, config.maxConcurrentUsers);

  return {
    ...config.base,
    userPrefix: `${config.base.userPrefix}-${userCount}u-${concurrencyMode}`,
    userCount,
    requests,
    concurrency,
  };
}

function validateMatrixConfig(config: EdgeBaselineMatrixConfig): void {
  if (config.base.endpoints.length !== 1) {
    throw new Error("edge-baseline-matrix is scoped to a single edge endpoint");
  }
  if (config.userCounts.length === 0) {
    throw new Error("edge-baseline-matrix requires at least one user count");
  }
  if (config.concurrencyModes.length === 0) {
    throw new Error("edge-baseline-matrix requires at least one concurrency mode");
  }
  if (config.requestsPerUser <= 0) {
    throw new Error("edge-baseline-matrix requires --requests-per-user greater than 0");
  }
  if (config.maxConcurrentUsers <= 0) {
    throw new Error("edge-baseline-matrix requires --max-concurrent-users greater than 0");
  }
}
