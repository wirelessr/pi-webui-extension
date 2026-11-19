// PM2 config for the pi WebUI Telegram bot.
//   pm2 start ecosystem.config.cjs
//   pm2 logs pi-webui-telegram
//
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment PM2 is
// started from (PM2 caches env: after changing them use
// `pm2 delete pi-webui-telegram && pm2 start ecosystem.config.cjs`).
module.exports = {
  apps: [
    {
      name: "pi-webui-telegram",
      script: "src/server.js",
      cwd: __dirname,
      // Only one poller per bot token may run; never start a second instance.
      instances: 1,
      env: {
        PI_HUB_URL: "http://127.0.0.1:8730",
      },
    },
  ],
};
