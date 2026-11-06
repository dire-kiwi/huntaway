import { defineConfig } from "vite-plus";

// Vite+ (`vp`) for the whole workspace. Each package's own vite.config.ts has its build and test settings.
//   vp check   Oxfmt, Oxlint and type checks (with each file's tsconfig.json), over every package
//   vp test    the server's and the web app's unit tests; the mobile app's are Jest's, and the browser checks have a
//              config of their own (apps/web/tests/ui/vitest.config.ts)
export default defineConfig({
  fmt: {
    printWidth: 160,
    // Recorded test data, kept as it was recorded.
    ignorePatterns: ["**/fixtures/**", "apps/server/src/threads/examples/**"],
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ["apps/server", "apps/web"],
  },
});
