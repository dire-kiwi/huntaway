// The desktop app's stamps. The shell stamp is a hash of this directory and the Electron version that runs it: main.cjs
// relaunches an app run from a checkout when it changes on disk. The frame stamp covers only what a release can't
// update in place (boot.cjs, see there, and Electron): .github/workflows/release.yml puts a release's in its manifest, so
// an installed app can tell whether a newer release needs a new package or only changes the server, the UI and the
// rest of the shell. The same files give the same stamp from a checkout and from inside a packaged app's app.asar.

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

/** The files an installed app can't take from a release: boot.cjs loads the rest from the release's own electron/. */
const FRAME_FILES = ["boot.cjs"];

/**
 * The stamp of what an update can't change in place: the frame (boot.cjs) and `electronVersion`. This is what a release's
 * manifest records and what the server compares to say that the app needs a new package; the rest of the shell updates
 * with the server (boot.cjs).
 */
function frameStamp(dir, electronVersion) {
  const hash = crypto.createHash("sha256");
  for (const f of FRAME_FILES) hash.update(f).update(fs.readFileSync(path.join(dir, f)));
  if (electronVersion) hash.update(electronVersion);
  return hash.digest("hex");
}

module.exports = { shellStamp, frameStamp, FRAME_FILES };
