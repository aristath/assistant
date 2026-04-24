import { readdir, readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import matter from "gray-matter";
import chokidar from "chokidar";
import { getWorkflowsDir } from "./config.js";

const MAX_RUNS = 50;

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugFromFile(file) {
  return basename(file, ".md");
}

function runsFile(slug) {
  return join(getWorkflowsDir(), ".runs", `${slug}.json`);
}

function parse(slug, raw) {
  const { data, content } = matter(raw);
  return {
    slug,
    title: data.title ?? slug,
    description: data.description ?? "",
    cron: data.cron ?? null,
    enabled: data.enabled ?? false,
    body: content.trim(),
  };
}

function serialize({ title, description, cron, enabled, body }) {
  return matter.stringify(body ?? "", { title, description, cron, enabled });
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listWorkflows() {
  const dir = getWorkflowsDir();
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const results = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try {
      const raw = await readFile(join(dir, f), "utf-8");
      results.push(parse(slugFromFile(f), raw));
    } catch {
      // skip unreadable files
    }
  }
  return results.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getWorkflow(slug) {
  const dir = getWorkflowsDir();
  try {
    const raw = await readFile(join(dir, `${slug}.md`), "utf-8");
    return parse(slug, raw);
  } catch {
    return null;
  }
}

export async function saveWorkflow(slug, data) {
  const dir = getWorkflowsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${slug}.md`), serialize(data), "utf-8");
}

export async function deleteWorkflow(slug) {
  const dir = getWorkflowsDir();
  await unlink(join(dir, `${slug}.md`));
  try {
    await unlink(runsFile(slug));
  } catch {
    // no run history — fine
  }
}

// ─── Run history ─────────────────────────────────────────────────────────────

export async function listRuns(slug) {
  try {
    const raw = await readFile(runsFile(slug), "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function appendRun(slug, run) {
  const dir = join(getWorkflowsDir(), ".runs");
  await mkdir(dir, { recursive: true });
  const runs = await listRuns(slug);
  runs.unshift(run);
  await writeFile(runsFile(slug), JSON.stringify(runs.slice(0, MAX_RUNS), null, 2));
}

// ─── File watcher ────────────────────────────────────────────────────────────

export function watchWorkflows(onChange) {
  const dir = getWorkflowsDir();
  const watcher = chokidar.watch(join(dir, "*.md"), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });

  watcher.on("add", async (path) => {
    const slug = slugFromFile(path);
    const wf = await getWorkflow(slug);
    if (wf) onChange("add", wf);
  });

  watcher.on("change", async (path) => {
    const slug = slugFromFile(path);
    const wf = await getWorkflow(slug);
    if (wf) onChange("change", wf);
  });

  watcher.on("unlink", (path) => {
    onChange("remove", { slug: slugFromFile(path) });
  });

}
