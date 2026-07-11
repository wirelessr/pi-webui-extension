# HTTP Bridge Extension

HTTP server extension for pi that enables external scripts and mobile devices to interact with an active pi session. Supports both a curl-friendly JSON API and a WebUI with SSE streaming.

## Quick Start

The extension auto-loads when pi starts. Open the WebUI in your browser:

```
http://<your-lan-ip>:7331
```

The TUI displays the actual URL on session start, e.g.:

```
HTTP bridge: http://192.168.1.42:7331 (session: abc123)
```

For curl:

```bash
curl -X POST http://localhost:7331/api/prompt -d 'Run the tests'
```

## Architecture

Each pi session is a separate process with its own extension instance. There is no singleton or cross-session broker. The extension auto-allocates a port (starting from `PI_HTTP_PORT`) and writes a per-session discovery file to a shared directory.

```
~/.pi/agent/extensions/
├── index.ts                   # Extension (HTTP server + SSE + skill expansion)
├── http-bridge-web/            # WebUI static files (vanilla JS ES modules)
│   ├── index.html              # Page structure
│   ├── style.css               # Dark theme + responsive layout
│   ├── app.js                  # Entry point, wires modules together
│   ├── api.js                  # Fetch wrappers for API endpoints + SSE reader
│   ├── chat.js                 # Message rendering, streaming, tool/thinking blocks
│   ├── commands.js             # Right sidebar: command list + free-text filtering
│   ├── sessions.js             # Left sidebar: session list + QR code button
│   ├── input.js                # Textarea handling, keyboard shortcuts, auto-resize
│   ├── mobile-nav.js           # Bottom tab bar for mobile view switching
│   ├── context-menu.js         # Right-click menu on messages (copy text)
│   ├── qr.js                   # QR code modal (canvas-based)
│   ├── qrcode-lib.js           # Vendored QR generator (Kazuhiko Arase, MIT)
│   └── markdown.js             # Minimal markdown renderer (zero dependencies)
├── data/                      # Runtime: discovery files (gitignored)
└── README.md                   # This file
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | WebUI (index.html) |
| `GET` | `/<file>` | Static file from http-bridge-web/ |
| `GET` | `/api/status` | This session's status (busy, session ID, port) |
| `GET` | `/api/sessions` | All active sessions on this machine |
| `GET` | `/api/commands` | Available skills, prompt templates, and built-in commands |
| `GET` | `/api/history` | Conversation history from session JSONL (paginated) |
| `POST` | `/api/command` | Execute a built-in command (compact) |
| `POST` | `/api/abort` | Abort the current agent operation |
| `POST` | `/api/prompt` | Send message to agent |

### GET /api/history

Returns conversation history from the session JSONL file. Paginated from the tail.

```
GET /api/history?limit=50&offset=0
```

- `limit`: Max entries to return (0 = all)
- `offset`: Number of entries to skip from the end (0 = most recent)
- Response: `{ history: [...], total: 123 }`

The WebUI loads all available history in one request. The `limit` and `offset` parameters are available on the API for programmatic use.

### POST /api/prompt

Accepts plain text or JSON body.

**Plain text:**
```bash
curl -X POST http://localhost:7331/api/prompt -d 'What is 2+2?'
```

**JSON with options:**
```bash
curl -X POST http://localhost:7331/api/prompt \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize /tmp/report.csv","full":true,"timeout":600000}'
```

**SSE streaming:**
```bash
curl -N -H 'Accept: text/event-stream' \
  -X POST http://localhost:7331/api/prompt -d 'What is 2+2?'
```

Options:
- `message` (string, required): The prompt text
- `full` (boolean): Include raw `messages` array in response
- `timeout` (number): Response timeout in ms (default: 300000 = 5 min)
- `stream` (boolean): Force SSE streaming even without Accept header

### JSON Response (non-streaming)

```json
{
  "text": "Here's the summary...",
  "toolCalls": ["bash({\"command\":\"ls\"})"],
  "thinking": "Let me analyze this...",
  "messageCount": 5
}
```

### SSE Event Format

```
data: {"type":"agent_start"}
data: {"type":"text_delta","delta":"Hello"}
data: {"type":"tool_execution_start","toolName":"bash","args":{...}}
data: {"type":"tool_execution_end","toolName":"bash","isError":false}
data: {"type":"done","text":"...","toolCalls":[...],"messages":[...]}
```

Event types: `agent_start`, `turn_start`, `turn_end`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start`, `toolcall_end`, `tool_execution_start`, `tool_execution_end`, `done`, `error`.

## WebUI

- QR code button on each session item — scan to connect a mobile device to that session's URL
- Conversation history persists across refresh (loaded from session JSONL via `/api/history`)

### Desktop (>= 700px)

Three-column layout:

```
┌──────────┬─────────────────────────┬────────────────┐
│ sessions │  chat messages          │ commands  (42) │
│          │                         │ /skill:gh      │
│ session1 │                         │ /skill:jira    │
│ session2 │  [textarea]      [Send] │ /fix-tests     │
└──────────┴─────────────────────────┴────────────────┘
```

- **Left sidebar**: All active sessions. Current session highlighted. Click to switch in-place.
- **Center**: Chat area with markdown rendering, streaming, tool/thinking blocks. History persists across refresh (loaded from session JSONL).
- **Right sidebar**: All skills and prompt templates. Filters in real-time as you type `/` in the input box. Free-text matching (substring, word boundary, description). Arrow keys to navigate, Enter/Tab to insert.

### Mobile (< 700px)

Bottom tab bar with three views: sessions, chat, commands.

```
┌─────────────────────┐
│  pi bridge  :7331   │
├─────────────────────┤
│   active view       │
├─────────────────────┤
│ [textarea]  [Send]  │
├─────────────────────┤
│ sessions chat cmds  │
└─────────────────────┘
```

- Typing `/` auto-switches to commands view
- Selecting a command auto-switches back to chat
- Safe-area insets for iPhone notch / home indicator
- 16px input font to prevent iOS zoom-on-focus
- 44px minimum touch targets

## Skill / Template Expansion

`pi.sendUserMessage()` bypasses pi's internal skill/template expansion (`expandPromptTemplates: false`). This extension manually expands `/skill:name` and `/template` commands before sending, replicating pi's `_expandSkillCommand` logic:

1. Read the skill/template file from disk
2. Strip YAML frontmatter
3. Wrap in `<skill name="..." location="...">` block (same format as TUI)
4. Append user args after the block

Built-in commands (/compact, /reload, /new, /model, etc.) are loaded dynamically from pi's `BUILTIN_SLASH_COMMANDS` export — no hardcoded list. Most are TUI-only (shown in the command list with a "TUI" tag and reduced opacity). Only `/compact` is executable from WebUI via `POST /api/command`, which calls `ctx.compact()`. `/reload` is not executable from WebUI because `ctx.reload()` is only available on `ExtensionCommandContext`, not the `ExtensionContext` that event handlers receive. Use the TUI to reload.

Extension commands (`/cmd`) are not supported via HTTP because they require pi's internal command handler, not text expansion. Use the TUI for those.

## Discovery Files

Each session writes a JSON file to `<extension-dir>/data/<session-id>.json`:

```json
{
  "port": 7331,
  "host": "0.0.0.0",
  "lanIp": "192.168.1.42",
  "url": "http://192.168.1.42:7331",
  "sessionFile": "/Users/ctw/.pi/agent/sessions/.../abc123.jsonl",
  "sessionId": "abc123",
  "sessionName": "data-analysis",
  "pid": 12345,
  "startedAt": 1720000000000
}
```

Stale files from crashed sessions are cleaned on startup (PID liveness check).

Batch scripts can discover sessions:

```bash
# Find session by name
PORT=$(jq -r '.port' <extension-dir>/data/*.json | jq -s 'map(select(.sessionName=="data-analysis")) | .[0].port')
curl -X POST http://localhost:$PORT -d 'Analysis done'
```

## Configuration

Environment variables (set before starting pi):

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_HTTP_PORT` | `7331` | Starting port for auto-allocation |
| `PI_HTTP_HOST` | `0.0.0.0` | Bind address |
| `PI_BRIDGE_DIR` | `<extension-dir>/data` | Discovery file directory |

For local-only access: `PI_HTTP_HOST=127.0.0.1`

## Security

Binding to `0.0.0.0` exposes the bridge to anyone on your network. There is **no authentication**. Anyone who can reach the port can send messages to your agent and read responses.

- Only use on trusted networks (home WiFi, not public WiFi)
- For local-only use, set `PI_HTTP_HOST=127.0.0.1`
- Future: token-based auth could be added

## Hot Reload

| What changed | How to apply | Session preserved? |
|--------------|-------------|-------------------|
| Web UI files (HTML/CSS/JS) | Browser refresh | Yes |
| Extension TypeScript | `/reload` in TUI | Yes (conversation preserved, HTTP server restarts) |

## Installation

Clone into pi's extensions directory:

```bash
cd ~/.pi/agent/extensions/
git clone <repo-url> pi-webui-extension
```

pi auto-discovers `extensions/*/index.ts` on startup. No additional configuration needed.

## Development

Tests for pure-logic functions (markdown rendering, command filtering, HTML escaping):

```bash
node --test test/*.test.js
```

No external test framework or dependencies required — uses Node.js built-in test runner.

## Limitations

- One request at a time per session; concurrent requests get HTTP 409
- Don't type in the TUI while a request is in flight (agent processes one turn at a time)
- Extension commands (`/cmd`) not supported via HTTP
- Most built-in commands are TUI-only; only `/compact` is executable from WebUI
- Default response timeout is 5 minutes
- No authentication
