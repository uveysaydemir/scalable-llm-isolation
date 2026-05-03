export type EdgeBaselineConfig = {
  endpoints: string[];
  requests: number;
  concurrency: number;
  warmupRequests: number;
  maxNewTokens: number;
  userCount: number;
  userPrefix: string;
  prompt: string;
  requestTimeoutMs: number;
  artificialRttMs: number;
};

export type EdgeBaselineMatrixConfig = {
  base: Omit<EdgeBaselineConfig, "requests" | "concurrency" | "userCount" | "userPrefix"> & {
    userPrefix: string;
  };
  userCounts: number[];
  concurrencyModes: Array<"serial" | "concurrent">;
  requestsPerUser: number;
  maxConcurrentUsers: number;
  resultsDir: string;
  runLabel: string;
};

export function parseEdgeBaselineConfig(argv: string[]): EdgeBaselineConfig {
  return {
    endpoints: getStringList(argv, "endpoints", envList("EVAL_EDGE_ENDPOINTS", [
      "http://localhost:8080",
    ])),
    requests: getNumber(argv, "requests", envNumber("EVAL_REQUESTS", 9)),
    concurrency: getNumber(argv, "concurrency", envNumber("EVAL_CONCURRENCY", 1)),
    warmupRequests: getNumber(argv, "warmup", envNumber("EVAL_WARMUP_REQUESTS", 0)),
    maxNewTokens: getNumber(argv, "max-new-tokens", envNumber("EVAL_MAX_NEW_TOKENS", 8)),
    userCount: getNumber(argv, "users", envNumber("EVAL_USERS", 1)),
    userPrefix: getString(argv, "user-prefix", process.env.EVAL_USER_PREFIX ?? "eval-user"),
    prompt: getString(
      argv,
      "prompt",
      process.env.EVAL_PROMPT ?? "Give a concise one sentence answer about edge AI.",
    ),
    requestTimeoutMs: getNumber(
      argv,
      "timeout-ms",
      envNumber("EVAL_REQUEST_TIMEOUT_MS", 120_000),
    ),
    artificialRttMs: getNumber(argv, "artificial-rtt-ms", envNumber("EVAL_ARTIFICIAL_RTT_MS", 0)),
  };
}

export function parseEdgeBaselineMatrixConfig(argv: string[]): EdgeBaselineMatrixConfig {
  const base = parseEdgeBaselineConfig(withoutArg(argv, "users"));
  const userCounts = getNumberList(argv, "users", envNumberList("EVAL_USER_COUNTS", [1, 2, 3]));
  const concurrencyModes = getConcurrencyModes(argv);
  const requestsPerUser = getNumber(
      argv,
      "requests-per-user",
      envNumber("EVAL_REQUESTS_PER_USER", 3),
  );

  return {
    base: {
      endpoints: base.endpoints,
      warmupRequests: base.warmupRequests,
      maxNewTokens: base.maxNewTokens,
      userPrefix: base.userPrefix,
      prompt: base.prompt,
      requestTimeoutMs: base.requestTimeoutMs,
      artificialRttMs: base.artificialRttMs,
    },
    userCounts,
    concurrencyModes,
    requestsPerUser,
    maxConcurrentUsers: getNumber(
      argv,
      "max-concurrent-users",
      envNumber("EVAL_MAX_CONCURRENT_USERS", 2),
    ),
    resultsDir: getString(argv, "results-dir", process.env.EVAL_RESULTS_DIR ?? "results"),
    runLabel: getString(argv, "run-label", process.env.EVAL_RUN_LABEL ?? "edge-baseline-matrix"),
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function envNumberList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  return parseNumberList(raw, name);
}

function getString(argv: string[], name: string, fallback: string): string {
  const value = getArgValue(argv, name);
  return value ?? fallback;
}

function getNumber(argv: string[], name: string, fallback: number): number {
  const value = getArgValue(argv, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a finite number`);
  }
  return parsed;
}

function getStringList(argv: string[], name: string, fallback: string[]): string[] {
  const value = getArgValue(argv, name);
  if (value === undefined) {
    return fallback;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function getNumberList(argv: string[], name: string, fallback: number[]): number[] {
  const value = getArgValue(argv, name);
  if (value === undefined) {
    return fallback;
  }
  return parseNumberList(value, `--${name}`);
}

function getConcurrencyModes(argv: string[]): Array<"serial" | "concurrent"> {
  const value = getArgValue(argv, "concurrency-modes");
  const rawModes = value?.split(",") ?? ["serial", "concurrent"];
  const modes = rawModes.map((mode) => mode.trim()).filter(Boolean);

  for (const mode of modes) {
    if (mode !== "serial" && mode !== "concurrent") {
      throw new Error("--concurrency-modes can only contain serial and concurrent");
    }
  }

  return Array.from(new Set(modes)) as Array<"serial" | "concurrent">;
}

function parseNumberList(value: string, source: string): number[] {
  const numbers = value.split(",").map((item) => {
    const parsed = Number(item.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${source} must be a comma-separated list of positive integers`);
    }
    return parsed;
  });

  if (numbers.length === 0) {
    throw new Error(`${source} must not be empty`);
  }

  return numbers;
}

function getArgValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    return argv[index + 1];
  }

  return undefined;
}

function withoutArg(argv: string[], name: string): string[] {
  const result: string[] = [];
  const prefix = `--${name}=`;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      index += 1;
      continue;
    }
    if (arg.startsWith(prefix)) {
      continue;
    }
    result.push(arg);
  }

  return result;
}
