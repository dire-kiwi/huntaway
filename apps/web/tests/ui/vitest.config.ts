import { defineConfig } from "vite-plus";

// The browser checks (`pnpm run test:ui`, which builds the UI first): each file starts a test server of its own and a
// Chromium on it (see harness.mjs), IA_UI_TEST_JOBS files at a time (8 by default). `-- --shard=2/3` runs a third of
// them, as CI does.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.test.mjs"],
    pool: "forks",
    maxWorkers: Number(process.env.IA_UI_TEST_JOBS) || 8,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
