// The desktop app's shell stamp: a hash of this directory and the Electron version that runs it. main.cjs relaunches
// when it changes on disk, and .github/workflows/release.yml puts a release's in its manifest, so an installed app can
// tell whether a newer release changed the shell or only the server and the UI. The same files give the same stamp
// from a checkout and from inside a packaged app's app.asar.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The sha256 (hex) over the sorted files of `dir` (each one's name, then its contents), then `electronVersion`. */
function shellStamp(dir, electronVersion) {
  const hash = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).sort()) hash.update(f).update(fs.readFileSync(path.join(dir, f)));
  if (electronVersion) hash.update(electronVersion);
  return hash.digest("hex");
}

module.exports = { shellStamp };
