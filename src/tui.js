import { createWriteStream } from "node:fs";
import blessed from "blessed";
import { loadConfig } from "./config.js";
import { init, sendMessage, runWorkflow, getActiveRun, getActiveRuns, getStatus, shutdown, setRunRegisteredCallback } from "./opencode.js";
import { initScheduler, scheduleWorkflow, unscheduleWorkflow } from "./scheduler.js";
import { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, listRuns, watchWorkflows } from "./workflows.js";

// Redirect all console output to a log file so it never bleeds into the blessed TUI
const _log = createWriteStream("/tmp/assistant.log", { flags: "a" });
for (const m of ["log","info","warn","error","debug"]) {
  console[m] = (...a) => _log.write(`[${m}] ${a.map(x => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" ")}\n`);
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function* streamText(events) {
  let assistantMessageId = null;
  let textPartId = null;

  for await (const event of events) {
    if (event?.type === "message.updated") {
      const info = event.properties?.info;
      if (info?.role === "assistant" && !assistantMessageId) assistantMessageId = info.id;
    }
    if (event?.type === "message.part.updated") {
      const part = event.properties?.part;
      if (part?.messageID === assistantMessageId && part?.type === "text" && !textPartId)
        textPartId = part.id;
    }
    if (event?.type === "message.part.delta") {
      const p = event.properties;
      if (p?.messageID === assistantMessageId && p?.partID === textPartId && p?.field === "text")
        yield p.delta;
    }
  }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: "Assistant",
  fullUnicode: true,
  dockBorders: true,
  style: { bg: "#111111", fg: "white" },
});

// ─── Output state ─────────────────────────────────────────────────────────────

let outputText = "";
let isStreaming = false;
let blinkOn = true;
let autoScroll = true;

// ─── Main view ────────────────────────────────────────────────────────────────

const outputBox = blessed.box({
  top: 0, left: 0, width: "100%", height: "100%-1",
  scrollable: true, alwaysScroll: false,
  scrollbar: { ch: " ", style: { bg: "gray" } },
  tags: false, wrap: true, mouse: true,
  style: { fg: "white", bg: "#111111" },
});

const inputBar = blessed.textbox({
  bottom: 0, left: 0, width: "100%", height: 1,
  style: { fg: "white", bg: "#111111" },
  inputOnFocus: true, keys: true,
});

screen.append(outputBox);
screen.append(inputBar);

// Blinking cursor in the input bar
inputBar.on("focus", () => screen.program.write("\x1b[1 q")); // blinking block
inputBar.on("blur",  () => screen.program.write("\x1b[2 q")); // steady block

// ─── Output cursor blink ──────────────────────────────────────────────────────

function renderOutput() {
  const cursor = isStreaming ? "▋" : blinkOn ? "▋" : " ";
  outputBox.setContent(outputText + cursor);
  if (autoScroll) outputBox.setScrollPerc(100);
  screen.render();
}

setInterval(() => {
  if (!isStreaming) { blinkOn = !blinkOn; renderOutput(); }
}, 500);

outputBox.on("scroll", () => { autoScroll = outputBox.getScrollPerc() >= 95; });

function appendOutput(text) {
  outputText += text;
  renderOutput();
}

function clearOutput() {
  outputText = "";
  autoScroll = true;
  renderOutput();
}

// ─── Menu ─────────────────────────────────────────────────────────────────────

const MENU_ITEMS = ["  New Chat", "  Continue Chat", "  Workflows", "  Logs", "  Quit"];

const menuBox = blessed.list({
  top: "center", left: "center", width: 32, height: MENU_ITEMS.length + 2,
  border: { type: "line" }, label: " Menu ",
  style: {
    border: { fg: "#58a6ff" }, fg: "#e6edf3", bg: "#111111",
    selected: { fg: "#111111", bg: "#58a6ff", bold: true },
  },
  keys: true, mouse: true, items: MENU_ITEMS, hidden: true,
});

screen.append(menuBox);

// ─── Workflows view ────────────────────────────────────────────────────────────

const wfView = blessed.box({
  top: 0, left: 0, width: "100%", height: "100%",
  hidden: true, style: { bg: "#111111" },
});

const wfToolbar = blessed.box({
  top: 0, left: 0, width: "100%", height: 1,
  content: " WORKFLOWS  [↑↓] navigate  [Enter] open  [n] new  [Esc] back",
  style: { fg: "#8b949e", bg: "#111111" }, tags: false,
});

const wfList = blessed.list({
  top: 1, left: 0, width: "40%", height: "100%-2",
  border: { type: "line" }, label: " Workflows ",
  style: {
    border: { fg: "#30363d" }, fg: "#e6edf3", bg: "#111111",
    selected: { fg: "#111111", bg: "#58a6ff" },
  },
  keys: true, mouse: true,
  scrollbar: { ch: " ", style: { bg: "gray" } },
  items: [],
});

const wfDetail = blessed.box({
  top: 1, left: "40%", width: "60%", height: "100%-2",
  border: { type: "line" }, label: " Editor ",
  style: { border: { fg: "#30363d" }, fg: "#e6edf3", bg: "#111111" },
  mouse: true,
});

const wfStatusBar = blessed.box({
  bottom: 0, left: 0, width: "100%", height: 1,
  style: { fg: "#8b949e", bg: "#111111" }, tags: true,
});

wfView.append(wfToolbar);
wfView.append(wfList);
wfView.append(wfDetail);
wfView.append(wfStatusBar);
screen.append(wfView);

// ─── Logs view ─────────────────────────────────────────────────────────────────

const logsView = blessed.box({
  top: 0, left: 0, width: "100%", height: "100%",
  hidden: true, style: { bg: "#111111" },
});

const logsToolbar = blessed.box({
  top: 0, left: 0, width: "100%", height: 1,
  content: " LOGS  [↑↓] select run  [Enter] view output  [Esc] back",
  style: { fg: "#8b949e", bg: "#111111" },
});

const logsList = blessed.list({
  top: 1, left: 0, width: "40%", height: "100%-2",
  border: { type: "line" }, label: " Runs ",
  style: {
    border: { fg: "#30363d" }, fg: "#e6edf3", bg: "#111111",
    selected: { fg: "#111111", bg: "#58a6ff" },
  },
  keys: true, mouse: true,
  scrollbar: { ch: " ", style: { bg: "gray" } },
  items: [],
});

const logsDetail = blessed.box({
  top: 1, left: "40%", width: "60%", height: "100%-2",
  border: { type: "line" }, label: " Output ",
  style: { border: { fg: "#30363d" }, fg: "#e6edf3", bg: "#111111" },
  scrollable: true, alwaysScroll: true,
  scrollbar: { ch: " ", style: { bg: "gray" } },
  wrap: true, mouse: true, tags: false,
});

const logsStatusBar = blessed.box({
  bottom: 0, left: 0, width: "100%", height: 1,
  style: { fg: "#8b949e", bg: "#111111" }, tags: true,
});

logsView.append(logsToolbar);
logsView.append(logsList);
logsView.append(logsDetail);
logsView.append(logsStatusBar);
screen.append(logsView);

// ─── View management ──────────────────────────────────────────────────────────

let activeView = "main";

function showMain() {
  activeView = "main";
  outputBox.show(); inputBar.show();
  wfView.hide(); logsView.hide(); menuBox.hide();
  inputBar.focus();
  screen.render();
}

function showMenu() {
  activeView = "menu";
  menuBox.show(); menuBox.select(0); menuBox.focus();
  screen.render();
}

function hideMenu() {
  activeView = "main";
  menuBox.hide(); inputBar.focus();
  screen.render();
}

async function showWorkflows() {
  activeView = "workflows";
  menuBox.hide(); outputBox.hide(); inputBar.hide();
  await refreshWorkflowList();
  wfView.show(); logsView.hide();
  wfList.focus();
  screen.render();
}

async function showLogs() {
  activeView = "logs";
  menuBox.hide(); outputBox.hide(); inputBar.hide(); wfView.hide();
  await refreshLogs();
  logsView.show();
  logsList.focus();
  screen.render();
}

// ─── Schedule state ───────────────────────────────────────────────────────────

const SCHED_MODES = ["Manual","Every N minutes","Every N hours","Daily","Weekdays","Weekly","Monthly","Custom"];
const DOW_LABELS  = ["Su","Mo","Tu","We","Th","Fr","Sa"];
const MIN_STEPS   = [0,5,10,15,20,25,30,35,40,45,50,55];
const N_STEPS     = [1,2,3,4,5,6,7,8,9,10,12,15,20,24,30,45,60];

let schedMode = 0;
let schedN    = 15;
let schedH    = 9;
let schedM    = 0;
let schedDow  = [false,true,true,true,true,true,false];
let schedDom  = 1;

let schedModeBox, schedHourBox, schedMinBox, schedNBox;
let schedNPfxTxt, schedNSfxTxt, schedColonTxt;
let schedDowBoxes = [], schedDomBox, schedDomPfxTxt;
let schedNMinBox, schedMinPfxTxt, schedCustomFld, cronPreview;

function buildCronFromState() {
  const mode = SCHED_MODES[schedMode];
  const m = schedM, h = schedH, n = schedN;
  switch (mode) {
    case "Manual":           return null;
    case "Every N minutes":  return `*/${n} * * * *`;
    case "Every N hours":    return m === 0 ? `0 */${n} * * *` : `${m} */${n} * * *`;
    case "Daily":            return `${m} ${h} * * *`;
    case "Weekdays":         return `${m} ${h} * * 1-5`;
    case "Weekly": {
      const days = schedDow.map((on,i) => on ? i : -1).filter(i => i >= 0).join(",");
      return `${m} ${h} * * ${days || "*"}`;
    }
    case "Monthly":          return `${m} ${h} ${schedDom} * *`;
    case "Custom":           return schedCustomFld?.getValue().trim() || null;
    default:                 return null;
  }
}

function loadCronToState(cron) {
  schedMode = 0; schedN = 15; schedH = 9; schedM = 0;
  schedDow = [false,true,true,true,true,true,false]; schedDom = 1;
  if (!cron) return;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) { schedMode = SCHED_MODES.indexOf("Custom"); return; }
  const [min, hour, dom, month, dow] = parts;

  const mM = min.match(/^\*\/(\d+)$/);
  if (mM && hour==="*" && dom==="*" && month==="*" && dow==="*") {
    schedMode = SCHED_MODES.indexOf("Every N minutes"); schedN = +mM[1]; return;
  }
  const hM = hour.match(/^\*\/(\d+)$/);
  if (hM && /^\d+$/.test(min) && dom==="*" && month==="*" && dow==="*") {
    schedMode = SCHED_MODES.indexOf("Every N hours"); schedN = +hM[1]; schedM = +min; return;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    schedH = +hour; schedM = +min;
    if (/^\d+$/.test(dom) && month==="*" && dow==="*") {
      schedMode = SCHED_MODES.indexOf("Monthly"); schedDom = +dom; return;
    }
    if (dom==="*" && month==="*" && dow==="1-5") { schedMode = SCHED_MODES.indexOf("Weekdays"); return; }
    if (dom==="*" && month==="*" && dow==="*")   { schedMode = SCHED_MODES.indexOf("Daily");    return; }
    if (dom==="*" && month==="*" && /^[\d,]+$/.test(dow)) {
      schedMode = SCHED_MODES.indexOf("Weekly");
      schedDow = [false,false,false,false,false,false,false];
      dow.split(",").forEach(d => { const v = +d; if (v >= 0 && v <= 6) schedDow[v] = true; });
      return;
    }
  }
  schedMode = SCHED_MODES.indexOf("Custom");
}

function describeCronExpr(cron) {
  if (!cron) return "manual";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "custom";
  const [min, hour, dom, month, dow] = parts;
  const pad = n => String(n).padStart(2,"0");

  const mM = min.match(/^\*\/(\d+)$/);
  if (mM && hour==="*" && dom==="*" && month==="*" && dow==="*") return `every ${mM[1]}m`;

  const hM = hour.match(/^\*\/(\d+)$/);
  if (hM && dom==="*" && month==="*" && dow==="*") return `every ${hM[1]}h`;

  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const t = `${pad(+hour)}:${pad(+min)}`;
    if (dow==="1-5" && dom==="*" && month==="*")           return `weekdays ${t}`;
    if (dom==="*" && month==="*" && dow==="*")             return `daily ${t}`;
    if (/^\d+$/.test(dom) && month==="*" && dow==="*")    return `monthly ${t}`;
    if (/^[\d,]+$/.test(dow) && dom==="*" && month==="*") {
      const days = dow.split(",").map(d => DOW_LABELS[+d] ?? d).join(" ");
      return `${days} ${t}`;
    }
  }
  return "custom";
}

function updateSchedDisplay() {
  if (!schedModeBox) return;
  const mode = SCHED_MODES[schedMode];
  const pad  = n => String(n).padStart(2,"0");

  schedModeBox.setContent(`{gray-fg}<{/} ${mode.padEnd(20)}{gray-fg}>{/}`);

  const showTime   = ["Daily","Weekdays","Weekly","Monthly"].includes(mode);
  const showN      = ["Every N minutes","Every N hours"].includes(mode);
  const showNMin   = mode === "Every N hours";
  const showDow    = mode === "Weekly";
  const showDom    = mode === "Monthly";
  const showCustom = mode === "Custom";

  schedHourBox?.[  showTime   ? "show" : "hide"]();
  schedColonTxt?.[ showTime   ? "show" : "hide"]();
  schedMinBox?.[   showTime   ? "show" : "hide"]();
  schedNPfxTxt?.[ showN      ? "show" : "hide"]();
  schedNBox?.[     showN      ? "show" : "hide"]();
  schedNSfxTxt?.[ showN      ? "show" : "hide"]();
  schedCustomFld?.[ showCustom ? "show" : "hide"]();
  schedDowBoxes.forEach(b => b[showDow  ? "show" : "hide"]());
  schedDomPfxTxt?.[ showDom  ? "show" : "hide"]();
  schedDomBox?.[    showDom   ? "show" : "hide"]();
  schedMinPfxTxt?.[ showNMin  ? "show" : "hide"]();
  schedNMinBox?.[   showNMin   ? "show" : "hide"]();

  if (showTime) {
    schedHourBox.setContent(`< ${pad(schedH)} >`);
    schedMinBox.setContent(`< ${pad(schedM)} >`);
  }
  if (showN) {
    schedNBox.setContent(`< ${String(schedN).padStart(2)} >`);
    schedNSfxTxt.setContent(` ${mode === "Every N minutes" ? "minutes" : "hours"}`);
  }
  if (showNMin) schedNMinBox.setContent(`< ${pad(schedM)} >`);
  if (showDow) {
    schedDowBoxes.forEach((b, i) =>
      b.setContent(schedDow[i] ? `{bold}{#58a6ff-fg}[${DOW_LABELS[i]}]{/}` : `[${DOW_LABELS[i]}]`));
  }
  if (showDom) schedDomBox.setContent(`< ${String(schedDom).padStart(2)} >`);

  cronPreview?.setContent(`  → ${describeCronExpr(buildCronFromState()) || "not scheduled"}`);
}

function getCronValue() {
  return buildCronFromState();
}

function setCronValue(cron) {
  loadCronToState(cron);
  if (schedCustomFld)
    schedCustomFld.setValue(SCHED_MODES[schedMode] === "Custom" ? (cron ?? "") : "");
  updateSchedDisplay();
}

// ─── Workflow editor ──────────────────────────────────────────────────────────

let workflows = [];
let editingSlug = null;

function makeField(parent, label, top) {
  blessed.text({
    parent, top, left: 1, width: "100%-3", height: 1,
    content: label, style: { fg: "#8b949e", bg: "#111111" },
  });
  return blessed.textbox({
    parent, top: top + 1, left: 1, width: "100%-3", height: 3,
    border: { type: "line" },
    style: { border: { fg: "#30363d" }, fg: "white", bg: "#111111", focus: { border: { fg: "#58a6ff" } } },
    inputOnFocus: true, keys: true,
  });
}

function makeTextarea(parent, label, top, height) {
  blessed.text({
    parent, top, left: 1, width: "100%-3", height: 1,
    content: label, style: { fg: "#8b949e", bg: "#111111" },
  });
  return blessed.textarea({
    parent, top: top + 1, left: 1, width: "100%-3", height,
    border: { type: "line" },
    style: { border: { fg: "#30363d" }, fg: "white", bg: "#111111", focus: { border: { fg: "#58a6ff" } } },
    inputOnFocus: true, keys: true, mouse: true,
    scrollable: true, scrollbar: { ch: " ", style: { bg: "gray" } },
  });
}

function makeButton(parent, label, top, left, width, focusColor) {
  return blessed.button({
    parent, top, left, width, height: 3,
    content: label, border: { type: "line" },
    style: {
      border: { fg: "#30363d" }, fg: "white", bg: "#111111",
      focus: { border: { fg: focusColor }, fg: focusColor },
    },
    keys: true, mouse: true,
  });
}

let editorBuilt = false;
let fldTitle, fldDescription, fldEnabled, fldBody;
let btnSave, btnRun, btnDelete, btnBack;
let suppressNextEscape = false;

function returnToList() {
  suppressNextEscape = true;
  wfList.focus();
  screen.render();
}

function buildEditor() {
  if (editorBuilt) return;
  editorBuilt = true;

  // Layout (rows relative to wfDetail interior):
  // 1-4:   Title
  // 5-8:   Description
  // 9-14:  Schedule (label + preset selector + cron textbox + preview)
  // 15-26: Body (label + 11-row textarea)
  // 27-28: Enabled (label + checkbox)
  // 29-31: Buttons

  fldTitle       = makeField(wfDetail, "TITLE", 1);
  fldDescription = makeField(wfDetail, "DESCRIPTION", 5);

  // ── Schedule section (rows 9–14) ─────────────────────────────────────────────

  blessed.text({
    parent: wfDetail, top: 9, left: 1, width: "100%-3", height: 1,
    content: "SCHEDULE", style: { fg: "#8b949e", bg: "#111111" },
  });

  // Row 10: mode selector
  schedModeBox = blessed.box({
    parent: wfDetail, top: 10, left: 1, width: "100%-3", height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true, tags: true,
  });

  // Row 11: time spinners (Daily / Weekdays / Weekly / Monthly)
  schedHourBox = blessed.box({
    parent: wfDetail, top: 11, left: 1, width: 7, height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true,
  });
  schedColonTxt = blessed.text({
    parent: wfDetail, top: 11, left: 8, width: 1, height: 1,
    content: ":", style: { fg: "white", bg: "#111111" },
  });
  schedMinBox = blessed.box({
    parent: wfDetail, top: 11, left: 9, width: 7, height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true,
  });

  // Row 11: N spinner (Every N minutes / hours)
  schedNPfxTxt = blessed.text({
    parent: wfDetail, top: 11, left: 1, width: 7, height: 1,
    content: "Every ", style: { fg: "#8b949e", bg: "#111111" },
  });
  schedNBox = blessed.box({
    parent: wfDetail, top: 11, left: 7, width: 7, height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true,
  });
  schedNSfxTxt = blessed.text({
    parent: wfDetail, top: 11, left: 14, width: 10, height: 1,
    content: " minutes", style: { fg: "#8b949e", bg: "#111111" },
  });

  // Row 11: raw cron textbox (Custom mode)
  schedCustomFld = blessed.textbox({
    parent: wfDetail, top: 11, left: 1, width: "100%-3", height: 3,
    border: { type: "line" },
    style: { border: { fg: "#30363d" }, fg: "white", bg: "#111111", focus: { border: { fg: "#58a6ff" } } },
    inputOnFocus: true, keys: true,
  });

  // Row 12: day-of-week toggles (Weekly)
  schedDowBoxes = DOW_LABELS.map((_, i) => blessed.box({
    parent: wfDetail, top: 12, left: 1 + i * 5, width: 4, height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true, tags: true,
  }));

  // Row 12: day-of-month spinner (Monthly)
  schedDomPfxTxt = blessed.text({
    parent: wfDetail, top: 12, left: 1, width: 5, height: 1,
    content: "Day ", style: { fg: "#8b949e", bg: "#111111" },
  });
  schedDomBox = blessed.box({
    parent: wfDetail, top: 12, left: 5, width: 7, height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true,
  });

  // Row 12: minute offset for Every N hours
  schedMinPfxTxt = blessed.text({
    parent: wfDetail, top: 12, left: 1, width: 6, height: 1,
    content: "at :", style: { fg: "#8b949e", bg: "#111111" },
  });
  schedNMinBox = blessed.box({
    parent: wfDetail, top: 12, left: 6, width: 7, height: 1,
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true,
  });

  // Row 14: preview
  cronPreview = blessed.text({
    parent: wfDetail, top: 14, left: 1, width: "100%-3", height: 1,
    style: { fg: "#58a6ff", bg: "#111111" },
  });

  // ── Schedule event handlers ───────────────────────────────────────────────────

  schedModeBox.key("left",  () => { schedMode = (schedMode - 1 + SCHED_MODES.length) % SCHED_MODES.length; updateSchedDisplay(); screen.render(); });
  schedModeBox.key("right", () => { schedMode = (schedMode + 1) % SCHED_MODES.length;                      updateSchedDisplay(); screen.render(); });

  schedHourBox.key("left",  () => { schedH = (schedH - 1 + 24) % 24; updateSchedDisplay(); screen.render(); });
  schedHourBox.key("right", () => { schedH = (schedH + 1) % 24;       updateSchedDisplay(); screen.render(); });

  function stepMin(dir) {
    const idx = MIN_STEPS.indexOf(schedM);
    schedM = idx >= 0 ? MIN_STEPS[(idx + dir + MIN_STEPS.length) % MIN_STEPS.length]
                      : Math.round(schedM / 5) * 5 % 60;
  }
  schedMinBox.key("left",   () => { stepMin(-1); updateSchedDisplay(); screen.render(); });
  schedMinBox.key("right",  () => { stepMin(+1); updateSchedDisplay(); screen.render(); });
  schedNMinBox.key("left",  () => { stepMin(-1); updateSchedDisplay(); screen.render(); });
  schedNMinBox.key("right", () => { stepMin(+1); updateSchedDisplay(); screen.render(); });

  function stepN(dir) {
    const maxN = SCHED_MODES[schedMode] === "Every N hours" ? 23 : 59;
    const steps = N_STEPS.filter(v => v <= maxN);
    if (dir > 0) { const v = steps.find(v => v > schedN);                  if (v !== undefined) schedN = v; }
    else         { const v = [...steps].reverse().find(v => v < schedN);   if (v !== undefined) schedN = v; }
  }
  schedNBox.key("left",  () => { stepN(-1); updateSchedDisplay(); screen.render(); });
  schedNBox.key("right", () => { stepN(+1); updateSchedDisplay(); screen.render(); });

  schedDomBox.key("left",  () => { schedDom = Math.max(1,  schedDom - 1); updateSchedDisplay(); screen.render(); });
  schedDomBox.key("right", () => { schedDom = Math.min(31, schedDom + 1); updateSchedDisplay(); screen.render(); });

  schedDowBoxes.forEach((box, i) => {
    box.key(["space","enter"], () => { schedDow[i] = !schedDow[i]; updateSchedDisplay(); screen.render(); });
    box.key("left",  () => { screen.focusPop(); schedDowBoxes[(i-1+7)%7].focus(); screen.render(); });
    box.key("right", () => { screen.focusPop(); schedDowBoxes[(i+1)%7].focus();   screen.render(); });
  });

  schedCustomFld.on("keypress", () => setImmediate(() => { updateSchedDisplay(); screen.render(); }));

  fldBody = makeTextarea(wfDetail, "PROMPT / BODY", 15, 11);

  blessed.text({
    parent: wfDetail, top: 27, left: 1, content: "ENABLED",
    style: { fg: "#8b949e", bg: "#111111" },
  });
  fldEnabled = blessed.checkbox({
    parent: wfDetail, top: 28, left: 1, width: 14, height: 1,
    text: " Enabled",
    style: { fg: "white", bg: "#111111", focus: { fg: "#58a6ff" } },
    keys: true, mouse: true,
  });

  btnSave   = makeButton(wfDetail, "  Save",   29,  1, 10, "#3fb950");
  btnRun    = makeButton(wfDetail, "  Run",    29, 13, 10, "#58a6ff");
  btnDelete = makeButton(wfDetail, "  Delete", 29, 25, 12, "#f85149");
  btnBack   = makeButton(wfDetail, "  Back",   29, 39, 10, "#8b949e");

  // ── Dynamic tab order for schedule inputs ────────────────────────────────────
  function getSchedInputWidgets() {
    const mode = SCHED_MODES[schedMode];
    const ws = [];
    if (["Daily","Weekdays","Weekly","Monthly"].includes(mode)) ws.push(schedHourBox, schedMinBox);
    if (["Every N minutes","Every N hours"].includes(mode))     ws.push(schedNBox);
    if (mode === "Every N hours") ws.push(schedNMinBox);
    if (mode === "Weekly")        ws.push(...schedDowBoxes);
    if (mode === "Monthly")       ws.push(schedDomBox);
    if (mode === "Custom")        ws.push(schedCustomFld);
    return ws;
  }

  function setupSchedTab(widget) {
    widget.key("tab", () => {
      const ws = getSchedInputWidgets(), idx = ws.indexOf(widget);
      screen.focusPop(); (idx >= 0 && idx < ws.length - 1 ? ws[idx + 1] : fldBody).focus(); screen.render();
    });
    widget.key("S-tab", () => {
      const ws = getSchedInputWidgets(), idx = ws.indexOf(widget);
      screen.focusPop(); (idx > 0 ? ws[idx - 1] : schedModeBox).focus(); screen.render();
    });
  }
  [schedHourBox, schedMinBox, schedNBox, schedNMinBox, schedDomBox, schedCustomFld, ...schedDowBoxes].forEach(setupSchedTab);

  // ── Outer editor tab order ────────────────────────────────────────────────────
  fldTitle.key("tab",   () => { screen.focusPop(); fldDescription.focus(); screen.render(); });
  fldTitle.key("S-tab", () => { screen.focusPop(); btnBack.focus(); screen.render(); });

  fldDescription.key("tab",   () => { screen.focusPop(); schedModeBox.focus(); screen.render(); });
  fldDescription.key("S-tab", () => { screen.focusPop(); fldTitle.focus(); screen.render(); });

  schedModeBox.key("tab", () => {
    const ws = getSchedInputWidgets();
    screen.focusPop(); (ws[0] ?? fldBody).focus(); screen.render();
  });
  schedModeBox.key("S-tab", () => { screen.focusPop(); fldDescription.focus(); screen.render(); });

  fldBody.key("tab",   () => { screen.focusPop(); fldEnabled.focus(); screen.render(); });
  fldBody.key("S-tab", () => {
    const ws = getSchedInputWidgets();
    screen.focusPop(); (ws.length > 0 ? ws[ws.length - 1] : schedModeBox).focus(); screen.render();
  });

  const tailOrder = [fldEnabled, btnSave, btnRun, btnDelete, btnBack];
  for (let i = 0; i < tailOrder.length; i++) {
    const prev = i === 0 ? fldBody : tailOrder[i - 1];
    const next = i === tailOrder.length - 1 ? fldTitle : tailOrder[i + 1];
    tailOrder[i].key("tab",   () => { screen.focusPop(); next.focus(); screen.render(); });
    tailOrder[i].key("S-tab", () => { screen.focusPop(); prev.focus(); screen.render(); });
  }

  // ── Ctrl+S to save from anywhere ─────────────────────────────────────────────
  const allEditorWidgets = [fldTitle, fldDescription, schedModeBox, schedHourBox, schedMinBox,
    schedNBox, schedNMinBox, schedDomBox, schedCustomFld, ...schedDowBoxes,
    fldBody, fldEnabled, btnSave, btnRun, btnDelete, btnBack];
  allEditorWidgets.forEach(w => w.key("C-s", saveCurrentWorkflow));

  // ── ESC: return to list ───────────────────────────────────────────────────────
  [fldTitle, fldDescription, fldBody, schedCustomFld].forEach(f => {
    f.on("cancel", () => { if (activeView === "workflows") returnToList(); });
  });
  [schedModeBox, schedHourBox, schedMinBox, schedNBox, schedNMinBox, schedDomBox,
   ...schedDowBoxes, fldEnabled, btnSave, btnRun, btnDelete, btnBack].forEach(f => {
    f.key("escape", () => { if (activeView === "workflows") returnToList(); });
  });

  // ── Button handlers ───────────────────────────────────────────────────────────
  btnSave.on("press",   saveCurrentWorkflow);
  btnRun.on("press",    runCurrentWorkflow);
  btnDelete.on("press", deleteCurrentWorkflow);
  btnBack.on("press",   () => returnToList());

  updateSchedDisplay();
}

function loadEditorFields(wf) {
  buildEditor();
  editingSlug = wf?.slug ?? null;

  fldTitle.setValue(wf?.title ?? "");
  fldDescription.setValue(wf?.description ?? "");
  setCronValue(wf?.cron ?? null);
  fldBody.setValue(wf?.body ?? "");
  if (wf?.enabled) fldEnabled.check(); else fldEnabled.uncheck();

  wfDetail.setLabel(wf ? ` ${wf.title} ` : " New Workflow ");
  if (wf) btnDelete.show(); else btnDelete.hide();
  wfStatusBar.setContent(wf ? `  slug: ${wf.slug}` : "  New workflow — fill in Title and Save");
  screen.render();
}

async function saveCurrentWorkflow() {
  buildEditor();
  const title = fldTitle.getValue().trim();
  if (!title) { setWfStatus("{red-fg}Title is required{/}"); return; }

  const slug = editingSlug ?? slugify(title);
  const wf = {
    title,
    description: fldDescription.getValue().trim(),
    cron: getCronValue(),
    enabled: fldEnabled.checked ?? false,
    body: fldBody.getValue(),
  };

  try {
    await saveWorkflow(slug, wf);
    scheduleWorkflow({ ...wf, slug });
    editingSlug = slug;
    wfDetail.setLabel(` ${title} `);
    await refreshWorkflowList();
    setWfStatus(`{green-fg}Saved: ${slug}{/}`);
  } catch (err) {
    setWfStatus(`{red-fg}Error: ${err.message}{/}`);
  }
}

async function runCurrentWorkflow() {
  if (!editingSlug) { setWfStatus("{yellow-fg}Save the workflow first{/}"); return; }
  const wf = await getWorkflow(editingSlug);
  if (!wf) return;

  showMain();
  autoScroll = true;
  appendOutput(`\n─── Running: ${wf.title} ───\n\n`);
  isStreaming = true;

  try {
    for await (const delta of streamText(runWorkflow(editingSlug, wf.body))) {
      appendOutput(delta);
    }
    appendOutput("\n\n─── Done ───\n\n");
  } catch (err) {
    appendOutput(`\n\n[error] ${err.message}\n\n`);
  } finally {
    isStreaming = false;
    renderOutput();
    inputBar.focus();
  }
}

async function deleteCurrentWorkflow() {
  if (!editingSlug) return;
  const slug = editingSlug;
  try {
    unscheduleWorkflow(slug);
    await deleteWorkflow(slug);
    editingSlug = null;
    loadEditorFields(null);
    await refreshWorkflowList();
    setWfStatus(`{green-fg}Deleted: ${slug}{/}`);
  } catch (err) {
    setWfStatus(`{red-fg}Error: ${err.message}{/}`);
  }
}

function setWfStatus(text) {
  wfStatusBar.setContent("  " + text);
  screen.render();
}

async function refreshWorkflowList() {
  workflows = await listWorkflows();
  const active = getActiveRuns();
  const items = workflows.map((wf) => {
    const running = active.includes(wf.slug) ? " [running]" : "";
    const badge = wf.enabled ? "[on] " : "[off]";
    const cron = describeCronExpr(wf.cron);
    return ` ${badge} ${wf.title}  ${cron}${running}`;
  });
  if (items.length === 0) items.push(" (no workflows yet — press n to create one)");
  wfList.setItems(items);
  screen.render();
}

wfList.on("select", (_, idx) => {
  if (!workflows[idx]) return;
  loadEditorFields(workflows[idx]);
  fldTitle.focus();
});

wfList.key("n", () => {
  loadEditorFields(null);
  fldTitle.focus();
});

// ─── Logs ──────────────────────────────────────────────────────────────────────

let allRuns = [];

async function refreshLogs() {
  const wfs = await listWorkflows();
  allRuns = [];
  for (const wf of wfs) {
    const runs = await listRuns(wf.slug);
    for (const run of runs) allRuns.push({ slug: wf.slug, title: wf.title, run });
  }
  allRuns.sort((a, b) => b.run.startTime - a.run.startTime);

  const items = allRuns.map(({ title, run }) => {
    const icon = run.status === "success" ? "✓" : "✗";
    const when = new Date(run.startTime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const dur = run.endTime ? `${((run.endTime - run.startTime) / 1000).toFixed(1)}s` : "";
    return ` ${icon} ${title}  ${when}  ${dur}`;
  });

  if (items.length === 0) items.push(" (no runs yet)");
  logsList.setItems(items);

  const ok  = allRuns.filter(r => r.run.status === "success").length;
  const err = allRuns.filter(r => r.run.status === "error").length;
  logsStatusBar.setContent(`  ${allRuns.length} run(s) — ${ok} ok, ${err} error(s)`);
  screen.render();
}

logsList.on("select", (_, idx) => {
  const entry = allRuns[idx];
  if (!entry) return;
  const { title, run } = entry;
  const when = new Date(run.startTime).toLocaleString();
  const dur = run.endTime ? `${((run.endTime - run.startTime) / 1000).toFixed(1)}s` : "?";
  let content = `Workflow: ${title}\nStatus:   ${run.status}\nTime:     ${when}\nDuration: ${dur}\n`;
  if (run.error) content += `Error:    ${run.error}\n`;
  content += `\n─── Output ───\n\n${run.output || "(no output)"}`;
  logsDetail.setContent(content);
  logsDetail.setScrollPerc(0);
  screen.render();
});

// ─── Global key bindings ──────────────────────────────────────────────────────

screen.key("escape", () => {
  if (suppressNextEscape) { suppressNextEscape = false; return; }
  if (activeView === "main") showMenu();
  else if (activeView === "menu") hideMenu();
  else if (activeView === "workflows" || activeView === "logs") showMain();
});

menuBox.on("select", async (_, idx) => {
  switch (idx) {
    case 0: clearOutput(); showMain(); break;
    case 1: hideMenu(); break;
    case 2: await showWorkflows(); break;
    case 3: await showLogs(); break;
    case 4: shutdown(); process.exit(0);
  }
});

// ─── Chat input ───────────────────────────────────────────────────────────────

inputBar.key("enter", async () => {
  const msg = inputBar.getValue().trim();
  if (!msg || isStreaming) { inputBar.focus(); return; }

  inputBar.clearValue();
  screen.render();

  autoScroll = true;
  appendOutput(`\n> ${msg}\n\n`);
  isStreaming = true;

  try {
    for await (const delta of streamText(sendMessage(msg))) {
      appendOutput(delta);
    }
    appendOutput("\n\n");
  } catch (err) {
    appendOutput(`\n[error] ${err.message}\n\n`);
  } finally {
    isStreaming = false;
    blinkOn = true;
    renderOutput();
    inputBar.focus();
  }
});

// ─── Slug helper ──────────────────────────────────────────────────────────────

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  await loadConfig();
  appendOutput("Initializing...\n");

  const ok = await init();
  if (!ok) {
    const { errorMessage } = getStatus();
    appendOutput(`\n[error] Failed to initialize: ${errorMessage}\n`);
  } else {
    clearOutput();
  }

  await initScheduler();

  // Stream output from scheduler-triggered runs into the main view
  setRunRegisteredCallback((slug) => {
    const run = getActiveRun(slug);
    if (!run) return;

    showMain();
    autoScroll = true;
    isStreaming = true;
    appendOutput(`\n─── Scheduled: ${slug} ───\n\n`);

    const tracker = { msgId: null, partId: null };
    run.emitter.on("event", (ev) => {
      if (ev?.type === "message.updated") {
        const info = ev.properties?.info;
        if (info?.role === "assistant" && !tracker.msgId) tracker.msgId = info.id;
      }
      if (ev?.type === "message.part.updated") {
        const part = ev.properties?.part;
        if (part?.messageID === tracker.msgId && part?.type === "text" && !tracker.partId)
          tracker.partId = part.id;
      }
      if (ev?.type === "message.part.delta") {
        const p = ev.properties;
        if (p?.messageID === tracker.msgId && p?.partID === tracker.partId && p?.field === "text")
          appendOutput(p.delta);
      }
    });
    run.emitter.once("done", () => {
      isStreaming = false;
      appendOutput(`\n\n─── Done ───\n\n`);
      renderOutput();
      inputBar.focus();
    });
  });

  watchWorkflows((event, wf) => {
    if (event === "remove") unscheduleWorkflow(wf.slug);
    else scheduleWorkflow(wf);
  });

  inputBar.focus();
  renderOutput();
}

process.on("SIGINT",  () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

main().catch((err) => {
  appendOutput(`\n[fatal] ${err.message}\n`);
  renderOutput();
});
