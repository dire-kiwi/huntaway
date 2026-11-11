import { strict } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: { printWidth: 160 },
  lint: {
    extends: [strict],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    rules: {
      "effecttsgo/global-date": "error",
      "effecttsgo/global-date-in-effect": "error",
      "effecttsgo/global-timers": "error",
      "effecttsgo/global-timers-in-effect": "error",
      "effecttsgo/global-random": "error",
      "effecttsgo/global-random-in-effect": "error",
      "effecttsgo/global-console": "error",
      "effecttsgo/global-console-in-effect": "error",
      "effecttsgo/global-json": "error",
      "effecttsgo/global-json-in-effect": "error",
      "effecttsgo/process-env": "error",
      "effecttsgo/process-env-in-effect": "error",
      "effecttsgo/async-function": "error",
      "effecttsgo/new-promise": "error",
      "effecttsgo/strict-effect-provide": "error",
      "effecttsgo/deterministic-keys": "error",
      "typescript/no-explicit-any": "error"
    }
  }
})
