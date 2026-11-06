// Semver precedence, as the desktop app's electron/versions.cjs and the server's release checks use.

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `v` as [major, minor, patch] and its prerelease identifiers, or null when it isn't semver. */
function parseVersion(v: string): [number[], string[]] | null {
  const m = v.trim().match(SEMVER);
  return m ? [[Number(m[1]), Number(m[2]), Number(m[3])], m[4] ? m[4].split(".") : []] : null;
}

/** Semver precedence of two versions (negative, 0 or positive), or NaN when either isn't semver. 1.0.0-rc.1 < 1.0.0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[0][i] !== y[0][i]) return x[0][i] - y[0][i];
  const [p, q] = [x[1], y[1]];
  // A release is above its prereleases.
  if (!p.length || !q.length) return q.length - p.length;
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const [n, m] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    // Numeric identifiers compare as numbers, and below alphanumeric ones.
    if (n && m) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return p.length - q.length;
}
