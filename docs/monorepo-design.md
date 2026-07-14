# pi-webui monorepo — design

Status: proposed. Target branch: `refactor/monorepo`. Developed in a git
worktree at `~/Workdir/pi-webui-monorepo`; the live extension at
`~/.pi/agent/extensions/pi-webui-extension` stays on `main` and untouched
until a deliberate cutover (see §10).

## 1. Goal

Add an optional central **hub** service that is the single browser-facing
entry point and can notify / stream across all sessions, without navigating
between per-port pages. Keep the existing per-session mode working. Let the
shared frontend and the extension **co-evolve** in one repo.

## 2. Hard constraint that shapes everything

The extension runs **inside each pi session process**. `pi.sendUserMessage`
and the `agent_start/agent_end/message_update` events are only reachable
**in-process**. A separate hub process cannot drive another session's agent
directly — so every session keeps its own in-process bridge, and the hub is a
**reverse proxy + aggregator** in front of them, not a replacement.

Second constraint: the extension is loaded by **living in the directory**
`~/.pi/agent/extensions/pi-webui-extension/` (in-place `node_modules`). The
deployed extension dir must be a self-contained, loadable extension — it is
not the monorepo root. See §10.

## 3. Target architecture

```
                          ┌ pi session A (proc) ─ in-proc bridge :7331 ─ pi API/events
browser ─ single entry ─ hub ┼ pi session B (proc) ─ in-proc bridge :7332 ─ pi API/events
        (SPA + proxy)         └ pi session C (proc) ─ in-proc bridge :7333 ─ pi API/events
```

- **Per-session bridge** (unchanged backend contract): serves `/api/*` +
  SSE for its own session. Discovery files in `data/` advertise
  `{port, sessionId, sessionName, pid, cwd}`.
- **Hub**: reads discovery files, reverse-proxies `/api/*` to the right
  session, multiplexes each session's SSE tagged by session id, serves ONE
  SPA that switches active session in-page (no navigation → SSE survives →
  cross-session notifications possible), PM2-managed.
- **Two modes, user's choice** (from the hub being additive, not from the
  monorepo): extension only = per-session; extension + hub = central.

## 4. Packages (npm workspaces)

```
pi-webui-monorepo/            (repo root; private; workspaces: packages/*)
  packages/
    components/               @wirelessr/pi-webui-components  — shared browser + pure modules
    extension/                pi-webui-extension              — in-process pi bridge (Node/Hono)
    hub/                      pi-webui-hub                    — central service (new)
  docs/monorepo-design.md
```

Workspace tool: **npm workspaces** (repo already uses npm + package-lock;
no new tooling). Dev uses workspace linking so `components` resolves locally
without publishing.

## 5. File mapping (from today's flat repo)

`components` — everything the browser needs + pure modules shared with Node:

| file | note |
|---|---|
| index.html, style.css | WebUI shell + styles |
| app.js | standalone WebUI orchestrator (hub ships its own shell; see §11) |
| chat.js | rendering / streaming / tool+thinking+subagent blocks |
| stream-accumulator.js, sse-parser.js | pure SSE state + parse |
| markdown.js, utils.js | pure |
| parsers.js | pure, **node-safe** (also imported by the extension) |
| selection-state.js, ui-behaviors.js | pure decision helpers |
| input.js, commands.js, sessions.js | browser UI |
| qr.js, qrcode-lib.js, resize.js, mobile-nav.js | browser UI / vendored |
| flow.js, api.js | browser orchestration + fetch wrappers |

`extension` — Node backend:

| file | note |
|---|---|
| index.ts | extension entry (in-process pi bridge) |
| bridge-app.js | Hono routes |
| helpers.js | Node helpers (history/paginate/isPathSafe/usage/prompt-body); imports `parsers` from `@wirelessr/pi-webui-components` |
| session-helpers.js, name-generator.js | Node pure / fetch |

Tests move with their module's package. Coverage-gated modules split:
`stream-accumulator, selection-state, flow, ui-behaviors, api, utils,
sse-parser` → components CI; `session-helpers, name-generator` → extension CI
(each package's CI enforces its own 100%).

### 5.1 The parsers/helpers boundary

`helpers.js` is the ONLY `http-bridge-web/*` file imported by Node today
(by `index.ts` and `bridge-app.js`), and it re-exports `parsers.js`. Split:
`parsers.js` → components (pure, exported, node-safe); `helpers.js` → extension
and it does `import { … } from "@wirelessr/pi-webui-components/parsers"`.
So the backend's only components dependency is `parsers` + serving the static
WebUI assets in standalone mode.

## 6. components `exports` map

Expose clean subpaths (avoid deep node_modules reaching):

```json
{
  "name": "@wirelessr/pi-webui-components",
  "type": "module",
  "exports": {
    "./parsers": "./src/parsers.js",
    "./chat": "./src/chat.js",
    "./flow": "./src/flow.js",
    "./api": "./src/api.js",
    "./*": "./src/*"
  },
  "files": ["src"]
}
```

The extension imports `@wirelessr/pi-webui-components/parsers` (Node). Both
extension (standalone) and hub serve the browser files by resolving the
package dir and static-serving `src/` (see §10, §11).

## 7. Publish model — GitHub Packages

Only `components` is published (extension lives in a dir; hub runs via PM2).
Registry: **GitHub Packages** (`npm.pkg.github.com`), scoped
`@wirelessr/pi-webui-components`. Consumers need `.npmrc`:

```
@wirelessr:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Note: GitHub Packages requires a token to **install** even for public
packages. Acceptable — this is self-use; the one machine that hosts the
extension/hub has the token. Publish on release with `write:packages`.

## 8. How each consumer gets the browser assets

- **Extension (standalone / per-session)**: depends on
  `@wirelessr/pi-webui-components`; `bridge-app.serveStatic` resolves the
  package directory (e.g. `import.meta.resolve`) and serves `src/*.js`,
  `index.html`, `style.css`. Deployed extension dir runs `npm install` →
  pulls components from GitHub Packages.
- **Hub**: same dependency; serves its own SPA shell + the shared components.

## 9. CI

Root workspace CI runs each package's biome + `node --test` + coverage gate
(the gate splits across components/extension as in §5). Add a components
publish workflow (on tag) to GitHub Packages.

## 10. Cutover of the live extension dir (the part that affects usage)

Today `~/.pi/agent/extensions/pi-webui-extension` == the repo. After the
monorepo, the repo is the monorepo (dev, in `~/Workdir/...`), and the live
dir becomes a **deployed copy of `packages/extension`** — self-contained,
depending on published `components`.

Cutover (deliberate, user-timed, git-reversible):

1. Publish `@wirelessr/pi-webui-components@<v>` to GitHub Packages.
2. On the machine: add `~/.npmrc` with the GitHub Packages scope + token.
3. Replace the live dir contents with `packages/extension` (its
   `package.json` depends on components), keep `data/` (discovery files).
4. `npm install` in the live dir → pulls components.
5. Reload sessions when convenient. Running sessions keep old in-memory code
   until they reload; nothing breaks until the user chooses.
6. Rollback = restore the dir to `main` (git) + `npm install`.

Running sessions are never affected mid-development because all work happens
in the worktree; only this explicit cutover changes the live dir.

## 11. Frontend rework — reuse vs new

Reused largely as-is (event-driven / pure, source-agnostic): chat,
stream-accumulator, sse-parser, markdown, parsers, utils, selection-state,
ui-behaviors, input, commands, flow, api.

New/changed for the hub shell only:
- **In-page session switch** (no navigation → page + SSE survive).
- **Event multiplexing**: hub tags events by session id; shell dispatches to
  the active session's chat instance (and buffers/badges background ones).
- **Cross-session notification**: the single persistent page notifies for any
  session (fixes the current teardown-on-navigate gap).
- **api.js addressing**: current per-port `sessionUrl/navUrl` → hub routes by
  session id (e.g. `/s/<id>/api/...`). Kept generic in components; extension
  and hub configure the base.

The standalone `app.js` stays for per-session mode; the hub gets its own shell
composed from the same components.

## 12. Open decisions

- **D1 (blocks cutover, not dev): assets delivery.** §7/§8 assume components
  is a published GitHub Packages dep the deployed extension `npm install`s.
  Fallback if the token-in-live-dir friction is unwanted: a build step that
  bundles components into the extension's served dir (no registry). Decide
  before cutover; does not block building the monorepo.
- **D2: hub session addressing** — path prefix (`/s/<id>/…`) vs header/cookie
  active-session. Path prefix is simplest to proxy and debug.

## 13. Execution phases

1. Design doc (this). 
2. Workspaces root + extract `components` (move files + tests, exports map),
   keep biome/tests/coverage green.
3. Move backend into `packages/extension`, rewire `helpers`→components,
   serveStatic resolves components; verify standalone load.
4. Build `packages/hub` (proxy + multiplex + SPA shell + PM2).
5. Cutover (§10), user-timed.
