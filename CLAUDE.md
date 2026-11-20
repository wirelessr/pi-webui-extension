# CLAUDE.md — pi WebUI monorepo

Working rules and gotchas. Overview and rationale: `README.md`, `docs/monorepo-design.md`.
How a feature works: read the code and tests; this file only keeps what they don't tell you.

## Layout (npm workspaces)

- `packages/components` (`@wirelessr/pi-webui-components`): shared browser UI + pure
  modules, used by extension and hub. The `parsers` export is Node-safe; the rest is
  browser-only static files.
- `packages/extension` (`pi-webui-extension`): in-process pi bridge. `index.ts` is a thin
  adapter; logic lives in `bridge-app.js` (Hono routes), `helpers.js`, and the gated pure
  modules `turn-lifecycle.js`, `sse-broadcast.js`, `tree-logic.js`, `session-helpers.js`.
- `packages/hub` (`pi-webui-hub`): reverse-proxies each session under `/s/<id>/...`,
  serves one SPA (`public/hub-app.js`), aggregates the session list + `/api/events`.
- `packages/telegram` (`pi-webui-telegram`): long-polling Telegram bot, a pure client of the
  hub's HTTP API (never the bridges). Logic in `telegram-helpers.js` (gated); `server.js` is IO.

## Hard constraint

`pi.sendUserMessage` / `agent_*` events are **in-process only**. The hub can't drive
another session's agent; it proxies to each session's own bridge. Don't make the hub a
singleton that replaces the bridges.

## Tests + CI (reproduce locally before merging)

- Keep `npm test` green; extend existing test files, don't fragment. When reusing a
  components API from the hub, don't change its tested signature: add an optional param
  with a default.
- Lint: `npx biome check packages/` (includes `test/`; warnings exit 0).
- 100% line coverage gate per package on the behavior modules listed in
  `.github/workflows/ci.yml`. Reproduce: `node --experimental-test-coverage --test test/*.test.js`.
  `index.ts` and DOM code (`chat.js`) are not gated: put testable logic in a pure module.
- No timing-based tests: assert on awaited results, not `setTimeout`.

## Verifying against real behavior: never touch the user's sessions

- Claims about hub, extension, spawn or cron behavior are proven against real pi in a
  **shadow**: a separate test hub, its own `PI_BRIDGE_DIR`, throwaway sessions. Procedure,
  cleanup and known traps: `.pi/skills/pi-webui-shadow/SKILL.md`. Read it before starting one.
- NEVER read, write or kill the user's real sessions, real `data/`, or the live hub. Only
  signal processes you started and recorded (pid or process group), never by pattern. Delete
  only session files you created, by recorded id. `/api/new-session` on the live hub
  spawns unconditionally: don't probe it.
- Behavior and UI bugs get a machine-checkable verdict, red before the fix and green after,
  from a headless-browser script under `scripts/` (`repro-*.mjs`, or `e2e-*.mjs` for a real pi +
  hub run; the skill lists the templates).
- An `index.ts` change cannot be seen through a shadow hub (it loads the deployed extension);
  the skill describes loading a freshly built copy instead. The live extension stays untouched.

## Dev repo vs deployment

- **Dev repo** `~/Workdir/pi-webui-monorepo` (`main`): all development; the hub runs from
  here under PM2.
- **Deployed extension** `~/.pi/agent/extensions/pi-webui-extension`: NOT a git worktree,
  a build output. `.deployed-from` records the source commit. `scripts/deploy-local.sh
  [commit]` rebuilds it (components vendored under `vendor/`); roll back by deploying an
  older commit. It needs a clean `packages/` tree, and with `<commit>` it temporarily
  checks that commit out in the dev repo. `data/` (discovery files, `hub-state.json`)
  survives redeploys.

| Changed | To apply |
|---------|----------|
| Hub server (`packages/hub/src/*.js`) | `pm2 restart pi-webui-hub` |
| Browser-served files (`hub-app.js`, `index.html`, `components/src/*`) | browser refresh |
| Extension (`packages/extension/*`) | `scripts/deploy-local.sh`, then reload each session (`⟳` / `/reload`) |

**PM2 treekill:** the hub spawns pi sessions as detached children and PM2's default
`treekill: true` would SIGKILL them on restart. `ecosystem.config.cjs` sets
`treekill: false` (keep it). Changing it needs `pm2 delete && pm2 start`; plain `restart`
reuses the cached config.

## Releasing (tag-driven, git distribution, no npm registry)

- `npm run release <x.y.z>` on a clean tree bumps every package version, the internal
  dep ranges and the lockfile together, runs lint + tests, commits and tags. Then
  `git push origin main --follow-tags`. Never hand-edit versions: a partial bump breaks
  the workspace link and 404s `npm ci`.
- The `v*.*.*` tag triggers `.github/workflows/release.yml`, which force-pushes a flat
  build to the long-lived `release` branch. Only `main` and `release` are permanent.
  Distribution only; local dev/deploy is unchanged.
- No branch protection (self-use repo): CI red does NOT block merge. Check
  `gh pr checks` is green before `gh pr merge`.

## Session resume by id: cwd is load-bearing

- pi refuses to resume from the wrong directory (`Session found in different project`,
  then the bridge never comes up). Spawn from the session's original cwd.
- The canonical session id is the first-line `"id"` of the `.jsonl`, not the filename
  uuid (resumed/forked sessions differ). Matching by filename substring misses them.
- Spawn/resolve logic lives ONLY in `@wirelessr/pi-webui-components/session-spawn.js`.
  Import it; don't re-inline copies.
- Hub `+` modal: id → resume (cwd ignored); no id + cwd → new there; neither → inherit
  the viewed session's cwd (server falls back to homedir).

## Session spawn: shell and environment

- Hub (new/open/clone) and extension (new/open/reload) start sessions through
  `sessionShellArgv` in `session-spawn.js`: `zsh -c` when zsh is on PATH (it reads
  `~/.zshenv` non-interactively, so a session gets the user's current environment, not the
  spawner's frozen pm2 snapshot), else `sh -c`. Never inline `sh -c` for a session again.
- The zsh form is prefixed `setopt no_multios clobber;`. Without it `2>&1 1>/dev/null | sed`
  leaks pi's whole RPC event stream into the logs (MULTIOS) and `>> log` fails when the log
  does not exist yet (NOCLOBBER). Tests must run the real builder strings through the chosen
  shell, not only compare argv.
- `~/.zshenv` must be env-only: its exports win over what the spawner passes, and an alias,
  function, `cd` or `setopt` there changes the commands and the cwd. Do not set
  `PI_BRIDGE_DIR`, `PI_HTTP_PORT` or `PI_HTTP_HOST` in it.
- pi's discovery `pid` is `process.ppid`, the session shell and process-group leader;
  `kill-session`, reload and dedup signal `-pid`. Keep the shell as the leader.
- Quote every user-derived value (`--name`, ids, paths) with `shQuote`; a double-quoted
  interpolation lets `$(...)` run.

## Hub shell state (reactive store)

View-state (`sessions`, `activeSessionId`, `hubState`) lives in `packages/hub/public/store.js`.
**Mutate only via `setState()`**: a direct assignment desyncs the store from the local
aliases. `chat.js`'s streaming render is deliberately NOT store-driven (high-frequency;
would regress scroll/focus/perf): only turn-boundary/busy flags go through the store.
Extend the store rather than adding a framework.

## One owner, not N call sites

A side-effect repeated across call sites (`classList.toggle("hidden")`, `scrollTop =`,
`.abort(); x = null`, `alert(...)`, a re-render call) is a latent bug: forget one and it
desyncs or leaks. Before adding one, grep it: if it already appears at 3+ sites, route
through the single owner instead of adding a copy. An owner is a gated module or store
subscriber, not a helper callers must remember to call. Exemplars: `scroll-follow.js`,
the store subscriber, `overlay-manager.js`, `api.js` `readSseEvents`. Known debt (fix
when already in the area): `hub-app.js` AbortController swaps, `activeStreaming` writes
and `alert()` boilerplate; `app.js` header writes and modal show/hide.

## Hub cron

Scheduled `pi -p` jobs. Files live under `BRIDGE_DIR/cron/`, outside git: `cron-jobs.json`
(hand-edited, hub reads only), `runs/<runId>/` (`run.json`, `out.log`, `exit`),
`scheduler.lock`. Logic is split: pure decisions in `cron.js`, filesystem and spawn in
`cron-runner.js`, DOM in `public/cron-panel.js`, wiring only in `server.js`.

- The hub is the only writer of `run.json`. The run wrapper (`zsh -c`, built in
  `session-spawn.js`) deletes its own discovery file after pi exits and writes `exit`
  atomically; `run.json` is reconciled from it, so a hub restart mid-run is safe.
- One scheduler owner per `BRIDGE_DIR` via `scheduler.lock` (heartbeat, take then confirm on
  the next tick). A hub that is not the owner only reads: it neither ticks nor reconciles nor
  accepts Run now.
- Every slot becomes a `run.json`, including `skipped`; the run with the greatest
  `scheduledFor` is the baseline that keeps a slot consumed, so retention never prunes it
  and never prunes an active run. Retention removes run directories only, never session jsonl.
- "Active run" has one definition (`isActiveRun`), used by decide, manual trigger, Open and
  retention. `unknown` means no verdict from the wrapper (it vanished through reload, Close or
  a crash, never recorded a pid, or ran past max runtime); a late `exit` upgrades it.
- Open (resume) goes through the existing `open-session`; the panel decides from live state
  and server-computed fields, never from run state alone.
- Edit `cron-jobs.json` atomically (temp file + rename). The hub rereads it every tick and
  its per-job `error` in `GET /api/cron/jobs` is the verdict (validation, or a failure in the
  last tick); the rules live in `validateJob`, don't copy them elsewhere.
- A bad config degrades, it does not stop the hub: a bad file skips the tick (logged once),
  a bad job is not scheduled and shows its error, a job needs `enabled: true` to fire.

## Gotchas

- **Model switching**: pi's `setModel` also writes the GLOBAL default model
  (settings.json), so switching in any session changes the default for new sessions.
  E2E tests must restore it.
- **Session tree**: history follows the ACTIVE branch (`sessionManager.getBranch()`),
  not a linear JSONL read. `navigateTree` only exists on the command context, so
  navigation is `branch(targetId)` + a `webui-tree-nav` custom entry (resume derives the
  leaf from the LAST file entry) + the `⟳` reload. Clients wait for the respawned bridge
  via a `startedAt` watermark; the hub also waits out its vanish/re-select self-heal
  before rendering the confirmation. The reloaded process loads the
  DEPLOYED extension, so tree switching only fully works after deploy.
- **Overlays** (subagent view, file view, tree, model picker): go through
  `overlay-manager.js` (`open`/`closed`), never pairwise closes. The subagent view is a
  hide/show overlay on a sibling element; never snapshot/wipe `#messages`, the live
  render pointers live there.
- **History paging**: render loads fetch only the latest turn-aligned page
  (`/api/history?limit&align=turn`, response has `start`); older entries come from the
  "Load earlier" button via `before=<start>`. An old bridge ignores the params and
  returns everything, which degrades to a full render. Tests: `paginateHistory` in
  `helpers.test.js`, plus `scripts/e2e-history-paging.mjs`.
- **Re-attach replays the turn**: a web-initiated turn's events are buffered on the
  bridge for the whole turn and replayed per joiner on `/api/stream/attach`. Buffer
  resets at `agent_start`. `GET /api/stream/attach` answering 409 is benign (idle, nothing
  buffered); it is probed on every session init.
- **Queued messages**: hub-side in-memory FIFO per session (no persistence). A message
  leaves the queue when its turn STARTS; a failed dispatch is put back and pauses the queue.
- **Hub addressing**: `/s/<id>/api/...`; the shell hands components a session-scoped
  fetch. Switching aborts the old session's streams and ignores stale events. The header
  busy state tracks the polled `/api/sessions` value.
- **SSE fan-out**: the bridge broadcasts turn events to any number of viewers
  (`sse-broadcast.js`). Don't reintroduce a single-slot stream variable (it caused attach
  ping-pong between tabs). One client's write failure evicts only that client; `done`
  closes all.
- **recover-race**: `recoverStaleSessions` claims a discovery file by atomic rename before
  respawning, so concurrent startups don't multiply a stale session. Keep the claim atomic.
- **Sidebar layout** persists in `hub-state.json` (`/api/hub-state`). Its logic in
  `hub-state-logic.js` is shared by server and browser, so keep it pure (no Node APIs).
- **Manual abort** finalizes the turn immediately (`noteAbortRequested`) so a post-Stop
  reattach can't replay the stopped turn.
- **Notifications** are page-driven (Web Notification API); the active session is
  focus-gated, background sessions are not. No service worker / server push.

## Operational state

- Hub entry point `http://localhost:8730` (LAN too); bridges are also reachable on their
  own ports.
- PM2: `pi-webui-hub` runs from the dev repo; `pm2 save` done, `pm2 startup` NOT run (no
  auto-start on reboot).
- The hub is otherwise stateless (sessions from discovery files, history from pi's JSONL,
  busy + queues in memory). Add persistence only when a feature needs it, smallest tool
  first: a JSON file, never SQLite.
