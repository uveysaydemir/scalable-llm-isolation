import express from "express";

const app = express();
app.use(express.json());

const port = Number(process.env.MEMORY_PORT ?? 8090);

// Placeholder endpoints that mimic a memory layer (Will be implemented by Mem0 functions later).
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "memory-layer" });
});

app.post("/memory/search", async (req, res) => {
  const { userId, query, topK = 5 } = req.body ?? {};
  if (!userId || !query) {
    return res
      .status(400)
      .json({ ok: false, error: "userId and query are required" });
  }

  return res.json({
    ok: true,
    userId,
    query,
    topK,
    results: [],
  });
});

app.post("/memory/add", async (req, res) => {
  const { userId, items } = req.body ?? {};
  if (!userId || !Array.isArray(items)) {
    return res
      .status(400)
      .json({ ok: false, error: "userId and items are required" });
  }

  return res.json({
    ok: true,
    userId,
    accepted: items.length,
  });
});

app.listen(port, () => {
  console.log(`[memory-layer] listening on http://localhost:${port}`);
});
