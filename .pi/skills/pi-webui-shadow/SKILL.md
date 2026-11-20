---
name: pi-webui-shadow
description: "Verify pi-webui hub, extension, session-spawn or cron behavior against real pi in an isolated shadow environment (a separate test hub, separate bridge directory, throwaway sessions) without touching the user's live hub, sessions or data. Use before claiming a hub/extension/cron/spawn change works, when reproducing a bug live, when running scripts/e2e-*.mjs, or whenever a test needs a real pi session. Not for driving the user's live hub and not for unit tests."
---

# Shadow environment for pi-webui verification

A shadow is a second hub process plus its own bridge directory. Real pi sessions started inside it are throwaway. The user's live hub (default port 8730), live sessions and live `data/` directory are never read, written or killed from here. The rules in `CLAUDE.md` ("Verifying against real behavior") are the principles; this page is the procedure.

## Invariants

The never-touch-live and recorded-pids-only rules are in `CLAUDE.md` ("Verifying against real behavior"); they apply to every step below. What is specific to a shadow:

- Everything lives under one isolated directory `$ISO`. Hub, discovery files, cron data, logs and evidence all point there through `PI_BRIDGE_DIR=$ISO`.
- The shadow hub binds `127.0.0.1` on a spare port (default `8799`; confirm it is free first), and its sessions search for ports from their own spare base, never the live range.
- Live sessions run as `tail -f /dev/null | pi ...` and look identical to throwaway ones, so nothing is ever found by searching the process table; record what you start.

## Start a shadow hub

1. `ISO=$(mktemp -d /tmp/pi-shadow.XXXXXX)` (a fixed parent keeps the path predictable; on macOS sessions see it as `/private/tmp/...`, and their session directory is named after that form); pick a port and prove it is free: `lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing. A leftover process on the port answers your requests with the wrong data and is easy to mistake for yours.
2. Decide which `~/.zshenv` the sessions read. Sessions start through `zsh -c`, whose exports win over the env you pass. By default isolate it: `ZDOTDIR=$ISO/zdot` with an empty (or sentinel-only) `.zshenv`. Use the user's real `~/.zshenv` only when the test needs the credentials it exports (as `scripts/e2e-cron.mjs` does), and first check, names only, that it does not export `PI_BRIDGE_DIR`, `PI_HTTP_PORT` or `PI_HTTP_HOST`: `grep -nE '^[[:space:]]*(export[[:space:]]+)?PI_(BRIDGE_DIR|HTTP_PORT|HTTP_HOST)=' ~/.zshenv`. A match would send shadow sessions to the live directory, onto one shared port, or onto the LAN; stop. `/etc/zshenv`, if present, is still read.
3. Build a minimal environment with `env -i`: `HOME`, `USER`, `PATH`, `LANG`, `ZDOTDIR` (when isolating), plus the names of credentials the test needs (for example the model provider key), passed through only when set in your environment. Find which exist by listing variable names only (`env | cut -d= -f1`), never values. If a required one is missing, stop and say so.
4. From the repo root, start it so that `$!` is the node process: `env -i ... PI_HUB_PORT=<port> PI_HUB_HOST=127.0.0.1 PI_HTTP_HOST=127.0.0.1 PI_HTTP_PORT=<spare base> PI_BRIDGE_DIR=$ISO nohup node packages/hub/src/server.js > $ISO/hub.log 2>&1 &` and `echo $! > $ISO/hub.pid`. `PI_HTTP_HOST` keeps the sessions' bridges off the LAN (by default they bind all interfaces); `PI_HTTP_PORT` is the base port sessions search upward from (default 7331, where the user's live sessions are), so give the shadow its own range such as 18331. The sessions inherit both from the hub's environment. Writing `cd x && cmd &` backgrounds the whole list, so `$!` is a subshell and the hub survives your kill.
5. Prove it: `lsof -nP -iTCP:<port> -sTCP:LISTEN` shows exactly the recorded pid, and `GET /api/sessions` answers `{"sessions":[]}`. If the hub log shows `EADDRINUSE`, your hub did not start; whatever answers is something else.

## Real pi sessions inside the shadow

- `POST /api/new-session {"cwd": "<dir under $ISO>"}` on the shadow hub; find the new entry in `GET /api/sessions` (new port). Record the session id and the pid reported by `new-session` (the wrapping shell and process group leader).
- A new session starts on the default model of the user's `settings.json` only if that provider's credentials are available to it (the shadow's environment, or pi's own auth file under `HOME`); otherwise it may fall back to another provider. Read `GET /s/<id>/api/status` for the model it really has, then set the one you want with `POST /s/<id>/api/model` (`provider`, `id`). Compare `settings.json` before and after and restore the default model if it changed (switching may write it).
- A model id listed by `pi --list-models` can still be rejected by the provider (for example a 404 model-not-found). `api/model` answers ok and the session shows the model; the failure only appears after a prompt, as an assistant message with `stopReason: error` in the session jsonl while `history` looks empty. Prove a model with a one-line prompt before building a test on it, and read the jsonl on a silent failure.
- Prompt with `POST /s/<id>/api/prompt` and body `{"message": "...", "stream": true|false}`. Without `stream` the call returns when the whole turn is done (`{text, toolCalls, ...}`), and a short client timeout drops the connection while the turn keeps running. For anything over a minute use `stream: true`, kept open in the background; poll status and history instead of waiting on the connection.
- To check what environment a session has, ask the session to run `printenv NAME >/dev/null && echo SET || echo UNSET` with its bash tool. `ps eww` does not work: pi rewrites its own process title.
- To prove which environment a session gets, give the isolated `ZDOTDIR/.zshenv` a sentinel export and check it with the bash-tool probe above.

## Extension and spawn changes

Sessions that a shadow hub starts load the **deployed** extension (the spawn command is plain `pi --mode rpc`), so a shadow hub cannot verify an `index.ts` change. For that:

1. From the repo root build the flat layout into a fresh directory inside `$ISO`: `node scripts/build-dist.mjs 0.0.0-shadow $ISO/ext`, then `npm install --omit=dev` in `$ISO/ext`. The script empties the target (except `data/`) and uses repo-relative paths: never point it at the repo, at `$ISO` itself, or at the live extension directory.
2. No hub is needed. Start pi detached so its shell is the process-group leader, through `zsh -c` like real sessions (so `ZDOTDIR` applies; `sh -c` would skip `.zshenv`), for example a Node `spawn("zsh", ["-c", "tail -f /dev/null | pi --mode rpc --no-extensions -e $ISO/ext/index.ts --model <provider>/<model-id>"], {detached: true, stdio: "ignore", cwd: <dir under $ISO>, env})` (write the absolute path of `$ISO` into the string; the shell does not know it), with the `env -i` style environment from Start plus `PI_BRIDGE_DIR=$ISO`, `PI_HTTP_HOST=127.0.0.1`, `PI_HTTP_PORT=<spare port>` and `ZDOTDIR`. Record the child's pid: it is the process-group id (the group has three members: the shell, `tail`, `pi`).
3. Talk to it directly on its port (from its discovery file in `$ISO`; the `url`/`lanIp` fields there show the LAN address even when the bind is loopback, ignore them). `POST /api/kill-session {"pid": <recorded pid>}` on that bridge is the clean stop. The live extension is untouched.

For hub spawn paths, compare red (a base worktree or the unfixed tree) and green on the same probe.

## Cron in a shadow

- Scheduler logic with a fake pi: `PI_CRON_PI_BIN=<stub>` and a short `PI_CRON_TICK_MS`; a stub avoids model cost and makes exits deterministic.
- Real pi end to end: `node scripts/e2e-cron.mjs`, run from the repo root. Run the Start step 2 `~/.zshenv` check first (the script reads the real file and does not isolate it). It needs `FIREWORKS_API_KEY` in the environment (whatever `E2E_CRON_MODEL` is), `pi` and `zsh` on PATH, and a Chrome (macOS default path, `CHROME` overrides). It deliberately reads the user's real `~/.zshenv`, starts its own shadow, drives the Cron panel in a headless browser, and cleans up after itself.
- The shadow's cron files live under `$ISO/cron/`. A freshly started hub needs one or two ticks to take the scheduler lock; recheck before concluding anything.

## UI and behavior reproductions

Headless-browser scripts print a machine-checkable verdict, red before the fix and green after: templates `scripts/repro-queue-scroll.mjs`, `scripts/e2e-history-paging.mjs`, `scripts/e2e-cron.mjs` (self-cleaning, raw CDP, no-op `alert()` before driving).

## Evidence

Keep `$ISO` (hub log, bridge log, run records, screenshots) after the run and print its path. Evidence lets someone else check the claim; delete it only when the user asks.

## Cleanup (every time, success or failure)

1. Close sessions through the shadow hub: `POST /s/<id>/api/kill-session {"pid": <recorded pid>}` ends the whole process group (including its `tail -f /dev/null`) and removes the discovery file. A plain `kill -TERM -- -<recorded pgid>` ends the group but keeps the discovery file for auto-recovery, and the next pi that starts with `PI_BRIDGE_DIR=$ISO` would respawn that session as an unrecorded process: delete `$ISO/<recorded session id>.json` (and any `.recovering` file) before starting anything else in `$ISO`. Close any background `curl` you left open for streaming; stop the shadow hub by its recorded pid. Add stragglers (a session's own process group) to the record as you discover them from files in `$ISO`, not from searching the process table.
2. Prove the result, read-only: every recorded pid is gone and `ps -g <pgid>` shows no members, the shadow port is not listening, and `$ISO` holds no `<recorded id>.json` or `.recovering` file.
3. List the session files you created, then delete exactly those; remove the project directory they lived in if it is now empty. Session files are not under `$ISO`: they sit in `~/.pi/agent/sessions/--<cwd with slashes as dashes>--/<timestamp>_<id>.jsonl`. Find them by the recorded id (`find ~/.pi/agent/sessions -name '*<id>*.jsonl'`, read-only). Never diff the whole sessions directory: the user's live sessions write there too. If you diff, restrict it to the shadow cwd's own project directory, and still delete by recorded id.
4. Restore anything global you changed (default model) and verify it.
5. Report what was started, what was stopped, what was deleted, and what was kept.

## Traps that already cost time

- `cd x && cmd &` then `$!`: wrong pid, hub not killed (see Start).
- An old shadow still on the port: new hub dies with `EADDRINUSE`, requests hit the old one.
- `ps eww` for a pi's environment: empty, because of the rewritten title.
- Counting `tail -f /dev/null` processes as leaks: live sessions have them.
- Sessions are detached from the hub that started them, so stopping or restarting a shadow hub leaves its sessions running; stop them yourself.
- A group kill that skips `kill-session` leaves a discovery file that revives the session later (see Cleanup).
- The sandbox `$TMPDIR` may differ from the real one; build isolated directories where the sessions can see them.
- `setsid` does not exist on macOS; use `nohup`.
