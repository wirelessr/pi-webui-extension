# pi WebUI

A WebUI + HTTP bridge for [pi](https://pi.dev) coding-agent sessions. Two ways
to use it:

- **Per-session** — an in-process extension gives each pi session its own
  HTTP bridge + WebUI (curl-friendly JSON API and an SSE-streaming browser UI).
- **Central hub** (optional) — a single browser entry point that reverse-
  proxies and aggregates every session, switches between them in-page (no
  navigation), and notifies you when a session you're *not* looking at finishes.

The hub is additive: install just the extension for per-session mode, or run
the hub in front of it for a single-pane, cross-session experience.

## Monorepo layout

npm workspaces, three packages:

```
packages/
  components/   @wirelessr/pi-webui-components  — shared browser UI + pure modules
  extension/    pi-webui-extension              — in-process pi bridge (Node/Hono)
  hub/          pi-webui-hub                     — central aggregator service
```

- **components** is consumed by both the extension (standalone WebUI) and the
  hub (its SPA). It has a node-safe `parsers` export the extension imports.
- **extension** and **hub** share nothing at runtime except components + the
  discovery-file format.

## Why the hub can't replace the per-session bridges

`pi.sendUserMessage` and the `agent_*` events are only reachable **inside** a
pi session process. A separate hub process cannot drive another session's
agent directly, so every session keeps its own in-process bridge. The hub is
a reverse proxy + aggregator in front of them, not a replacement.

## Quick start

### Per-session (the extension)

Deployed into `~/.pi/agent/extensions/pi-webui-extension/` (see Deployment).
pi auto-loads it; each session prints its URL on startup:

```
HTTP bridge: http://192.168.1.42:7331 (session: abc123)
```

Open that URL, or curl it:

```bash
curl -X POST http://localhost:7331/api/prompt -d 'Run the tests'
```

### Hub

```bash
npm install                                       # from the repo root (links workspaces)
pm2 start packages/hub/ecosystem.config.cjs       # or: node packages/hub/src/server.js
```

Open `http://<host>:8730/`. See [packages/hub/README.md](packages/hub/README.md)
for routes, config, and the cross-session notification design.

## API (per-session bridge)

The hub exposes the same API per session under `/s/<sessionId>/...`.

Interactive docs (Swagger UI) at `/api/docs`; OpenAPI at `/api/openapi.json`.

- `POST /api/prompt` — send a message (JSON or plain text; SSE with `Accept: text/event-stream`)
- `GET /api/history?limit=&offset=` — conversation history (paginated from the tail)
- `GET /api/sessions` — all active sessions on this machine
- `GET /api/commands` — skills + prompt templates + executable builtins
- `POST /api/new-session` / `kill-session` / `rename-session` / `reload` — lifecycle
- `POST /api/abort` — abort the current turn
- `POST /api/upload` — upload a pasted image, returns a saved file path
- `GET /api/stream/attach` — re-attach to an in-progress (or just-finished) stream

### SSE event format

```
data: {"type":"agent_start"}
data: {"type":"text_delta","delta":"Hello"}
data: {"type":"tool_execution_start","toolName":"bash","args":{...}}
data: {"type":"done","text":"...","toolCalls":[...],"messages":[...]}
```

Types: `agent_start`, `turn_start`, `turn_end`, `text_*`, `thinking_*`,
`toolcall_*`, `tool_execution_start`, `tool_execution_end`, `done`, `error`.

## WebUI

Both UIs share the components package, so rendering (markdown, streaming,
tool/thinking/subagent blocks) is identical.

- **Per-session** (`app.js`): one session per page; the session sidebar
  navigates between per-port pages.
- **Hub** (`hub-app.js`): all sessions in one page; the sidebar switches the
  active session **in-page** so the page and its SSE survive — which is what
  lets the hub notify for background sessions. Session management (new / close /
  reload / rename) is proxied to the bridges; "new" is spawned by the hub
  itself so it works even with zero existing sessions.

## Deployment

### Extension (per-session)

The deployed extension dir is self-contained (components are vendored, no
registry needed). From the repo:

```bash
# copy packages/extension/* into ~/.pi/agent/extensions/pi-webui-extension/
# vendor components into vendor/pi-webui-components/
# set the components dep to file:./vendor/pi-webui-components, then:
npm install
```

Existing sessions keep their in-memory code until reloaded (`⟳` in the UI or
`/reload` in the TUI); a reload resumes the same session file.

### Hub

PM2 (`packages/hub/ecosystem.config.cjs`). `pm2 save` to persist across the
daemon restarting; `pm2 startup` (needs sudo) for boot. The hub reads the
extension's discovery dir (`PI_BRIDGE_DIR`, default
`~/.pi/agent/extensions/pi-webui-extension/data`).

## Configuration

| Variable | Default | Where | Description |
|----------|---------|-------|-------------|
| `PI_HTTP_PORT` | `7331` | extension | starting port for auto-allocation |
| `PI_HTTP_HOST` | `0.0.0.0` | extension | bind address |
| `PI_BRIDGE_DIR` | `<ext-dir>/data` | extension + hub | discovery-file directory |
| `PI_HUB_PORT` | `8730` | hub | hub listen port |
| `PI_HUB_HOST` | `0.0.0.0` | hub | hub bind address |

## Security

Binding to `0.0.0.0` exposes the bridge/hub to your network with **no
authentication** — anyone who can reach the port can drive your agent. Use
only on trusted networks, or set the host to `127.0.0.1` for local-only.

## Development

npm workspaces; Node's built-in test runner; no external test framework.

```bash
npm install                 # link workspaces
npm test                    # run every package's tests
npx biome check packages/   # lint
```

Behavior/pure modules are kept at **100% line coverage** (CI-enforced per
package). CI (`.github/workflows/ci.yml`) lints `packages/` and runs each
package's tests + coverage gate on every push/PR.

Pure logic is extracted from IO so it's unit-testable: SSE parsing, stream
accumulation, command filtering, session/spawn helpers, flow control, UI
behaviors, markdown, and the hub's proxy-path / session-list / busy-transition
helpers. Treat the tests as the behavioral spec.

## Limitations

- One request at a time per session (concurrent → HTTP 409).
- Extension `/cmd` commands aren't available over HTTP; only `/compact` is.
- Hub busy→idle detection is poll-based (~2s): a sub-2s reply won't raise a
  cross-session notification (you'd see it anyway).
- No authentication.
