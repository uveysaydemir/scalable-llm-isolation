import express from "express";

const app = express();
app.use(express.json());

const port = Number(process.env.EDGE_PORT ?? 8080);
const nodeId = process.env.EDGE_NODE_ID ?? "edge-1";
const memoryLayerUrl = process.env.MEMORY_LAYER_URL ?? "http://localhost:8090";

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "edge-node",
    nodeId,
    memoryLayerUrl,
  });
});

// Endpint for: retrieve memory + run inference -- Includes placeholder logic for now
app.post("/generate", async (req, res) => {
  const { userId, prompt } = req.body ?? {};
  if (!userId || !prompt) {
    return res
      .status(400)
      .json({ ok: false, error: "userId and prompt are required" });
  }

  // No LLM or Mem0 yet. Just echoed a structured placeholder.
  return res.json({
    ok: true,
    nodeId,
    userId,
    prompt,
    output: "[placeholder output]",
  });
});

app.listen(port, () => {
  console.log(
    `edge-node listening on http://localhost:${port} (nodeId=${nodeId})`,
  );
});
