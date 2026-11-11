// What `bin/huntaway approval-hook '<rules json>'` runs: approval.ts's `hook`, and nothing of the server.
//
// It's a file of its own rather than an `if (import.meta.main)` in approval.ts, which Node before 24.2 doesn't set: the
// hook then did nothing and exited 0, which Claude Code takes as no decision, so ask and never rules didn't hold
// (HA-245). approval.ts is imported once the handlers below are on, so that whatever goes wrong, loading it too, refuses
// the call with exit code 2, as `hook` does when it fails (any other exit code lets the call through).

/** `@huntaway/shared`'s HOOK_FAILED, for when it couldn't be loaded (approval-hook.test.ts checks they say the same). */
const FALLBACK =
  "The user's approval rules couldn't be checked for this call (their hook failed to start), so it was refused. " +
  "Don't try another way to do the same thing: tell the user the rules' hook isn't working."

let message = FALLBACK
const fail = () => {
  try {
    process.stderr.write(`${message}\n`)
  } finally {
    process.exit(2)
  }
}
process.on("uncaughtException", fail)
process.on("unhandledRejection", fail)
try {
  const [m, shared] = await Promise.all([import("./approval.ts"), import("@huntaway/shared")])
  message = shared.HOOK_FAILED
  process.exitCode = await m.hook(process.argv[2])
} catch {
  fail()
}
