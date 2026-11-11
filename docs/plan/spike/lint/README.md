# Lint spike

The lint configuration from [12-conventions.md](../../12-conventions.md#linting), small, with one file that breaks it.
Run on 11 November 2026 with Vite+ 1.5.0 (Oxlint 1.91.0), `@effect/tsgo` 0.67.7 and `effect` 4.1.4.

```sh
cd docs/plan/spike/lint
npm install
npx effect-tsgo vp lint src        # exits 1
```

`src/bad.ts` is 24 lines and got 13 errors, one for each thing it does wrong:

| Rule                                   | What it caught                                                    |
| -------------------------------------- | ----------------------------------------------------------------- |
| `effecttsgo/floating-effect`           | `Effect.log("floating")` neither yielded nor assigned             |
| `effecttsgo/try-catch-in-effect-gen`   | `try`/`catch` around a `yield*`                                   |
| `effecttsgo/global-date-in-effect`     | `Date.now()`                                                      |
| `effecttsgo/global-timers-in-effect`   | `setTimeout`                                                      |
| `effecttsgo/global-console-in-effect`  | `console.log`                                                     |
| `effecttsgo/global-json-in-effect`     | `JSON.parse`                                                      |
| `effecttsgo/process-env-in-effect`     | `process.env.PORT`                                                |
| `effecttsgo/global-random`             | `Math.random()`                                                   |
| `effecttsgo/async-function`            | an `async function`                                               |
| `effecttsgo/strict-effect-provide`     | `Effect.provide(layer)` outside an entry point                    |
| `effecttsgo/deterministic-keys`        | a service key that does not match its file and class              |
| `effecttsgo/unstable-api-usage`        | `effect/http`, which is tagged unstable (gone once the module is in `allowedUnstableApis`: the `tsconfig.json` here has that entry) |
| `typescript/no-explicit-any`           | `any`                                                             |

Two more things were checked:

- With `allowedUnstableApis: ["effect/http"]` in the `@effect/language-service` plugin entry of `tsconfig.json`, the
  `unstable-api-usage` error goes and the other twelve stay.
- With `denyWarnings: true` in `lint.options`, a rule left at `warn` (`eslint/no-debugger`) makes the lint exit 1;
  without it the lint exits 0.
