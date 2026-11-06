#!/usr/bin/env bash
# Puts together a release's server (HA-174: the TypeScript server, with the Node that runs it), as the server tarball
# and the desktop app's resources carry it:
#
#   scripts/package-server.sh <out dir> [<node binary>]
#
#   <out dir>/huntaway          apps/server/bin/huntaway, which runs the server with the Node beside it
#   <out dir>/issue-agent       apps/server/bin/issue-agent, the name from before the rename, which runs huntaway
#   <out dir>/server-ts/        the server's code (src/ without tests, compiled to .js), package.json, build.json and its
#                               production node_modules (the folder keeps its old name: installed releases look for it)
#   <out dir>/node/bin/node     <node binary> (default: the node on PATH; a shim's Node), with Node's LICENSE
#   <out dir>/ia-shim           target/release/ia-shim (build it first: cargo build --release -p ia-shim)
#   <out dir>/ui/               apps/web/dist (build it first: pnpm --filter huntaway-app build)
#
# Needs the workspace's dependencies (`pnpm install`). VERSION sets the version server-ts/package.json gives (what
# `huntaway --version` prints); IA_BUILD_COMMIT the commit it reports (default: HEAD). Nothing in it is a symbolic link,
# which installing a release refuses (update/staging.ts).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$root/apps/server"
out=${1:?usage: $0 <out dir> [<node binary>]}
node_bin=${2:-$(command -v node || true)}
[[ -x $node_bin ]] || { echo "no node at $node_bin" >&2; exit 1; }
# The Node binary itself, not a version manager's shim for it: the node on PATH may be one (Vite+'s, on the release
# runners, is its own `vp` binary, which runs the Node it manages: packaged, it ran the runner's Node, HA-270), and a
# shim run as node runs the real one, whose path is process.execPath.
node_bin=$("$node_bin" -p process.execPath)
[[ -x $root/target/release/ia-shim ]] || { echo "build ia-shim first: cargo build --release -p ia-shim" >&2; exit 1; }
[[ -f $root/apps/web/dist/index.html ]] || { echo "build the UI first: pnpm --filter huntaway-app build" >&2; exit 1; }
[[ -x $server/node_modules/.bin/tsrs ]] || { echo "install the dependencies first: pnpm install" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/server-ts" "$out/node/bin"
# Absolute: tsrs runs in apps/server.
out=$(cd "$out" && pwd)
cp "$server/bin/huntaway" "$out/huntaway"
cp "$server/bin/issue-agent" "$out/issue-agent"
cp "$root/target/release/ia-shim" "$out/ia-shim"
cp -R "$root/apps/web/dist" "$out/ui"

# The code without its tests, compiled to .js (apps/server/tsconfig.build.json: types and comments stripped, imports of
# ./x.ts rewritten to ./x.js), with the same layout as src/. Node then runs it as it is: run as .ts, every process
# (the server, and each agent's MCP helpers) would load Node's TypeScript compiler, about 20 MB more each (HA-181).
# The compiler is tsrs (HA-199), from the server's devDependencies; it type-checks too, so a type error fails the package.
(cd "$server" && node_modules/.bin/tsrs -p tsconfig.build.json --outDir "$out/server-ts/src")
[[ -f $out/server-ts/src/main.js && -f $out/server-ts/src/mcp_main.js && -f $out/server-ts/src/agent/approval_rules/hook_main.js ]] || { echo "tsrs didn't write the entry files (server-ts/src/main.js, mcp_main.js, agent/approval_rules/hook_main.js)" >&2; exit 1; }
cp "$server/package.json" "$out/server-ts/"
if [[ -n ${VERSION:-} ]]; then
  node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    p.version = process.argv[2]; fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n")' "$out/server-ts/package.json" "$VERSION"
fi
commit=${IA_BUILD_COMMIT:-$(git -C "$root" rev-parse HEAD)}
printf '{"commit": "%s"}\n' "$commit" > "$out/server-ts/build.json"
# Its production dependencies, at the lockfile's versions, as plain folders (the hoisted layout, with no links): pnpm
# deploy copies the package with them into a scratch folder (beside the package, so on the pnpm store's file system),
# whose node_modules is kept.
deploy="$out/.deploy"
(cd "$root" && pnpm --filter huntaway-server deploy --prod --config.inject-workspace-packages=true --config.node-linker=hoisted "$deploy" > /dev/null)
mv "$deploy/node_modules" "$out/server-ts/node_modules"
rm -rf "$deploy" "$out/server-ts/node_modules/.bin" "$out/server-ts/node_modules/.pnpm" "$out/server-ts/node_modules/.modules.yaml" \
  "$out/server-ts/node_modules"/.pnpm-workspace-state*

cp "$node_bin" "$out/node/bin/node"
chmod 755 "$out/node/bin/node" "$out/huntaway" "$out/issue-agent"
packaged_node=$("$out/node/bin/node" -p process.execPath)
[[ $packaged_node -ef $out/node/bin/node ]] || { echo "the packaged node/bin/node runs another Node ($packaged_node): $node_bin isn't a Node binary" >&2; exit 1; }
node_dir=$(dirname "$(dirname "$(readlink -f "$node_bin")")")
[[ -f $node_dir/LICENSE ]] && cp "$node_dir/LICENSE" "$out/node/LICENSE"

links=$(find "$out" -type l)
[[ -z $links ]] || { echo "the package has symbolic links, which installing a release refuses:" >&2; echo "$links" >&2; exit 1; }
echo "packaged huntaway $("$out/huntaway" --version | awk '{print $2}') (node $("$out/node/bin/node" --version)) in $out"
