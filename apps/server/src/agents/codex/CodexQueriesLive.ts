import { Effect, Layer, Result } from "effect"
import { CodexQueries, CodexUnavailable } from "../CodexQueries.ts"

// Placeholder until the app-server client lands (5.3).
export const CodexQueriesLive = Layer.succeed(
  CodexQueries,
  CodexQueries.of({
    models: () => Effect.fail(new CodexUnavailable({ reason: "not yet" })),
    skills: () => Effect.fail(new CodexUnavailable({ reason: "not yet" })),
    rateLimits: () => Effect.fail(new CodexUnavailable({ reason: "not yet" })),
    title: () => Effect.succeed({ reply: Result.fail("not yet"), spent: null }),
  }),
)
