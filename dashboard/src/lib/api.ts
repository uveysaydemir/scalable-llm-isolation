export type EdgeKey = "left" | "right";

export type HealthResponse = {
  ok: boolean;
  service?: string;
  edgeNodeId?: string;
  modelName?: string;
  ltmCache?: {
    ttlSeconds: number;
    entryCount: number;
  };
  localSessionRegistry?: {
    ttlSeconds: number;
    entryCount: number;
  };
  stm?: {
    activeSessions: number;
  };
  handover?: {
    topology: string[];
    leftNeighborUrl: string | null;
    rightNeighborUrl: string | null;
    minPrefetchSpeed: number;
  };
};

export type GenerateResponse = {
  ok: boolean;
  userId: string;
  sessionId: string;
  output: string;
  metrics: {
    totalMs?: number;
    inferenceMs?: number;
    inferenceExcludedMs?: number | null;
    memorySource?: string;
    edgeNodeId?: string;
    handover?: {
      mode?: string;
      reason?: string;
    };
    proactiveHandover?: {
      scheduled?: boolean;
      targetEdgeId?: string;
      targetUrl?: string;
      reason?: string;
      ltmCount?: number;
      stmIncluded?: boolean;
    };
    neighborRecovery?: {
      attempted?: boolean;
      recovered?: boolean;
      sourceEdgeId?: string;
      sourceUrl?: string;
      stmImported?: boolean;
      ltmCount?: number;
      error?: string;
    };
    timings?: Record<string, number | null>;
  };
};

export type HandoverExportResponse = {
  ok: boolean;
  package: {
    userId: string;
    sessionId: string;
    sourceEdgeId: string;
    targetEdgeId: string;
    stm: null | {
      messages?: Array<{ role: string; content: string }>;
      [key: string]: unknown;
    };
    ltm: string[];
  };
};

export type HandoverImportResponse = {
  ok: boolean;
  edgeNodeId: string;
  stmImported: boolean;
  ltmCount: number;
};

export type GenerateRequest = {
  userId: string;
  sessionId?: string;
  lastMessageTimestamp?: string;
  clientDirection?: "left" | "right";
  clientSpeed?: number;
  prompt: string;
  maxNewTokens?: number;
};

const edgeBasePath: Record<EdgeKey, string> = {
  left: "/api/left",
  right: "/api/right",
};

export async function fetchEdgeHealth(edge: EdgeKey): Promise<HealthResponse> {
  return fetchJson<HealthResponse>(`${edgeBasePath[edge]}/health`);
}

export async function generate(edge: EdgeKey, payload: GenerateRequest): Promise<GenerateResponse> {
  return fetchJson<GenerateResponse>(`${edgeBasePath[edge]}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function exportHandoverPackage(
  edge: EdgeKey,
  payload: { userId: string; sessionId: string; targetEdgeId: string },
): Promise<HandoverExportResponse> {
  return fetchJson<HandoverExportResponse>(`${edgeBasePath[edge]}/handover/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function importHandoverPackage(
  edge: EdgeKey,
  payload: HandoverExportResponse["package"],
): Promise<HandoverImportResponse> {
  return fetchJson<HandoverImportResponse>(`${edgeBasePath[edge]}/handover/package`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `Request failed: ${res.status} ${res.statusText}`);
  }
  return JSON.parse(text) as T;
}
