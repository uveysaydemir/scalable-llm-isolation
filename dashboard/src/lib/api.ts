export type HealthResponse = {
  ok: boolean;
  service?: string;
  nodeId?: string;
  memoryLayerUrl?: string;
};

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

//Two initial endpoints for testing.
export const API = {
  edgeHealth: () => fetchJson<HealthResponse>("http://localhost:8080/health"),
  memoryHealth: () => fetchJson<HealthResponse>("http://localhost:8090/health"),
};
