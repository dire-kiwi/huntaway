import { existsSync, readFileSync } from "node:fs"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { brotliCompress, constants, gzip } from "node:zlib"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite-plus"

// Where `vp dev` sends `/api` (the RPC websocket too): $HUNTAWAY_SERVER, else the test server last started from this
// worktree (`scripts/test-server.sh` links `.huntaway-test-env` at the top to its env file), else the new server's default.
const testEnv = new URL("../../.huntaway-test-env", import.meta.url)
const lastTestServer = existsSync(testEnv) ? /HUNTAWAY_TEST_URL=['"]?([^'"\s]+)/.exec(readFileSync(testEnv, "utf8"))?.[1] : undefined
const server = process.env["HUNTAWAY_SERVER"] ?? lastTestServer ?? "http://127.0.0.1:7879"

const brotli = promisify(brotliCompress)
const gz = promisify(gzip)

/**
 * Writes `<file>.br` and `<file>.gz` beside each text file of the build that compression shrinks, so the server sends
 * them to a browser that accepts them without compressing on each request (apps/server/src/http/routes.ts, StaticUi;
 * docs/plan/09-frontend.md, The bundle). A variant is kept only when it saves a tenth or more.
 */
function precompress(): Plugin {
  let outDir = "dist"
  return {
    name: "huntaway:precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      if ((await stat(outDir).catch(() => null))?.isDirectory() !== true) return
      const files = (await readdir(outDir, { recursive: true })).filter((f) => compressible.test(f))
      await Promise.all(files.map((f) => writeVariants(join(outDir, f))))
    },
  }
}

/** The files the server has a type for when it sends a variant (apps/server/src/http/routes.ts, `compressibleTypes`). */
const compressible = /\.(js|mjs|css|html|svg|json|webmanifest|txt|xml|ttf|wasm)$/

async function writeVariants(file: string): Promise<void> {
  const raw = await readFile(file)
  if (raw.length < 1024) return
  const [br, gzipped] = await Promise.all([
    brotli(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    gz(raw, { level: 9 }),
  ])
  // Each encoding has its own size, so its own ETag (the server's tags are size and time).
  if (br.length <= raw.length * 0.9) await writeFile(`${file}.br`, br)
  if (gzipped.length <= raw.length * 0.9 && gzipped.length !== br.length) await writeFile(`${file}.gz`, gzipped)
}

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  base: "/",
  worker: { format: "es" },
  server: {
    proxy: {
      "/api": { target: server, ws: true, changeOrigin: true },
    },
  },
  // `pnpm test` runs the unit tests (tests/unit, in Node). The whole-app checks against a test server (tests/ui) have a
  // config of their own (`pnpm test:ui`).
  test: {
    name: "web",
    include: ["tests/unit/**/*.test.ts"],
  },
})
