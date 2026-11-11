import { Schema } from "effect"

/** The server cannot start: shown on stderr, and the process exits 1. `reason` is a sentence for a person. */
export class StartupError extends Schema.TaggedError<StartupError, { readonly brand: unique symbol }>()("StartupError", { reason: Schema.String }) {}
