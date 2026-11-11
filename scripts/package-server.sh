#!/usr/bin/env bash
# Puts together a release of the server from this checkout: a folder that runs on its own (its own Node, no install
# step), as the server tarball and the desktop app's resources carry it, and the tarball. Carried over from
# dire-kiwi/huntaway (scripts/package-server.sh at f2298f0c) for the new server (docs/plan/02-repository.md, Releases).
#
#   scripts/package-server.sh <out dir> [<node binary>]
#
#   <out dir>/huntaway          apps/server/bin/huntaway, which runs server/src/bin.js with the Node in node/
#   <out dir>/build.json        {"version": …, "commit": …}: what the server reports itself as
#   <out dir>/ia-shim           target/release/ia-shim (cargo build --release --locked -p ia-shim, which this runs)
#   <out dir>/ui/               apps/web/dist (pnpm build, which this runs)
#   <out dir>/node/bin/node     <node binary> (default: the node on PATH; the binary a version manager's shim runs),
#                               with Node's LICENSE
#   <out dir>/server/           package.json; src/ and migrations/ compiled to .js (no tests); node_modules/ with the
#                               production dependencies, @huntaway/shared and @huntaway/contracts compiled to .js too
#   <out dir>/electron/         only with HUNTAWAY_SHELL_DIR: the desktop shell's *.cjs from that folder, and
#                               shell.json {"electron": <apps/desktop's Electron version>, "boot": 1}, which an
#                               installed desktop app loads once it has updated to this release (the release
#                               workflow's tarball)
#
# and beside <out dir>, huntaway-server-<version>-<os>-<arch>.tar.gz (one top folder of that name) and its .sha256.
# <os> is linux or mac, <arch> x64 or arm64: the packaged Node's.
#
# VERSION sets the version (default: apps/server/package.json's), HUNTAWAY_BUILD_COMMIT the commit (default: HEAD).
# Needs the workspace's dependencies (`pnpm install`) and cargo. Nothing in the package is a symbolic or hard link,
# which installing a release refuses.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$root/apps/server"
out=${1:?usage: $0 <out dir> [<node binary>]}
node_bin=${2:-$(command -v node || true)}
[[ -x $node_bin ]] || { echo "no node at $node_bin" >&2; exit 1; }
# The Node binary itself, not a version manager's shim for it (Vite+'s node on the release runners is its own `vp`
# binary: packaged, it ran the runner's Node, HA-270). A shim run as node runs the real one, whose path is execPath.
node_bin=$("$node_bin" -p process.execPath)
tsc="$root/node_modules/typescript/bin/tsc"
[[ -x $tsc ]] || { echo "install the dependencies first: pnpm install" >&2; exit 1; }
version=${VERSION:-$(node -p 'require(process.argv[1]).version' "$server/package.json")}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "VERSION isn't semver: $version" >&2; exit 1; }
commit=${HUNTAWAY_BUILD_COMMIT:-$(git -C "$root" rev-parse HEAD)}
platform=$("$node_bin" -p '({ linux: "linux", darwin: "mac" })[process.platform] ?? process.platform')
arch=$("$node_bin" -p process.arch)
name="huntaway-server-$version-$platform-$arch"
started=$(date +%s)

(cd "$root" && pnpm build > /dev/null)
(cd "$root" && cargo build --release --locked -p ia-shim --quiet)

rm -rf "$out"
mkdir -p "$out/server" "$out/node/bin"
out=$(cd "$out" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/package-server.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

cp "$server/bin/huntaway" "$out/huntaway"
cp "$root/target/release/ia-shim" "$out/ia-shim"
cp -R "$root/apps/web/dist" "$out/ui"
printf '{ "version": "%s", "commit": "%s" }\n' "$version" "$commit" > "$out/build.json"

# The server and the two workspace packages it runs, compiled to .js by TypeScript's own compiler (TypeScript 7's
# tsc, which emits): types and comments stripped, imports of ./x.ts rewritten to ./x.js, the layout of the sources
# kept. Node then runs it as it is: run as .ts, every process (the server, and each agent's hooks) would load Node's
# TypeScript stripper, and Node strips nothing under node_modules, where the packages go. It type-checks too, so a
# type error fails the package. Tests and their helpers (tests/ folders) are left out.
cat > "$scratch/tsconfig.json" <<EOF
{
  "extends": "$root/tsconfig.base.json",
  "compilerOptions": {
    "noEmit": false,
    "rewriteRelativeImportExtensions": true,
    "removeComments": true,
    "types": ["node"],
    "typeRoots": ["$server/node_modules/@types"],
    "plugins": [],
    "rootDir": "$root",
    "outDir": "$scratch/js"
  },
  "include": ["$server/src", "$server/migrations", "$root/packages/shared/src", "$root/packages/contracts/src"],
  "exclude": ["$root/**/*.test.ts", "$server/src/**/tests/**"]
}
EOF
"$tsc" -p "$scratch/tsconfig.json"
mv "$scratch/js/apps/server/src" "$scratch/js/apps/server/migrations" "$out/server/"
[[ -f $out/server/src/bin.js && -f $out/server/src/hooks/approval-hook.js && -f $out/server/src/hooks/gh-hook.js ]] ||
  { echo "tsc didn't write the entry files (server/src/bin.js, hooks/approval-hook.js, hooks/gh-hook.js)" >&2; exit 1; }
node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  p.version = process.argv[2]; delete p.devDependencies; delete p.scripts;
  fs.writeFileSync(process.argv[3], JSON.stringify(p, null, 2) + "\n")' "$server/package.json" "$version" "$out/server/package.json"

# The production dependencies, at the lockfile's versions, as plain folders (the hoisted layout, with no links): pnpm
# deploy copies the package with them into a scratch folder, whose node_modules is kept. What Node never loads goes:
# TypeScript sources and declarations (Node strips no types under node_modules), source maps, pnpm's own files. Copied
# rather than moved: pnpm hard-links its files from its store, and a file in two packages would go in the tarball as a
# hard link, which installing a release refuses (cp -R makes each a file of its own).
(cd "$root" && pnpm --filter huntaway-server deploy --prod --config.inject-workspace-packages=true --config.node-linker=hoisted "$scratch/deploy" > /dev/null)
modules="$out/server/node_modules"
cp -R "$scratch/deploy/node_modules" "$modules"
rm -rf "$modules/.bin" "$modules/.pnpm" "$modules/.modules.yaml" "$modules"/.pnpm-workspace-state* "$modules/@types" "$modules/undici-types"
find "$modules" -type f \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.map' -o -name '*.tsbuildinfo' \) -delete
# The workspace packages export ./src/index.ts: theirs compiled, and their exports pointed at the .js.
for pkg in shared contracts; do
  dir="$modules/@huntaway/$pkg"
  [[ -d $dir ]] || { echo "pnpm deploy left out @huntaway/$pkg" >&2; exit 1; }
  rm -rf "$dir"
  mkdir -p "$dir"
  mv "$scratch/js/packages/$pkg/src" "$dir/src"
  node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const js = (v) => typeof v === "string" ? v.replace(/\.ts$/, ".js") : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, js(x)]));
    p.exports = js(p.exports); delete p.devDependencies; delete p.scripts;
    fs.writeFileSync(process.argv[2], JSON.stringify(p, null, 2) + "\n")' "$root/packages/$pkg/package.json" "$dir/package.json"
done
find "$modules" -type d -empty -delete

if [[ -n ${HUNTAWAY_SHELL_DIR:-} ]]; then
  electron_version=$(node -p 'require(process.argv[1]).version' "$root/apps/desktop/node_modules/electron/package.json")
  mkdir "$out/electron"
  cp "$HUNTAWAY_SHELL_DIR"/*.cjs "$out/electron/"
  printf '{ "electron": "%s", "boot": 1 }\n' "$electron_version" > "$out/electron/shell.json"
fi

cp "$node_bin" "$out/node/bin/node"
chmod 755 "$out/node/bin/node" "$out/huntaway" "$out/ia-shim"
packaged_node=$("$out/node/bin/node" -p process.execPath)
[[ $packaged_node -ef $out/node/bin/node ]] || { echo "the packaged node/bin/node runs another Node ($packaged_node): $node_bin isn't a Node binary" >&2; exit 1; }
node_dir=$(dirname "$(dirname "$node_bin")")
[[ -f $node_dir/LICENSE ]] && cp "$node_dir/LICENSE" "$out/node/LICENSE"

links=$(find "$out" -type l -o -type f -links +1)
[[ -z $links ]] || { echo "the package has symbolic or hard links, which installing a release refuses:" >&2; echo "$links" >&2; exit 1; }
got=$("$out/huntaway" --version)
[[ $got == "huntaway $version" ]] || { echo "the package's huntaway --version says '$got', not 'huntaway $version'" >&2; exit 1; }

# The tarball: one top folder named for the release, whatever <out dir> is called (tar -h follows the link to it;
# the package has no other).
parent=$(dirname "$out")
tarball="$parent/$name.tar.gz"
ln -s "$out" "$scratch/$name"
tar -C "$scratch" -chzf "$tarball" "$name"
# What installing a release checks (docs/plan/inventory/05-hosts-update.md, section 9): one top folder, no absolute or
# .. entries, only files and folders, and huntaway, ia-shim and ui/index.html in it.
entries=$(tar -tzf "$tarball")
awk -v top="$name" '$0 !~ "^" top "(/|$)" || $0 ~ /(^|\/)\.\.(\/|$)/ { print "an entry outside " top "/: " $0; bad = 1 }
  END { exit bad }' <<< "$entries" >&2 || exit 1
tar -tvzf "$tarball" | awk '$1 !~ /^[-d]/ { print "not a file or folder: " $0; bad = 1 } END { exit bad }' >&2 || exit 1
for f in huntaway ia-shim ui/index.html; do
  grep -qxF "$name/$f" <<< "$entries" || { echo "$tarball has no $name/$f" >&2; exit 1; }
done
if command -v sha256sum > /dev/null; then sum=$(sha256sum "$tarball"); else sum=$(shasum -a 256 "$tarball"); fi
printf '%s  %s\n' "${sum%% *}" "$name.tar.gz" > "$tarball.sha256"

size() { du -sk "$1" | awk '{ printf "%.0f MB", $1 / 1024 }'; }
echo "packaged huntaway $version ($commit, node $("$out/node/bin/node" --version)) in $out: $(size "$out"), of which server/ $(size "$out/server"), node/ $(size "$out/node")"
echo "$tarball: $(size "$tarball"), sha256 ${sum%% *}; took $(($(date +%s) - started)) s"
