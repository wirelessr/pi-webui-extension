# pi-webui-hub

Optional central service: a single browser entry point that reverse-proxies
every per-session pi bridge and serves one SPA. Because the page never
navigates when you switch sessions, its SSE connections survive and it can
notify you for a session even after you've moved on.

Per-session mode still works without the hub — the hub is additive.

## Run

```bash
npm install                      # from the monorepo root (links workspaces)
pm2 start packages/hub/ecosystem.config.cjs
# or, ad hoc:
PI_HUB_PORT=8730 node packages/hub/src/server.js
```

Open `http://<host>:8730/`.

## Config

- `PI_HUB_PORT` (default `8730`) — hub listen port.
- `PI_HUB_HOST` (default `0.0.0.0`).
- `PI_BRIDGE_DIR` (default `~/.pi/agent/extensions/pi-webui-extension/data`) —
  the discovery-file directory the per-session extension writes to.

## Routes

- `GET /api/sessions` — live session list (deduped, port-sorted, with busy).
- `GET /api/events` — aggregate SSE: `session_done` when any session finishes.
- `ANY /s/<sessionId>/...` — reverse proxy to that session's bridge (SSE-safe).
- everything else — hub shell + shared `@wirelessr/pi-webui-components` assets.

## Cross-session notifications

The hub polls each session's busy state and emits `session_done` on the
aggregate `/api/events` stream when one transitions busy→idle. The single SPA
subscribes and notifies for any session that isn't the one you're viewing —
so you get told when a background session finishes, which the per-session
pages (one page per port, torn down on navigation) could never do.

The session you *are* viewing is notified by its own stream, gated on window
focus (no notification while you're looking right at it).

## Scope

Working: single entry, session sidebar with busy badges, in-page switching
(no navigation), per-session history + streaming + stop through the proxy,
and cross-session + active-session notifications.

Not yet: an aggregated commands endpoint and session management
(new/kill/rename) via the hub. The per-session UI still covers those.

Note: busy→idle detection is poll-based (~2s), so a prompt that starts and
finishes entirely between two polls won't raise a notification — only matters
for sub-2s replies, which you'd see anyway.
