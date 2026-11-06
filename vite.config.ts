// Vite+ (https://viteplus.dev) for the whole workspace. `vp lint` runs Oxlint over every package with these settings
// (CI runs it with --deny-warnings); apps/web/vite.config.ts is the UI's own build config. The code is formatted by hand
// (see CLAUDE.md), so `vp check` doesn't format, and nothing runs `vp fmt`.
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["**/dist/**", "**/release/**", "release-server/**", "target/**", "apps/mobile/android/**", "apps/mobile/ios/**"],
    rules: {
      // The code's own idioms, which these rules flag: `a && b()` and `(x(), y())` as statements, a copy of a Map's
      // values to loop over while the loop changes the Map, `...(x ?? {})`, regular expressions over control characters
      // (escape codes, the characters a terminal or a branch name mustn't have), and /^…/.test for a prefix.
      "no-unused-expressions": "off",
      "unicorn/no-useless-spread": "off",
      "unicorn/no-useless-fallback-in-spread": "off",
      "no-control-regex": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      // A destructured `_` (or `_name`) is left out on purpose.
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  check: { fmt: false },
});
