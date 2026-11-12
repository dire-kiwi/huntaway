#!/usr/bin/env node
// The fake claude with a flood of output, for the follower's measurement (docs/plan/10-testing.md, Measurements): it
// runs a server's own fake claude (this repository's packages/testing/bin/fake-claude, or the old repository's
// scripts/fake-claude), passing its arguments, stdin and stderr through, and its stdout too, but for one thing: when
// the flood is armed, the first `assistant` line of a run becomes LINES assistant text lines (each its own message),
// written as fast as the pipe takes them (or RATE a second). So the old and the new server read the same lines through
// the same ia-shim, and the rest of the run (init, control requests, the result) is each fake's own.
//
//   scripts/measure-vs-old.mjs arms it (writes <flood dir>/armed) and reads what it did (<flood dir>/floods.jsonl).
//
// Its knobs, in the server's environment (kept by either repository's test-server.sh in its launch file):
//   HUNTAWAY_FAKE_CLAUDE_FLOOD_DIR  (or IA_FAKE_CLAUDE_FLOOD_DIR)   the folder of `armed` and `floods.jsonl`
//   HUNTAWAY_FAKE_CLAUDE_FLOOD_FAKE (or IA_FAKE_CLAUDE_FLOOD_FAKE)  the fake claude to run (default this repository's)
//
// `armed` is JSON: {"tag": "<text>", "lines": 10000, "rate": 0, "usage": true}. A run that finds it removes it (one flood per arming)
// and appends {"tag", "lines", "first_written", "last_written"} (Date.now() ms) to floods.jsonl once its last line is
// written. The last line's text ends with "flood-last-line <tag>", for the measurement to look for in the database.
import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, renameSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const env = process.env
const dir = env.HUNTAWAY_FAKE_CLAUDE_FLOOD_DIR ?? env.IA_FAKE_CLAUDE_FLOOD_DIR
const fake =
  env.HUNTAWAY_FAKE_CLAUDE_FLOOD_FAKE ?? env.IA_FAKE_CLAUDE_FLOOD_FAKE ?? join(dirname(fileURLToPath(import.meta.url)), "../packages/testing/bin/fake-claude")

const args = process.argv.slice(2)
const streaming = args[args.indexOf("--output-format") + 1] === "stream-json"
const child = spawn(fake, args, { stdio: ["inherit", "pipe", "inherit"] })
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal))

/** The flood armed for this run, taken (renamed first, so two runs can't both take it), or null. */
const take = () => {
  if (!streaming || dir === undefined) return null
  const mine = join(dir, `armed.${process.pid}`)
  try {
    renameSync(join(dir, "armed"), mine)
    return JSON.parse(readFileSync(mine, "utf8"))
  } catch {
    return null
  }
}
let flood = take()

const write = (text) => (process.stdout.write(text) ? Promise.resolve() : new Promise((done) => process.stdout.once("drain", done)))
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

const USAGE = { input_tokens: 3, cache_creation_input_tokens: 1200, cache_read_input_tokens: 24000, output_tokens: 40 }

async function floodFrom(line) {
  const m = JSON.parse(line)
  const { tag, lines = 10_000, rate = 0, usage = true } = flood
  flood = null
  const pad = " lorem ipsum dolor sit amet".repeat(3)
  const first_written = Date.now()
  for (let i = 0; i < lines; i++) {
    const text = i === lines - 1 ? `flood line ${i + 1} of ${lines}${pad} flood-last-line ${tag}` : `flood line ${i + 1} of ${lines}${pad}`
    // The same usage on every line (unless armed with "usage": false), whichever fake's line it was (the old one's carry
    // none), as Claude Code's lines of
    // one reply carry their API call's.
    const message = { ...m.message, id: `msg_${randomUUID().replaceAll("-", "")}`, content: [{ type: "text", text }], usage: usage ? USAGE : undefined }
    await write(`${JSON.stringify({ ...m, uuid: randomUUID(), message })}\n`)
    if (rate > 0) await pause(1000 / rate)
  }
  const last_written = Date.now()
  appendFileSync(join(dir, "floods.jsonl"), `${JSON.stringify({ tag, lines, rate, first_written, last_written })}\n`)
}

// The old fake (Python) writes `"type": "assistant"`, the new one `"type":"assistant"`.
const isAssistant = (line) => {
  try {
    return JSON.parse(line).type === "assistant"
  } catch {
    return false
  }
}

// The child's stdout, line by line, in order.
let buffered = ""
let chain = Promise.resolve()
child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  buffered += chunk
  let at = buffered.indexOf("\n")
  while (at >= 0) {
    const line = buffered.slice(0, at + 1)
    buffered = buffered.slice(at + 1)
    chain = chain.then(() => (flood !== null && isAssistant(line) ? floodFrom(line) : write(line)))
    at = buffered.indexOf("\n")
  }
})
child.on("exit", (code, signal) => {
  chain = chain.then(() => write(buffered))
  void chain.then(() => process.stdout.write("", () => process.exit(signal ? 1 : (code ?? 0))))
})
