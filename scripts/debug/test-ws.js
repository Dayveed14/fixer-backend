// scripts/debug/test-ws.js — manual MeshCentral connectivity check.
// Run: MESHCENTRAL_WS_URL=wss://your-mesh-host/control.ashx node scripts/debug/test-ws.js
// Not used by the app. TLS verification is ON unless MESH_INSECURE_TLS=1
// (only for a self-signed test server).
// This talks to MeshCentral's control websocket directly, without going
// through meshctrl.js's generic error handler, so we can see the real
// error code instead of the generic "Unable to connect" message.

const WebSocket = require("ws");

const url = process.env.MESHCENTRAL_WS_URL;
if (!url) {
  console.error("Set MESHCENTRAL_WS_URL first.");
  process.exit(1);
}

const ws = new WebSocket(url, {
  rejectUnauthorized: process.env.MESH_INSECURE_TLS !== "1",
});

ws.on("open", () => {
  console.log("CONNECTED — the websocket handshake succeeded.");
  ws.close();
});

ws.on("error", (err) => {
  console.log("ERROR CODE:", err.code);
  console.log("ERROR MESSAGE:", err.message);
  console.log("FULL ERROR:", err);
});

ws.on("close", (code, reason) => {
  console.log("CLOSED — code:", code, "reason:", reason?.toString());
});

setTimeout(() => {
  console.log("Timed out after 10s with no open/error/close event.");
  process.exit(1);
}, 10000);
