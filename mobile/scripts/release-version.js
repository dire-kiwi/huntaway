#!/usr/bin/env node
// Gives app.json a release's version: `node scripts/release-version.js 1.2.3[-rc.1] [--ios]`, run by the release
// workflows before they build. The repository keeps 1.0.0, so a dev build doesn't need a version bump.
//
// Android installs an update only over a lower versionCode, so it comes from the version itself rather than a counter:
// major × 10⁷ + minor × 10⁵ + patch × 10³, plus 999 for a release or the prerelease's last number (rc.2 → 2), which
// puts 1.2.3-rc.2 after 1.2.3-rc.1 and before 1.2.3. Prereleases with other names order by that number alone.
// iOS (--ios) only takes numbers in its version (CFBundleShortVersionString), so a prerelease gets its release's version
// there; EAS counts the build numbers (eas.json's appVersionSource "remote").
const fs = require("node:fs");
const path = require("node:path");

function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!m) throw new Error(`${version} isn't a semver version`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

function versionCode(version) {
  const { major, minor, patch, pre } = parse(version);
  if (minor > 99 || patch > 99) throw new Error(`${version}: the minor and patch versions must be below 100 for Android's versionCode`);
  let build = 999;
  if (pre !== null) {
    const nums = pre.split(".").filter((p) => /^\d+$/.test(p));
    build = Math.min(nums.length ? +nums[nums.length - 1] : 0, 998);
  }
  const code = major * 10_000_000 + minor * 100_000 + patch * 1000 + build;
  // Google Play's limit, which Android itself doesn't have, but an APK may end up there.
  if (code > 2_100_000_000) throw new Error(`${version}: the major version is too high for Android's versionCode`);
  return code;
}

function iosVersion(version) {
  const { major, minor, patch } = parse(version);
  return `${major}.${minor}.${patch}`;
}

module.exports = { parse, versionCode, iosVersion };

if (require.main === module) {
  const [version, flag] = process.argv.slice(2);
  if (!version || (flag && flag !== "--ios")) {
    console.error("usage: release-version.js <version> [--ios]");
    process.exit(2);
  }
  const file = path.join(__dirname, "..", "app.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const expo = config.expo;
  expo.version = flag === "--ios" ? iosVersion(version) : version.replace(/^v/, "");
  expo.android = { ...expo.android, versionCode: versionCode(version) };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(`app.json: version ${expo.version}, Android versionCode ${expo.android.versionCode}`);
}
