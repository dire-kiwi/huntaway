// What `bin/huntaway gh-run` runs: ghRun.ts's `ghRun`, and nothing of the server (docs/plan/06-server.md, Hook
// commands). A wait's command runs it for every gh call it makes, so it loads only Node and `@huntaway/shared`. Anything
// that goes wrong is said on stderr, with exit code 1: gh didn't run.

const fail = (message: string) => {
  try {
    process.stderr.write(`${message}\n`)
  } finally {
    process.exit(1)
  }
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e))
process.on("uncaughtException", (e) => fail(`huntaway gh-run failed: ${why(e)}`))
process.on("unhandledRejection", (e) => fail(`huntaway gh-run failed: ${why(e)}`))
try {
  const m = await import("./ghRun.ts")
  process.exitCode = await m.ghRun(process.argv.slice(2)).catch((e: unknown) => {
    fail(e instanceof m.GhRunRefused ? e.message : `huntaway gh-run failed: ${why(e)}`)
    return 1
  })
} catch (e) {
  fail(`huntaway gh-run failed: ${why(e)}`)
}
