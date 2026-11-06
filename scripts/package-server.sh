#!/usr/bin/env bash
# Puts together a release's server (HA-174: the TypeScript server, with the Node that runs it), as the server tarball
# and the desktop app's resources carry it:
#
#   scripts/package-server.sh <out dir> [<node binary>]
#
#   <out dir>/huntaway          apps/server/bin/huntaway, which runs the server with the Node beside it
#   <out dir>/issue-agent       apps/server/bin/issue-agent, the name from before the rename, which runs huntaway
#   <out dir>/server-ts/        the server's code (src/ without tests, compiled to .js), package.json, build.json and its
#                               node_modules (the folder keeps the name it had before the repository's apps/ layout,
#                               which installed desktop apps and hosts look for)
#   <out dir>/node/bin/node     <node binary> (default: the node on PATH), with Node's LICENSE
#   <out dir>/ia-shim           target/release/ia-shim (build it first: cargo build --release -p ia-shim)
#   <out dir>/ui/               apps/web/dist (build it first: npm run build -w huntaway-app)
#
# VERSION sets the version the package's apps/server/package.json gives (what `huntaway --version` prints); IA_BUILD_COMMIT
# the commit it reports (default: HEAD). Nothing in it is a symbolic link, which installing a release refuses (update/staging.ts).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out=${1:?usage: $0 <out dir> [<node binary>]}
node_bin=${2:-$(command -v node)}
[[ -x $node_bin ]] || { echo "no node at $node_bin" >&2; exit 1; }
[[ -x $root/target/release/ia-shim ]] || { echo "build ia-shim first: cargo build --release -p ia-shim" >&2; exit 1; }
[[ -f $root/apps/web/dist/index.html ]] || { echo "build the UI first: npm run build -w huntaway-app" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/server-ts" "$out/node/bin"
# Absolute: tsrs runs in a scratch copy below.
out=$(cd "$out" && pwd)
cp "$root/apps/server/bin/huntaway" "$out/huntaway"
cp "$root/apps/server/bin/issue-agent" "$out/issue-agent"
cp "$root/target/release/ia-shim" "$out/ia-shim"
cp -R "$root/apps/web/dist" "$out/ui"

# The code without its tests, compiled to .js (apps/server/tsconfig.build.json: types and comments stripped, imports of
# ./x.ts rewritten to ./x.js), with the same layout as src/. Node then runs it as it is: run as .ts, every process
# (the server, and each agent's MCP helpers) would load Node's TypeScript compiler, about 20 MB more each (HA-181).
# The compiler is tsrs (HA-199), from the server's devDependencies, installed from the workspace's lockfile in a scratch
# copy (its manifests and the server's files); it type-checks too, so a type error fails the package.
build=$(mktemp -d "${TMPDIR:-/tmp}/package-server.XXXXXX")
trap 'rm -rf "$build"' EXIT
cp "$root/package.json" "$root/package-lock.json" "$build/"
for f in "$root"/apps/*/package.json "$root"/packages/*/package.json; do
  rel=${f#"$root"/}
  mkdir -p "$build/$(dirname "$rel")" && cp "$f" "$build/$rel"
done
cp -R "$root/apps/server/src" "$root/apps/server/tsconfig.json" "$root/apps/server/tsconfig.build.json" "$build/apps/server/"
(cd "$build" && npm ci -w @huntaway/server --ignore-scripts --no-audit --no-fund --loglevel=error &&
  node_modules/.bin/tsrs -p apps/server/tsconfig.build.json --outDir "$out/server-ts/src")
[[ -f $out/server-ts/src/main.js && -f $out/server-ts/src/mcp_main.js && -f $out/server-ts/src/agent/approval_rules/hook_main.js ]] || { echo "tsrs didn't write the entry files ($out/server-ts/src/main.js, mcp_main.js, agent/approval_rules/hook_main.js)" >&2; exit 1; }
cp "$root/apps/server/package.json" "$out/server-ts/"
if [[ -n ${VERSION:-} ]]; then
  node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    p.version = process.argv[2]; fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n")' "$out/server-ts/package.json" "$VERSION"
fi
commit=${IA_BUILD_COMMIT:-$(git -C "$root" rev-parse HEAD)}
printf '{"commit": "%s"}\n' "$commit" > "$out/server-ts/build.json"
# Its node_modules: only what it needs to run, the packages npm lists as the server's production dependencies (with the
# packages nested in them), as the scratch copy installed them. The workspace's link to the server itself stays out.
(cd "$build" && npm ls --all --omit=dev -w @huntaway/server --parseable) | while read -r dep; do
  rel=${dep#"$build"/}
  [[ $rel == node_modules/* && $rel != node_modules/*/node_modules/* && $rel != node_modules/@huntaway/* ]] || continue
  mkdir -p "$out/server-ts/$(dirname "$rel")" && cp -R "$dep" "$out/server-ts/$rel"
done
[[ -f $out/server-ts/node_modules/ws/package.json ]] || { echo "the server's dependencies weren't copied (no ws)" >&2; exit 1; }

cp "$node_bin" "$out/node/bin/node"
chmod 755 "$out/node/bin/node" "$out/huntaway" "$out/issue-agent"
node_dir=$(dirname "$(dirname "$(readlink -f "$node_bin")")")
[[ -f $node_dir/LICENSE ]] && cp "$node_dir/LICENSE" "$out/node/LICENSE"

links=$(find "$out" -type l)
[[ -z $links ]] || { echo "the package has symbolic links, which installing a release refuses:" >&2; echo "$links" >&2; exit 1; }
echo "packaged huntaway $("$out/huntaway" --version | awk '{print $2}') (node $("$out/node/bin/node" --version)) in $out"
