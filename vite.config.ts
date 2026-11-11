import { strict } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "vite-plus"

// Vite+ (`vp`) for the whole workspace: `pnpm check` is `effect-tsgo vp check` (Oxfmt, Oxlint with type-aware rules,
// the type check, and Effect's rules as the `effecttsgo` plugin). Every rule that is on is an error, and a warning fails
// the check too (docs/effect.md, Linting). A rule is never lowered to "warn"; one that is wrong for this code base is
// turned off here, in a change that says why.

// Effect-native rules: time, timers, randomness, the environment, logging, JSON, promises and Node's modules go through
// Effect's services. Off where code is plain TypeScript by design.
const effectNative = {
  "effecttsgo/global-date": "error",
  "effecttsgo/global-date-in-effect": "error",
  "effecttsgo/global-timers": "error",
  "effecttsgo/global-timers-in-effect": "error",
  "effecttsgo/global-random": "error",
  "effecttsgo/global-random-in-effect": "error",
  "effecttsgo/global-console": "error",
  "effecttsgo/global-console-in-effect": "error",
  "effecttsgo/global-fetch": "error",
  "effecttsgo/global-fetch-in-effect": "error",
  "effecttsgo/global-json": "error",
  "effecttsgo/global-json-in-effect": "error",
  "effecttsgo/process-env": "error",
  "effecttsgo/process-env-in-effect": "error",
  "effecttsgo/crypto-random-uuid": "error",
  "effecttsgo/crypto-random-uuid-in-effect": "error",
  "effecttsgo/node-builtin-import": "error",
  "effecttsgo/async-function": "error",
  "effecttsgo/new-promise": "error",
  "effecttsgo/extends-native-error": "error",
  "effecttsgo/instance-of-schema": "error",
  "effecttsgo/schema-sync": "error",
} as const

const off = (rules: Readonly<Record<string, unknown>>): Record<string, "off"> => Object.fromEntries(Object.keys(rules).map((name) => [name, "off" as const]))

// The package boundaries of docs/plan/02-repository.md, as import restrictions per folder.
const restrict = (patterns: Array<{ group: Array<string>; message: string }>): ["error", { patterns: Array<{ group: Array<string>; message: string }> }] => [
  "error",
  { patterns },
]

const noTesting = { group: ["@huntaway/testing", "@huntaway/testing/*"], message: "packages/testing is for tests only." }
const noApps = { group: ["huntaway-server", "huntaway-server/*", "huntaway-web", "huntaway-web/*"], message: "A package does not import an app." }
const noNode = { group: ["node:*"], message: "This package runs anywhere: no Node modules." }
const noEffect = {
  group: ["effect", "effect/*", "@effect/*"],
  message: "Plain TypeScript: the hooks load this per tool call, so it does not import effect.",
}

export default defineConfig({
  fmt: {
    printWidth: 160,
    semi: false,
    // Recorded test data, kept as it was recorded; the plan and its spike are documents.
    ignorePatterns: ["**/fixtures/**", "docs/plan/**", "pnpm-lock.yaml"],
  },
  lint: {
    // 97 Effect rules, every one at "error": correctness, anti-patterns and style.
    extends: [strict],
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    categories: { correctness: "error", suspicious: "error", perf: "error" },
    ignorePatterns: ["docs/plan/**", "**/dist/**", "**/fixtures/**", "rust/**", "target/**"],
    rules: {
      ...effectNative,
      // Layers are provided at entry points only; errors and services are declared one way.
      "effecttsgo/strict-effect-provide": "error",
      "effecttsgo/effect-try-without-catch": "error",
      "effecttsgo/any-unknown-in-error-context": "error",
      "effecttsgo/unsafe-effect-type-assertion": "error",
      "effecttsgo/prefer-schema-tagged-error": "error",
      "effecttsgo/service-not-as-class": "error",
      "effecttsgo/deterministic-keys": "error",
      "effecttsgo/schema-union-of-literals": "error",
      "effecttsgo/nested-effect-gen-yield": "error",
      // TypeScript.
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-promises": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/consistent-type-imports": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/only-throw-error": "error",
      "import/no-cycle": "error",
      // Off: `_tag` is the discriminant of every Effect data type (`Exit`, `Result`, `Option`, tagged errors), and
      // the `_tag` of our own internal unions (docs/effect.md, Schemas). The rule would fire on every match.
      "no-underscore-dangle": "off",
    },
    overrides: [
      // Plain TypeScript by design: no Effect, so the Effect-native rules do not apply.
      {
        files: ["packages/shared/**", "apps/server/src/hooks/**"],
        rules: { ...off(effectNative), "no-restricted-imports": restrict([noEffect, noTesting, noApps]) },
      },
      // The desktop shell's plain parts: the frame (src/boot), which a release can't replace and so stays small, with no
      // effect import, and runs before any shell; the decisions it shares with the main process (src/shared); and the
      // preload, which Electron runs in the page's sandboxed renderer, with the DOM and Electron's renderer modules.
      {
        files: ["apps/desktop/src/boot/**", "apps/desktop/src/shared/**", "apps/desktop/src/preload/**"],
        rules: {
          ...off(effectNative),
          "no-restricted-imports": restrict([
            { ...noEffect, message: "Plain TypeScript: the desktop shell's frame, preload and shared decisions do not import effect." },
            noTesting,
            noApps,
          ]),
        },
      },
      {
        files: ["packages/contracts/**"],
        rules: {
          "no-restricted-imports": restrict([
            noNode,
            noTesting,
            noApps,
            {
              group: ["@effect/*", "@huntaway/client", "@huntaway/client/*", "react"],
              message: "packages/contracts imports only effect and @huntaway/shared.",
            },
          ]),
        },
      },
      {
        files: ["packages/client/**"],
        rules: { "no-restricted-imports": restrict([noNode, noTesting, noApps]) },
      },
      {
        files: ["apps/server/src/**"],
        rules: { "no-restricted-imports": restrict([noTesting]) },
      },
      // The kept React components: view code, moved over one feature at a time (docs/plan/09-frontend.md).
      {
        files: ["apps/web/src/components/**"],
        plugins: ["react"],
        rules: {
          "react/rules-of-hooks": "error",
          "react/exhaustive-deps": "error",
          // Off: the components use React's automatic JSX runtime (`"jsx": "react-jsx"`), which needs no React in scope.
          "react/react-in-jsx-scope": "off",
          // Event handlers and DOM timers.
          "effecttsgo/async-function": "off",
          "effecttsgo/global-date": "off",
          "effecttsgo/global-timers": "off",
          "no-restricted-imports": restrict([
            noTesting,
            { group: ["effect/rpc", "effect/rpc/*", "effect/http", "effect/http/*"], message: "Components read atoms; they do not call the server." },
            { group: ["@huntaway/client/*"], message: "Components use @huntaway/client's public atoms and types only." },
          ]),
        },
      },
      // Entry points provide layers and read the environment.
      {
        files: [
          "apps/server/src/bin.ts",
          "apps/server/src/codex-run.ts",
          "apps/server/src/Main.ts",
          "apps/server/src/platform/ServerConfig.ts",
          "apps/desktop/src/main/main.ts",
          "**/*.test.ts",
          "**/*.test.tsx",
          "packages/testing/**",
          "apps/server/tests/**",
        ],
        // Node's HTTP server has no Effect counterpart to create it with: the composition root names it.
        rules: { "effecttsgo/strict-effect-provide": "off", "effecttsgo/process-env": "off", "effecttsgo/node-builtin-import": "off" },
      },
      // Tests may use the test fixtures.
      { files: ["**/*.test.ts", "**/*.test.tsx", "**/tests/**"], rules: { "no-restricted-imports": "off" } },
      // The tools agents and tests drive the board with (ui-check.mjs and the like): plain Node scripts with a promise
      // API that test harnesses import, so the Effect-native rules do not apply; a step loop awaits in order by design.
      // So are the programs packages/testing/bin has in place of outside ones (fake-claude stands in for Claude Code).
      {
        files: ["scripts/**", "apps/web/tests/ui/**", "packages/testing/bin/**", "apps/desktop/scripts/**"],
        rules: { ...off(effectNative), "no-await-in-loop": "off" },
      },
      // The workspace's own configuration files: plain Node.
      {
        files: ["vite.config.ts", "**/vite.config.ts", "**/vitest.config.ts"],
        rules: off(effectNative),
      },
    ],
  },
  test: {
    projects: ["apps/server", "apps/web", "apps/desktop", "packages/*"],
  },
})
