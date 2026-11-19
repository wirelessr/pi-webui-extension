# pi-webui-telegram

Drive pi sessions from Telegram. A long-polling bot that talks only to the hub's
HTTP API (`/api/sessions`, `/api/events`, `/s/<id>/api/*`); no public endpoint.

## Run

```bash
export TELEGRAM_BOT_TOKEN=...   # from BotFather
export TELEGRAM_CHAT_ID=...     # your private chat id: the only chat obeyed
pm2 start packages/telegram/ecosystem.config.cjs
# or ad hoc:
node packages/telegram/src/server.js
```

PM2 caches env: after changing the variables, `pm2 delete pi-webui-telegram`
then start again. Run exactly one instance per token (a second poller gets 409).

## Config

- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (required).
- `PI_HUB_URL` (default `http://127.0.0.1:8730`).
- `PI_BRIDGE_DIR`: where `telegram-state.json` (selected session) is kept.
- `TELEGRAM_NOTIFY`: `selected` (default) or `all`: which sessions push a
  completion message for turns not started from Telegram (e.g. from the web UI).

## Usage

- Plain text goes to the selected session only (see `*` in `/sessions`); the
  reply is prefixed with `[session name]` when the turn finishes. If the session is already busy, the text is injected as a steer.
- `/sessions` pick a session, `/new [cwd]`, `/status`, `/stop`, `/rename <name>`,
  `/kill` (asks for confirmation).
- With exactly one live session and nothing selected, that session is used.

## Security

The bot is a remote shell for your machine. Updates are accepted only when both
the chat id and the sender id equal `TELEGRAM_CHAT_ID`; everything else is
dropped silently. It reaches the hub over localhost; do not expose the hub for it.

## Known limits

- Markdown is converted to Telegram HTML (bold, italic, code, links, quotes;
  headings become bold, tables go in a monospace block). If Telegram rejects a
  chunk it is resent as plain text.
- Progress: tool calls appear in one message per group, edited in place at most
  every 1.5 s (`[run]`/`[ok]`/`[err]`); each assistant text block is sent as it
  completes. Thinking and tool output are not shown.
- If the prompt stream drops mid-turn, the result arrives via the completion
  notification only if the hub's ~2 s busy poll saw the turn.
- Turns shorter than the duplicate window (15 s) that finish on the web UI right
  after a Telegram turn on the same session may not notify.
