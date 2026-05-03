import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function createResultRunDir(resultsDir: string, runLabel: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = runLabel.replace(/[^a-zA-Z0-9._-]/g, "-");
  const runDir = path.resolve(process.cwd(), resultsDir, `${timestamp}-${safeLabel}`);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
