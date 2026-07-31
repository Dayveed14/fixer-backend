// test-ws.js
// Run: node test-ws.js
// This talks to MeshCentral's control websocket directly, without going
// through meshctrl.js's generic error handler, so we can see the real
// error code instead of the generic "Unable to connect" message.

const WebSocket = require("ws");

const ws = new WebSocket("wss://52.90.170.251/control.ashx", {
  rejectUnauthorized: false,
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
