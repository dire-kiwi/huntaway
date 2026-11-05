#!/usr/bin/env bash
# Puts together a release's server (HA-174: the TypeScript server, with the Node that runs it), as the server tarball
# and the desktop app's resources carry it:
#
#   scripts/package-server.sh <out dir> [<node binary>]
#
#   <out dir>/huntaway          server-ts/bin/huntaway, which runs the server with the Node beside it
#   <out dir>/issue-agent       server-ts/bin/issue-agent, the name from before the rename, which runs huntaway
#   <out dir>/server-ts/        the server's code (src/ without tests), package.json, build.json and its node_modules
#   <out dir>/node/bin/node     <node binary> (default: the node on PATH), with Node's LICENSE
#   <out dir>/ia-shim           server/target/release/ia-shim (build it first: cargo build --release -p ia-shim)
#   <out dir>/ui/               app/dist (build it first: npm run build in app/)
#
# VERSION sets the version server-ts/package.json gives (what `huntaway --version` prints); IA_BUILD_COMMIT the commit
# it reports (default: HEAD). Nothing in it is a symbolic link, which installing a release refuses (update/staging.ts).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out=${1:?usage: $0 <out dir> [<node binary>]}
node_bin=${2:-$(command -v node)}
[[ -x $node_bin ]] || { echo "no node at $node_bin" >&2; exit 1; }
[[ -x $root/server/target/release/ia-shim ]] || { echo "build ia-shim first: cargo build --release -p ia-shim in server/" >&2; exit 1; }
[[ -f $root/app/dist/index.html ]] || { echo "build the UI first: npm run build in app/" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/server-ts" "$out/node/bin"
cp "$root/server-ts/bin/huntaway" "$out/huntaway"
cp "$root/server-ts/bin/issue-agent" "$out/issue-agent"
cp "$root/server/target/release/ia-shim" "$out/ia-shim"
cp -R "$root/app/dist" "$out/ui"

# The code without its tests (and the test helpers' fixtures).
(cd "$root/server-ts" && find src -type f -name '*.ts' ! -name '*.test.ts') | while read -r f; do
  mkdir -p "$out/server-ts/$(dirname "$f")"
  cp "$root/server-ts/$f" "$out/server-ts/$f"
done
cp "$root/server-ts/package.json" "$root/server-ts/package-lock.json" "$out/server-ts/"
if [[ -n ${VERSION:-} ]]; then
  node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    p.version = process.argv[2]; fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n")' "$out/server-ts/package.json" "$VERSION"
fi
commit=${IA_BUILD_COMMIT:-$(git -C "$root" rev-parse HEAD)}
printf '{"commit": "%s"}\n' "$commit" > "$out/server-ts/build.json"
(cd "$out/server-ts" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -rf "$out/server-ts/node_modules/.bin"

cp "$node_bin" "$out/node/bin/node"
chmod 755 "$out/node/bin/node" "$out/huntaway" "$out/issue-agent"
node_dir=$(dirname "$(dirname "$(readlink -f "$node_bin")")")
[[ -f $node_dir/LICENSE ]] && cp "$node_dir/LICENSE" "$out/node/LICENSE"

links=$(find "$out" -type l)
[[ -z $links ]] || { echo "the package has symbolic links, which installing a release refuses:" >&2; echo "$links" >&2; exit 1; }
echo "packaged huntaway $("$out/huntaway" --version | awk '{print $2}') (node $("$out/node/bin/node" --version)) in $out"
