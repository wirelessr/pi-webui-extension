# pi WebUI

A WebUI + HTTP bridge for [pi](https://pi.dev) coding-agent sessions.

- **Per-session** — an in-process extension gives each pi session its own HTTP
  bridge + WebUI (curl-friendly JSON API and an SSE-streaming browser UI).
- **Central hub** (optional) — one browser entry point that reverse-proxies and
  aggregates every session, switches between them in-page, steers or follows up
  on a running turn, and notifies you when a session you're *not* looking at finishes.

The hub is additive: install just the extension for per-session mode, or run the
hub in front of it for a single-pane, cross-session experience.

## Features

| Area | What you get | Where |
|------|--------------|-------|
| Chat | Streaming markdown, tool calls, thinking and subagent blocks, diffs, syntax highlighting, paste-to-upload images, file viewer, QR code for mobile (per-session UI only) | extension + components |
| Long sessions | History pages in by turn ("Load earlier"); a joining tab replays the in-flight turn | extension |
| Session tree | Browse the branch tree and switch branches | extension + hub |
| Models and commands | Model picker, slash-command palette, `/compact` | extension |
| Steering | A message sent while the session is busy is injected into the running turn (steer); Option/Cmd/Ctrl+Enter queues a follow-up instead. Pending messages show as chips in the tab that sent them | hub + extension |
| Session management | New (cwd or resume by id), open, clone, rename, kill and reload sessions from the browser | hub |
| Session sidebar | Ordered by last activity, grouped (last 2 days / last 7 days / older), user groups, unread marker for turns you have not seen, resizable | hub |
| Notifications | Browser notification when a background session finishes a turn | hub |
| Cron | Scheduled headless `pi -p` jobs from `cron-jobs.json`, Cron panel with run history, logs, Run now and Open | hub |
| Telegram | Drive sessions from a private Telegram chat, completion pushes | telegram |
| Auto-naming | Session title from the first prompt, retitled once after the first turn | extension |
| Self-consistency banners | Status banners shown in history; needs the separate self-consistency-guard extension that emits them | extension + components |

## Packages

| Package | Role |
|---------|------|
| `packages/components` | Shared browser UI and pure modules (`@wirelessr/pi-webui-components`) |
| `packages/extension` | In-process pi bridge: one HTTP + SSE server per session |
| `packages/hub` | Reverse proxy and aggregator, single-page UI, spawn, cron |
| `packages/telegram` | Telegram bot, a client of the hub's HTTP API |

## Stability

From 1.0.0 these are the compatibility contract; a breaking change to any of
them needs a major version:

- The bridge REST/SSE API (`/api/openapi.json` is the source of truth).
- The hub routes: `/api/sessions`, `/api/events`, `/api/hub-state`,
  `/api/mark-seen`, `/api/new-session`, `/api/open-session`,
  `/api/clone-session`, `/api/cron/*`, `/s/<sessionId>/...`.
- On-disk formats under `PI_BRIDGE_DIR`: discovery files, `hub-state.json`,
  `cron/cron-jobs.json`, `cron/runs/<runId>/run.json`.
- Some newer hub features degrade against an older bridge (history paging
  falls back to a full render), but new features need the matching extension
  release. Run the hub from the same release tag as the extension
  (`git checkout v<x.y.z>`) and update both together.

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
git checkout v<x.y.z>   # match the extension release you installed
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
| `PI_AUTO_NAME_MODEL` | `accounts/fireworks/models/deepseek-v4p1-flash` | extension | model id for title generation |

Auto-naming titles a session from its first prompt. When the title model answers
`SKIP` (typically a prompt that is only a link plus a vague verb) or the title
call fails, the session gets a short placeholder instead of the raw URL
(`Slack 他在問什麼`, `service#107231 看一下`, `ENG-12345 ...`, otherwise the link's
hostname). After the first turn finishes, the session is retitled once from the
prompt plus the assistant's reply, unless the name was changed in the meantime.
The reply (truncated to about 1500 characters) is sent to the same title
provider that already receives the prompt. Without an API key the title call
never runs: every first prompt gets a placeholder-style name and no retitle
happens.

## Security

There is no built-in authentication, and both the hub (`PI_HUB_HOST`) and every
session bridge (`PI_HTTP_HOST`) default to `0.0.0.0`. Anyone who can reach
either port can drive your agent. For remote access, bind both to `127.0.0.1`
and put an authenticating proxy (for example an ngrok tunnel with OAuth) in
front of the hub only (set `PI_HUB_HOST` in the hub's environment and
`PI_HTTP_HOST` where sessions are started, for example `~/.zshenv`); a proxy alone leaves the hub and the bridge ports open
on your LAN. The hub reaches bridges over localhost. The Telegram bot reaches
the hub over localhost and only obeys one chat id.

## Development

npm workspaces (`packages/{components,extension,hub,telegram}`), Node's built-in test
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
  HTTP 409; the UI sends a steer instead when the session is busy).
- Bridge exposes `/compact`; other TUI `/commands` aren't available over HTTP.
- Cross-session busy→idle detection is poll-based (~2s).
- No built-in authentication (see Security).
