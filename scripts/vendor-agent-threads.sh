#!/usr/bin/env bash
# Builds agent-threads' TypeScript packages (the protocol and the React components) at a commit and
# puts them in app/vendor/agent-threads, which app/package.json depends on (`file:`). agent-threads
# doesn't publish its packages yet, and Huntaway's CI, install.sh and release builds use npm without
# a checkout of it, so the built packages are kept in this repository.
#
#   scripts/vendor-agent-threads.sh [<commit>] [--from <checkout or URL>]
#
# The commit defaults to the one server/Cargo.toml pins the crate at, so the UI and the server speak
# the same protocol. Bump both together: change the pin, run this, then `npm install` in app/ (which
# updates package-lock.json with the new versions) and commit app/vendor with them. Needs git, pnpm
# and Node.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
from=https://github.com/dire-kiwi/agent-threads
rev=
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from=$2; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) rev=$1; shift ;;
  esac
done
if [ -z "$rev" ]; then
  rev=$(sed -n 's/^agent-threads = .*rev = "\([0-9a-f]*\)".*/\1/p' "$root/server/Cargo.toml")
  [ -n "$rev" ] || { echo "no agent-threads rev in server/Cargo.toml: give one" >&2; exit 1; }
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q "$from" "$work/src"
git -C "$work/src" checkout -q "$rev"
rev=$(git -C "$work/src" rev-parse HEAD)
short=${rev:0:9}
(cd "$work/src/ts" && pnpm install --frozen-lockfile --silent && pnpm --filter @dire-kiwi/agent-threads-protocol --filter @dire-kiwi/agent-threads-react build) >&2

out="$root/app/vendor/agent-threads"
rm -rf "$out"
mkdir -p "$out"
for pkg in protocol react; do
  src="$work/src/ts/packages/$pkg"
  mkdir -p "$out/$pkg"
  # Without the source maps: they point at sources that aren't here.
  (cd "$src" && find dist -type f ! -name '*.map' -exec cp --parents {} "$out/$pkg/" \;)
  find "$out/$pkg/dist" -name '*.js' -exec sed -i '/^\/\/# sourceMappingURL=/d' {} +
  find "$out/$pkg/dist" -name '*.d.ts' -exec sed -i '/^\/\/# sourceMappingURL=/d' {} +
  # The version says which commit it's from; the React package's workspace:* dependency on the
  # protocol becomes the copy beside it.
  node -e '
    const fs = require("fs");
    const [file, out, version] = process.argv.slice(1);
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    const keep = { name: p.name, version, description: p.description, license: p.license, repository: p.repository, type: p.type, exports: p.exports, sideEffects: p.sideEffects };
    if (p.dependencies) keep.dependencies = Object.fromEntries(Object.entries(p.dependencies).map(([k, v]) => [k, v.startsWith("workspace:") ? "file:../protocol" : v]));
    if (p.peerDependencies) keep.peerDependencies = p.peerDependencies;
    for (const k of Object.keys(keep)) if (keep[k] === undefined) delete keep[k];
    fs.writeFileSync(out, JSON.stringify(keep, null, 2) + "\n");
  ' "$src/package.json" "$out/$pkg/package.json" "0.0.0-$short"
done
cp "$work/src/LICENSE" "$out/LICENSE"
cat > "$out/README.md" <<EOF
# agent-threads' packages, built

\`@dire-kiwi/agent-threads-protocol\` and \`@dire-kiwi/agent-threads-react\` from
[agent-threads](https://github.com/dire-kiwi/agent-threads) at \`$rev\`, built by
\`scripts/vendor-agent-threads.sh\` (which says how to move to another commit). Don't edit them here:
change agent-threads, then build them again.
EOF
echo "$rev" > "$out/REV"
echo "app/vendor/agent-threads: agent-threads $rev" >&2
