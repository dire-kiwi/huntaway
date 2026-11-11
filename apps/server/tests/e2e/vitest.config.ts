import { fileURLToPath } from "node:url"
import { defineConfig } from "vite-plus"

// The whole-server tier (docs/plan/10-testing.md, Tiers): real server processes started through the launcher, one per
// file. `pnpm test:e2e` runs it; `pnpm test` does not (apps/server/vite.config.ts leaves tests/e2e out).
export default defineConfig({
  test: {
    name: "server-e2e",
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 60_000,
  },
})
