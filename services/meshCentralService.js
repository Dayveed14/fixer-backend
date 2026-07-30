const path = require("path");
const { execFile } = require("child_process");

// meshctrl.js is bundled inside the `meshcentral` npm package (it's the
// same CLI tool documented at docs.meshcentral.com/meshctrl). We shell out
// to it rather than reimplementing its login/websocket protocol ourselves.
const MESHCTRL_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "meshcentral",
  "meshctrl.js",
);

function runMeshctrl(args) {
  return new Promise((resolve, reject) => {
    // execFile (not exec) — args are passed as an array, never interpolated
    // into a shell string, so there's no command-injection surface here
    // even though some of these values ultimately trace back to config.
    execFile(
      "node",
      [MESHCTRL_PATH, ...args],
      { timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr?.trim() || error.message));
        }
        resolve(stdout.trim());
      },
    );
  });
}

/* ===========================
   GENERATE INVITE LINK
   Creates a time-limited link a customer can open to install a temporary
   MeshCentral agent into the configured device group. Once installed, the
   device shows up in the MeshCentral dashboard for the technician to
   remote into.
=========================== */
async function generateInviteLink({ hours = 2 } = {}) {
  const {
    MESHCENTRAL_URL,
    MESHCENTRAL_LOGIN_USER,
    MESHCENTRAL_LOGIN_PASS,
    MESHCENTRAL_DEVICE_GROUP_ID,
  } = process.env;

  if (
    !MESHCENTRAL_URL ||
    !MESHCENTRAL_LOGIN_USER ||
    !MESHCENTRAL_LOGIN_PASS ||
    !MESHCENTRAL_DEVICE_GROUP_ID
  ) {
    throw new Error(
      "MeshCentral is not configured. Set MESHCENTRAL_URL, MESHCENTRAL_LOGIN_USER, " +
        "MESHCENTRAL_LOGIN_PASS and MESHCENTRAL_DEVICE_GROUP_ID in .env.",
    );
  }

  const output = await runMeshctrl([
    "generateinvitelink",
    "--url",
    MESHCENTRAL_URL,
    "--loginuser",
    MESHCENTRAL_LOGIN_USER,
    "--loginpass",
    MESHCENTRAL_LOGIN_PASS,
    "--id",
    MESHCENTRAL_DEVICE_GROUP_ID,
    "--hours",
    String(hours),
  ]);

  // meshctrl's exact wording has shifted across versions, so rather than
  // matching specific text, pull the first URL out of whatever it prints.
  const match = output.match(/https?:\/\/\S+/);

  if (!match) {
    throw new Error(`Unexpected meshctrl output, no link found: ${output}`);
  }

  return match[0];
}

module.exports = { generateInviteLink };
