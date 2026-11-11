import { existsSync, readFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite-plus"

// Where `vp dev` sends `/api` (the RPC websocket too): $HUNTAWAY_SERVER, else the test server last started from this
// worktree (`scripts/test-server.sh` links `.huntaway-test-env` at the top to its env file), else the new server's default.
const testEnv = new URL("../../.huntaway-test-env", import.meta.url)
const lastTestServer = existsSync(testEnv) ? /HUNTAWAY_TEST_URL=['"]?([^'"\s]+)/.exec(readFileSync(testEnv, "utf8"))?.[1] : undefined
const server = process.env["HUNTAWAY_SERVER"] ?? lastTestServer ?? "http://127.0.0.1:7879"

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
