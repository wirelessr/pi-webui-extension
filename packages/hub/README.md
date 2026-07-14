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

- `GET /api/sessions` — live session list (deduped, port-sorted).
- `ANY /s/<sessionId>/...` — reverse proxy to that session's bridge (SSE-safe).
- everything else — hub shell + shared `@wirelessr/pi-webui-components` assets.

## Scope (v1)

Working: single entry, session sidebar, in-page switching (no navigation),
per-session history + streaming + stop through the proxy, notifications for
the session you're viewing (fires when the window isn't focused).

Not yet: notifications for background sessions you're not currently viewing,
an aggregated commands endpoint, and session management (new/kill/rename) via
the hub. These are follow-ups; the per-session UI still covers them.
