// What `bin/huntaway gh-hook` runs: gh.ts's `bashHook`, and nothing of the server. As approval-hook.ts does, it loads
// gh.ts once its handlers are on, so that whatever goes wrong refuses the call with exit code 2 (any other exit code
// lets it through: a Bash call that runs gh would go ahead).

const FAILED = "The board's gh hook failed, so this call was refused. Don't run gh in Bash: use the gh MCP server's tools."

const fail = () => {
  try {
    process.stderr.write(`${FAILED}\n`)
  } finally {
    process.exit(2)
  }
}
process.on("uncaughtException", fail)
process.on("unhandledRejection", fail)
try {
  const m = await import("./gh.ts")
  process.exitCode = m.bashHook()
} catch {
  fail()
}
