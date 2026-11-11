import { availableParallelism } from "node:os"
import { defineConfig } from "vite-plus"

// The browser checks (`pnpm test:ui`, which builds the UI first): each file starts a test server of its own and a
// Chromium on it (see harness.mjs), HUNTAWAY_UI_TEST_JOBS files at a time (by default 8, or half the CPUs where that's
// more: they mostly wait on their pages). `-- --shard=2/3` runs a third of them, as CI does.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.test.mjs"],
    pool: "forks",
    maxWorkers: Number(process.env["HUNTAWAY_UI_TEST_JOBS"]) || Math.max(8, Math.floor(availableParallelism() / 2)),
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
