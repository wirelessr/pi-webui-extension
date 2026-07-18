# pi WebUI

A WebUI + HTTP bridge for [pi](https://pi.dev) coding-agent sessions.

- **Per-session** — an in-process extension gives each pi session its own HTTP
  bridge + WebUI (curl-friendly JSON API and an SSE-streaming browser UI).
- **Central hub** (optional) — one browser entry point that reverse-proxies and
  aggregates every session, switches between them in-page, queues messages per
  session, and notifies you when a session you're *not* looking at finishes.

The hub is additive: install just the extension for per-session mode, or run the
hub in front of it for a single-pane, cross-session experience.

## Why the hub can't replace the per-session bridges

`pi.sendUserMessage` and the `agent_*` events are only reachable **inside** a pi
session process. A separate hub process can't drive another session's agent
directly, so every session keeps its own in-process bridge. The hub is a reverse
proxy + aggregator in front of them, not a replacement.

## Install

Two pieces, in order: the **extension** first (it gives each pi session its
own HTTP bridge), then the **hub** (a reverse proxy + aggregator in front of
them). The hub can't drive agents on its own — it discovers sessions via the
extension, so the extension must be installed and running first.

### 1. Extension (per-session bridge)

Installs the prebuilt, self-contained extension (components vendored, no
registry):

```bash
pi install git:github.com/wirelessr/pi-webui-extension@release
pi update      # later, to pull the latest release
```

pi auto-loads it on session startup; each session prints its URL:

```
HTTP bridge: http://<host>:7331 (session: …)
```

Open it in a browser, or curl it:

```bash
curl -X POST http://localhost:7331/api/prompt -d 'Run the tests'
```

That's the minimum — per-session mode works with just the extension.

### 2. Hub (single-pane, cross-session)

Runs from a clone of this repo (it's not part of the extension package). It
reads the extension's discovery dir to find sessions, so make sure the
extension is installed first and at least one session has run (so the
discovery dir exists).

```bash
git clone https://github.com/wirelessr/pi-webui-extension && cd pi-webui-extension
npm install
pm2 start packages/hub/ecosystem.config.cjs   # or: node packages/hub/src/server.js
```

Open `http://<host>:8730/`.

The hub finds sessions by reading `PI_BRIDGE_DIR` (default:
`~/.pi/agent/extensions/pi-webui-extension/data` — exactly where `pi install`
puts the extension). They match out of the box; only override `PI_BRIDGE_DIR`
in both the extension and the hub if you moved the extension's data dir.

`pm2 save` persists the hub across daemon restarts. See
[packages/hub/README.md](packages/hub/README.md) for the cross-session design.

## API

Every bridge serves interactive docs (Swagger UI) at `/api/docs` and the schema
at `/api/openapi.json` — that's the source of truth for endpoints. The hub
exposes the same API per session under `/s/<sessionId>/...`.

`POST /api/prompt` streams Server-Sent Events when called with
`Accept: text/event-stream`:

```
data: {"type":"text_delta","delta":"Hello"}
data: {"type":"done","text":"...","messages":[...]}
```

## Configuration

| Variable | Default | Where | Description |
|----------|---------|-------|-------------|
| `PI_HTTP_PORT` | `7331` | extension | starting port for auto-allocation |
| `PI_HTTP_HOST` | `0.0.0.0` | extension | bind address |
| `PI_BRIDGE_DIR` | `<ext-dir>/data` | extension + hub | discovery-file directory |
| `PI_HUB_PORT` | `8730` | hub | hub listen port |
| `PI_HUB_HOST` | `0.0.0.0` | hub | hub bind address |
| `PI_AUTO_NAME` | `1` | extension | set `0` to disable auto session naming |
| `PI_AUTO_NAME_API_KEY` | `$FIREWORKS_API_KEY` | extension | API key for the title model |
| `PI_AUTO_NAME_API_URL` | Fireworks chat-completions URL | extension | OpenAI-compatible chat-completions endpoint |
| `PI_AUTO_NAME_MODEL` | `accounts/fireworks/models/qwen3p7-plus` | extension | model id for title generation |

## Security

Binding to `0.0.0.0` exposes the bridge/hub to your network with **no
authentication** — anyone who can reach the port can drive your agent. Use only
on trusted networks, or set the host to `127.0.0.1` for local-only.

## Development

npm workspaces (`packages/{components,extension,hub}`), Node's built-in test
runner, no external framework.

```bash
npm install                 # link workspaces
npm test                    # every package's tests
npx biome check packages/   # lint
```

Pure logic is extracted from IO and kept at 100% line coverage (CI-enforced per
package); treat the tests as the behavioral spec.

**Releasing** is tag-driven: `npm run release <x.y.z>` bumps every package +
lockfile atomically and tags; pushing the tag builds the flat extension and
publishes it to the `release` branch + a GitHub Release. No npm registry.

## Limitations

- One turn at a time per session at the bridge (a concurrent direct request gets
  HTTP 409; the hub layers a per-session queue on top).
- Bridge exposes `/compact`; other TUI `/commands` aren't available over HTTP.
- Cross-session busy→idle detection is poll-based (~2s).
- No authentication.
