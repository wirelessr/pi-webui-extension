// PM2 config for the pi WebUI hub.
//   pm2 start ecosystem.config.cjs
//   pm2 logs pi-webui-hub
//
// PI_BRIDGE_DIR defaults to ~/.pi/agent/extensions/pi-webui-extension/data
// (where the per-session extension writes discovery files). Override it here
// if your extension uses a different PI_BRIDGE_DIR.
module.exports = {
  apps: [
    {
      name: "pi-webui-hub",
      script: "src/server.js",
      cwd: __dirname,
      env: {
        PI_HUB_PORT: "8730",
      },
    },
  ],
};
