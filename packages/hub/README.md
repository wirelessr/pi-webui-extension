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
  the discovery-file directory the per-session extension writes to. The hub
  also keeps `hub-state.json` and `cron/` here.

The hub has no authentication; see the root README (Security).

## Routes

- `GET /api/sessions` — live session list (deduped, with busy and last activity).
- `GET /api/events` — aggregate SSE: `session_done` when any session finishes.
- `GET|PUT /api/hub-state` — persisted sidebar layout (groups, membership, collapsed).
- `POST /api/mark-seen` — clear a session's unread marker.
- `POST /api/new-session`, `/api/open-session`, `/api/clone-session` — spawn a
  session (new in a cwd, resume by id, or clone).
- `GET /api/cron/jobs`, `GET /api/cron/jobs/<id>/runs`,
  `POST /api/cron/jobs/<id>/run`, `GET /api/cron/runs/<runId>/log` — cron.
- `ANY /s/<sessionId>/...` — reverse proxy to that session's bridge (SSE-safe).
  This is also how rename, kill, reload, tree and model switching are reached.
- everything else — hub shell + shared `@wirelessr/pi-webui-components` assets.

## What the hub does

- **One page, many sessions.** Switching sessions never navigates, so SSE
  connections survive and background sessions can notify.
- **Sidebar.** Sessions are ordered by last activity (derived from the last
  message, not the file mtime), bucketed into last 2 days, last 7 days and
  older, optionally put into named groups, and marked unread when a turn
  finished that you have not viewed. Groups and collapsed state are persisted
  in `hub-state.json`; the sidebar width is per-browser (`localStorage`).
- **Spawning.** `+` starts a session: an id resumes it (from its original cwd),
  a cwd starts a new one there, neither inherits the viewed session's cwd.
  Sessions start through `zsh -c` when zsh is on PATH (falling back to
  `sh -c`), so they get the user's current environment rather than the hub's
  frozen one.
- **Busy-time sends.** The hub keeps no message queue. A message sent while a
  session is busy is proxied to the bridge's `/api/steer` and injected into the
  running turn; Option/Cmd/Ctrl+Enter sends a follow-up instead. The "waiting"
  chips are browser state of the tab that sent them; a failed send removes the
  chip and shows an alert.
- **Notifications.** The hub polls each session's busy state (~2 s) and emits
  `session_done` on `/api/events` when one goes busy to idle; the page notifies
  for sessions you are not viewing. The viewed session is notified by its own
  stream, gated on window focus. A prompt that starts and finishes between two
  polls raises no notification.

## Cron

Scheduled jobs run as headless `pi -p` and show up in the Cron panel with
history, logs, Run now, and Open (resume the run's session).

- Jobs live in `$PI_BRIDGE_DIR/cron/cron-jobs.json`, hand-edited (write it
  atomically: temp file then rename). The hub reads it every tick and never
  writes it. Per-job validation errors appear in `GET /api/cron/jobs`.
- A job needs `id`, `name`, `schedule` (5-field cron), `prompt`, `model`,
  `cwd` and `enabled: true`. Optional: `maxRuntimeMinutes`, `graceMinutes`,
  `since`. Top-level `timezone` is an IANA name (default: system zone).
- A missed slot fires once on recovery if within the grace window; a slot whose
  previous run is still active is recorded as `skipped`.
- Runs are kept under `cron/runs/<runId>/` (`run.json`, `out.log`, `exit`),
  30 per job. One hub per `PI_BRIDGE_DIR` owns the scheduler (`scheduler.lock`);
  others only read. A bad file or job degrades, it does not stop the hub.
- Jobs run under `zsh -c` (zsh is required; there is no fallback) with the
  hub's environment, overlaid by `~/.zshenv`. Keep `~/.zshenv` env-only
  (exports, no aliases, `cd` or `setopt`) and never set `PI_BRIDGE_DIR`
  or `PI_HTTP_PORT` there.

## Not in scope

Authentication, and driving an agent from the hub process itself (the hub only
proxies to each session's own bridge).
