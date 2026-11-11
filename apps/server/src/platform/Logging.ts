import { Cause, Layer, Logger, References } from "effect"

/**
 * The server's log: one line per entry on stderr, in the old format (`<ISO time>  INFO <module>: <message>`), so the
 * habits and scripts that read `server.log` keep working. A module is a log annotation:
 * `Effect.annotateLogs({ module: "tasks" })`. Stdout is kept for the ready line.
 */
export const lineLogger = Logger.make<unknown, string>((options) => {
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
  const module = typeof annotations["module"] === "string" ? annotations["module"] : "server"
  const level = options.logLevel.toUpperCase()
  const parts = Array.isArray(options.message) ? options.message : [options.message]
  const text = parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ")
  const cause = Cause.hasFails(options.cause) || Cause.hasDies(options.cause) ? `\n${Cause.pretty(options.cause)}` : ""
  return `${options.date.toISOString()}  ${level} ${module}: ${text}${cause}`
})

export const LoggingLive = Logger.layer([Logger.withConsoleError(lineLogger)])

/** The level below which nothing is logged. */
export const InfoAndAbove = Layer.succeed(References.MinimumLogLevel, "Info")
