import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

let cfg = {};

export async function loadConfig() {
  try {
    const raw = await readFile(
      new URL("../assistant.config.json", import.meta.url),
      "utf-8"
    );
    cfg = JSON.parse(raw);
  } catch {
    cfg = {};
  }
}

export function getWorkflowsDir() {
  const dir = cfg.workflowsDir ?? "./workflows";
  return resolve(process.cwd(), dir);
}
