import cron from "node-cron";
import { listWorkflows, getWorkflow, appendRun } from "./workflows.js";
import { runWorkflow } from "./opencode.js";

const jobs = new Map(); // slug → ScheduledTask

// ─── Text collection helpers (mirrors server.js logic) ────────────────────

function collectText(events) {
  let assistantMessageId = null;
  let textPartId = null;
  let output = "";

  for (const event of events) {
    if (event?.type === "message.updated") {
      const info = event.properties?.info;
      if (info?.role === "assistant" && !assistantMessageId) assistantMessageId = info.id;
    }
    if (event?.type === "message.part.updated") {
      const part = event.properties?.part;
      if (part?.messageID === assistantMessageId && part?.type === "text" && !textPartId) {
        textPartId = part.id;
      }
    }
    if (event?.type === "message.part.delta") {
      const p = event.properties;
      if (p?.messageID === assistantMessageId && p?.partID === textPartId && p?.field === "text") {
        output += p.delta;
      }
    }
  }
  return output;
}

// ─── Execution ───────────────────────────────────────────────────────────────

async function executeWorkflow(slug) {
  const wf = await getWorkflow(slug);
  if (!wf) return;

  console.log(`[scheduler] Running workflow: ${slug}`);
  const startTime = Date.now();
  const events = [];

  try {
    for await (const event of runWorkflow(slug, wf.body, { agent: wf.agent, tools: wf.tools })) {
      events.push(event);
    }
    const output = collectText(events);
    await appendRun(slug, {
      id: startTime.toString(),
      startTime,
      endTime: Date.now(),
      status: "success",
      output,
    });
    console.log(`[scheduler] Workflow done: ${slug}`);
  } catch (err) {
    console.error(`[scheduler] Workflow error (${slug}):`, err.message);
    await appendRun(slug, {
      id: startTime.toString(),
      startTime,
      endTime: Date.now(),
      status: "error",
      output: events.length ? collectText(events) : "",
      error: err.message,
    });
  }
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

export function scheduleWorkflow(wf) {
  if (jobs.has(wf.slug)) {
    jobs.get(wf.slug).stop();
    jobs.delete(wf.slug);
  }

  if (!wf.enabled || !wf.cron) return;

  if (!cron.validate(wf.cron)) {
    console.warn(`[scheduler] Invalid cron for "${wf.slug}": ${wf.cron}`);
    return;
  }

  const task = cron.schedule(wf.cron, () => executeWorkflow(wf.slug));
  jobs.set(wf.slug, task);
  console.log(`[scheduler] Scheduled "${wf.slug}" → ${wf.cron}`);
}

export function unscheduleWorkflow(slug) {
  if (jobs.has(slug)) {
    jobs.get(slug).stop();
    jobs.delete(slug);
    console.log(`[scheduler] Unscheduled "${slug}"`);
  }
}

export async function initScheduler() {
  const workflows = await listWorkflows();
  for (const wf of workflows) {
    scheduleWorkflow(wf);
  }
  console.log(`[scheduler] Initialized with ${jobs.size} active job(s)`);
}
