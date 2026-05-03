import { parseEdgeBaselineConfig, parseEdgeBaselineMatrixConfig } from "./config.js";
import { runEdgeBaseline } from "./scenarios/edgeBaseline.js";
import { runEdgeBaselineMatrix } from "./scenarios/edgeBaselineMatrix.js";

const args = process.argv.slice(2);
if (args[0] === "--") {
  args.shift();
}
const [scenario = "edge-baseline", ...scenarioArgs] = args;

try {
  switch (scenario) {
    case "edge-baseline": {
      const config = parseEdgeBaselineConfig(scenarioArgs);
      const summary = await runEdgeBaseline(config);
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    case "edge-baseline-matrix": {
      const config = parseEdgeBaselineMatrixConfig(scenarioArgs);
      const summary = await runEdgeBaselineMatrix(config);
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown evaluation scenario: ${scenario}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm --filter evaluation scenario:edge-baseline -- [options]
  pnpm --filter evaluation scenario:edge-baseline-matrix -- [options]
  pnpm --filter evaluation dev -- edge-baseline [options]
  pnpm --filter evaluation start -- edge-baseline [options]

Scenarios:
  edge-baseline           Measure baseline /generate latency across edge endpoints.
  edge-baseline-matrix    Run edge-baseline across user-count and concurrency combinations,
                          saving JSON results under evaluation/results by default.

edge-baseline options:
  --endpoints             Comma-separated endpoint URLs.
                          Default: http://localhost:8080
  --requests              Number of measured requests. Default: 9
  --users                 Number of logical users to cycle through. Default: 1
  --concurrency           Concurrent request workers. Default: 1
  --warmup                Warmup requests before measurement. Default: 0
  --max-new-tokens        Generation length cap. Default: 8
  --prompt                Prompt text.
  --timeout-ms            Per-request timeout. Default: 120000
  --artificial-rtt-ms     Adds half before and half after each request. Default: 0

edge-baseline-matrix options:
  --users                 Comma-separated user counts. Default: 1,2,3
  --concurrency-modes     serial,concurrent, or both. Default: serial,concurrent
  --requests-per-user     Requests per logical user in each run. Default: 3
                          The first request is cold; later requests are hot.
  --max-concurrent-users  Cap for concurrent mode. Default: 2
  --results-dir           Directory relative to evaluation/. Default: results
  --run-label             Suffix for the timestamped result directory.
  Also accepts shared edge-baseline options: --endpoints, --warmup,
  --max-new-tokens, --prompt, --timeout-ms, --artificial-rtt-ms.
`);
}
