# Assistant

A local-only personal AI assistant with a terminal UI, built for low-power devices (cyberdeck, SBC, etc.).

## What it is

- **TUI-first** — full-screen terminal interface built with [blessed](https://github.com/chjj/blessed)
- **Local LLM** — powered by [OpenCode](https://opencode.ai) (`opencode serve`)
- **Workflow automation** — define prompt-based workflows that run on a schedule (cron) or manually
- **No cloud, no server** — everything runs locally; no web UI, no HTTP layer

## Requirements

- Node.js 20+
- [OpenCode CLI](https://opencode.ai) installed and in PATH (`opencode serve`)

## Setup

```bash
npm install
```

Optionally create `assistant.config.json` to customise the workflows directory:

```json
{
  "workflowsDir": "./workflows"
}
```

## Running

```bash
npm start
```

## TUI controls

| Key | Action |
|-----|--------|
| `Esc` | Open menu |
| `Enter` | Send message / confirm |
| `Tab` / `Shift+Tab` | Navigate fields in workflow editor |
| `Ctrl+S` | Save workflow |
| `←` / `→` | Change schedule mode or spinner values |
| `Space` | Toggle day-of-week checkbox (Weekly schedule) |

## Workflows

Workflows are Markdown files stored in the `workflows/` directory (gitignored by default). Each workflow has a title, description, prompt body, optional cron schedule, and an enabled flag.

### Schedule modes

The workflow editor provides a structured schedule picker — no raw cron knowledge needed:

- **Manual** — run only via the Run button
- **Every N minutes / hours** — interval-based
- **Daily / Weekdays** — time picker (HH:MM)
- **Weekly** — day-of-week toggles + time
- **Monthly** — day of month + time
- **Custom** — raw cron expression for anything else

### Run history

Every workflow execution (scheduled or manual) is recorded under `workflows/.runs/`. Browse past runs from the Logs screen.

## Architecture

```
src/
  tui.js        — blessed TUI, all UI logic
  opencode.js   — opencode serve lifecycle, SSE event bus, chat + workflow sessions
  scheduler.js  — node-cron scheduling, run recording
  workflows.js  — CRUD on workflow markdown files, run history, file watcher
  config.js     — loads assistant.config.json
```

Scheduled workflow output streams live into the main TUI view the same way manual runs and chat messages do. All console output is redirected to `/tmp/assistant.log` so nothing bleeds into the blessed screen.
