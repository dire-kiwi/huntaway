// Vite+ (https://viteplus.dev) for the whole workspace. `vp lint` runs Oxlint over every package with these settings
// (CI runs it with --deny-warnings); apps/web/vite.config.ts is the UI's own build config. The code is formatted by hand
// (see CLAUDE.md), so `vp check` doesn't format, and nothing runs `vp fmt`.
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["**/dist/**", "**/release/**", "release-server/**", "target/**", "apps/mobile/android/**", "apps/mobile/ios/**"],
  },
  check: { fmt: false },
});
