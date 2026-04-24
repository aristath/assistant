import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createOpencodeClient } from "@opencode-ai/sdk";

const SERVE_PORT = 8090;
const HEALTH_URL = `http://127.0.0.1:${SERVE_PORT}/global/health`;
const HEALTH_TIMEOUT = 120_000; // 2 minutes for llama.cpp cold start
const HEALTH_POLL_MS = 1000;

let serveProcess = null;
let client = null;
let session = null;
let status = "loading";
let errorMessage = null;

// Single persistent event bus — all SSE events are broadcast here
const bus = new EventEmitter();
bus.setMaxListeners(0);

async function waitForHealth() {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

async function startServe() {
  // Attach to existing instance if already running
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log("[opencode] Already running on port", SERVE_PORT);
      return;
    }
  } catch {
    // not running — start it
  }

  console.log("[opencode] Starting opencode serve on port", SERVE_PORT);
  serveProcess = spawn("opencode", ["serve", "--port", String(SERVE_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  serveProcess.stdout.on("data", (d) => console.log(d.toString().trimEnd()));
  serveProcess.stderr.on("data", (d) => console.log(d.toString().trimEnd()));

  serveProcess.on("exit", (code, signal) => {
    console.log(`[opencode] Process exited (code: ${code}, signal: ${signal})`);
    status = "error";
    errorMessage = `opencode serve exited (code: ${code})`;
  });

  serveProcess.on("error", (err) => {
    console.error("[opencode] Failed to start:", err.message);
    status = "error";
    errorMessage = err.message;
  });
}

// Persistent SSE loop — reconnects automatically on failure
async function runEventLoop() {
  while (true) {
    try {
      const { stream } = await client.event.subscribe();
      console.log("[opencode] Event stream connected");
      for await (const event of stream) {
        bus.emit("event", event);
      }
      console.log("[opencode] Event stream ended — reconnecting...");
    } catch (err) {
      console.error("[opencode] Event stream error:", err.message, "— retrying in 3s");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export async function init() {
  await startServe();

  const ready = await waitForHealth();
  if (!ready) {
    status = "error";
    errorMessage = "opencode serve did not become ready in time";
    console.error("[opencode]", errorMessage);
    return false;
  }

  console.log("[opencode] Server is ready");
  client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${SERVE_PORT}` });

  try {
    const result = await client.session.create();
    session = result.data;
    console.log("[opencode] Created new session:", session.id);
  } catch (err) {
    status = "error";
    errorMessage = `Failed to create session: ${err.message}`;
    console.error("[opencode]", errorMessage);
    return false;
  }

  // Start the persistent SSE event loop (fire and forget)
  runEventLoop().catch((err) => console.error("[opencode] Event loop crashed:", err));

  status = "ready";
  return true;
}

/**
 * Send a message and stream back events as an async generator.
 *
 * Uses promptAsync (non-blocking 204) so the SSE events stream in
 * while the model is generating, rather than waiting for the full response.
 */
export async function* sendMessage(message) {
  if (!client || !session) throw new Error("OpenCode not initialized");
  if (status !== "ready") throw new Error(`OpenCode not ready: ${status}`);

  const queue = [];
  let notify = null;

  function onEvent(event) {
    if (event?.properties?.sessionID !== session.id && event?.type !== "session.idle") return;
    queue.push(event);
    // Safe: notify is set synchronously inside Promise constructor before any callbacks run
    const resolve = notify;
    notify = null;
    resolve?.();
  }

  // Register listener BEFORE sending the prompt to avoid race condition
  bus.on("event", onEvent);

  try {
    const result = await client.session.promptAsync({
      path: { id: session.id },
      body: { parts: [{ type: "text", text: message }] },
    });

    if (result.error) {
      throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
    }

    let done = false;
    while (!done) {
      // Drain everything currently in the queue
      while (queue.length > 0) {
        const event = queue.shift();
        yield event;

        if (
          event?.type === "session.idle" ||
          event?.type === "session.error" ||
          (event?.type === "message.updated" &&
            event?.properties?.info?.role === "assistant" &&
            event?.properties?.info?.time?.completed)
        ) {
          done = true;
          break;
        }
      }

      // Wait for the next event if we're not done yet
      if (!done && queue.length === 0) {
        await new Promise((r) => {
          notify = r;
        });
      }
    }
  } finally {
    bus.off("event", onEvent);
    notify = null;
  }
}

// ─── Workflow execution ──────────────────────────────────────────────────────

// slug → { sessionId, emitter, startTime }
const activeRuns = new Map();

let _onRunRegistered = null;
export function setRunRegisteredCallback(fn) { _onRunRegistered = fn; }

export function getActiveRun(slug) {
  return activeRuns.get(slug);
}

export function getActiveRuns() {
  return [...activeRuns.keys()];
}

/**
 * Run a workflow in a dedicated session. Yields events like sendMessage.
 * Broadcasts each event on a per-run EventEmitter so /live subscribers receive it.
 */
export async function* runWorkflow(slug, body) {
  if (!client) throw new Error("OpenCode not initialized");
  if (activeRuns.has(slug)) throw new Error(`Workflow "${slug}" is already running`);

  const result = await client.session.create();
  const ws = result.data; // workflow session

  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  activeRuns.set(slug, { sessionId: ws.id, emitter, startTime: Date.now() });
  _onRunRegistered?.(slug);

  const queue = [];
  let notify = null;

  function onEvent(event) {
    if (event?.properties?.sessionID !== ws.id) return;
    queue.push(event);
    emitter.emit("event", event);
    const resolve = notify;
    notify = null;
    resolve?.();
  }

  bus.on("event", onEvent);

  try {
    const promptResult = await client.session.promptAsync({
      path: { id: ws.id },
      body: { parts: [{ type: "text", text: body }] },
    });

    if (promptResult.error) {
      throw new Error(`Prompt failed: ${JSON.stringify(promptResult.error)}`);
    }

    let done = false;
    while (!done) {
      while (queue.length > 0) {
        const event = queue.shift();
        yield event;

        if (
          event?.type === "session.idle" ||
          event?.type === "session.error" ||
          (event?.type === "message.updated" &&
            event?.properties?.info?.role === "assistant" &&
            event?.properties?.info?.time?.completed)
        ) {
          done = true;
          break;
        }
      }

      if (!done && queue.length === 0) {
        await new Promise((r) => { notify = r; });
      }
    }
  } finally {
    bus.off("event", onEvent);
    notify = null;
    activeRuns.delete(slug);
    emitter.emit("done");
    try { await client.session.delete({ path: { id: ws.id } }); } catch { /* best effort */ }
  }
}

// ─── Status / lifecycle ──────────────────────────────────────────────────────

export function getStatus() {
  return { status, errorMessage };
}

export function shutdown() {
  if (serveProcess) {
    serveProcess.kill("SIGTERM");
    serveProcess = null;
  }
}
