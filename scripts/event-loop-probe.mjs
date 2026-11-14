#!/usr/bin/env node
// How long the server's one thread is held up (docs/plan/10-testing.md, Measurements): carried over from
// dire-kiwi/huntaway-legacy (scripts/event-loop-probe.mjs at f2298f0c), pointed at the new server's RPC. While it runs,
// `GET /api/health` is fetched every 5 ms and an RPC `Ping` is sent every 5 ms over a websocket on `/api/rpc` (the RPC
// server answers `Pong`); how late those answers come is the delay a client sees.
//
//   scripts/test-server.sh --seed > $TMPDIR/server-env
//   node scripts/event-loop-probe.mjs --env $TMPDIR/server-env [--threads N] [--only REGEX] [--json]
//   node scripts/event-loop-probe.mjs --env $TMPDIR/server-env --for 10      # just probe, for 10 s
//
//   --env <file|dir>  test-server.sh's output saved to a file, or its data dir (default $HUNTAWAY_TEST_ENV)
//   --threads N       read the N longest threads (default 3), whole and as the UI's first page
//   --only REGEX      only the reads whose label matches
//   --for S           no reads: probe for S seconds while something else loads the server (a busy agent, say), and
//                     print the answers' p50, p90, p99 and max
//   --json            the rows as JSON
//
// The usual reads are the board's heavy ones, each alone, one after the other: `board.watch`'s snapshot, every
// profile's and the two largest projects' `tasks.list`, and the longest threads' `threads.watch` snapshots (found in the
// test server's database, read-only, with sqlite3). For each: how long it took, its size, and the slowest probe
// answers meanwhile. The old server's own figures (`/api/debug/event-loop`) have no counterpart yet.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const at = args.indexOf(flag)
  if (at < 0) return fallback
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
const envArg = opt("--env", process.env.HUNTAWAY_TEST_ENV)
const nthreads = Number(opt("--threads", 3))
const only = opt("--only", null)
const forSeconds = opt("--for", null)
const asJson = args.includes("--json")
if (!envArg) throw new Error("--env <test-server env file or data dir>")

const envFile = statSync(envArg).isDirectory() ? join(envArg, "env") : envArg
const vars = Object.fromEntries([...readFileSync(envFile, "utf8").matchAll(/^export (HUNTAWAY_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]))
const url = vars.HUNTAWAY_TEST_URL
const token = vars.HUNTAWAY_TEST_TOKEN
// Test servers only: never a live board.
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "") || ["7878", "7879"].includes(new URL(url).port)) throw new Error(`${url} isn't a test server`)
const wsUrl = `${url.replace("http", "ws")}/api/rpc`

/** A websocket on /api/rpc, open. */
const socket = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.addEventListener("open", () => resolve(ws))
    ws.addEventListener("error", () => reject(new Error(`can't open ${wsUrl}`)))
  })

// A method with no payload takes null.
const request = (id, tag, payload = null) => `${JSON.stringify({ _tag: "Request", id, tag, payload, headers: [["authorization", `Bearer ${token}`]] })}\n`

/** One RPC over HTTP: its value and the bytes of the answer. */
async function call(tag, payload) {
  const res = await fetch(`${url}/api/rpc`, { method: "POST", headers: { "content-type": "application/ndjson" }, body: request("1", tag, payload) })
  const text = await res.text()
  const exit = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((m) => m._tag === "Exit")
  if (exit?.exit?._tag !== "Success") throw new Error(`${tag}: ${text.slice(0, 200)}`)
  return { value: exit.exit.value, bytes: text.length }
}

/** A subscription's first message of `type` (its snapshot), then the subscription ended: the bytes of its frame. */
async function firstOf(tag, payload, type) {
  const ws = await socket()
  try {
    return await new Promise((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        const text = String(event.data)
        for (const line of text.split("\n").filter(Boolean)) {
          const m = JSON.parse(line)
          if (m._tag === "Chunk") {
            ws.send(`${JSON.stringify({ _tag: "Ack", requestId: m.requestId })}\n`)
            if (m.values.some((v) => v.type === type)) resolve({ bytes: text.length })
          } else if (m._tag === "Exit" || m._tag === "Defect") reject(new Error(`${tag}: ${line.slice(0, 200)}`))
        }
      })
      ws.send(request("1", tag, payload))
    })
  } finally {
    ws.close()
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Probes the server every 5 ms until stopped: the answers to /api/health and to an RPC ping, in ms. */
async function probe() {
  const health = []
  const pings = []
  const state = { on: true }
  const ws = await socket()
  let pong = null
  ws.addEventListener("message", (event) => {
    if (String(event.data).includes('"Pong"')) pong?.()
  })
  const loops = [
    (async () => {
      while (state.on) {
        const t = performance.now()
        await fetch(`${url}/api/health`).then((r) => r.text())
        health.push(performance.now() - t)
        await pause(5)
      }
    })(),
    (async () => {
      while (state.on) {
        const t = performance.now()
        await new Promise((resolve) => {
          pong = resolve
          ws.send(`${JSON.stringify({ _tag: "Ping" })}\n`)
        })
        pings.push(performance.now() - t)
        await pause(5)
      }
    })(),
  ]
  return async () => {
    state.on = false
    await Promise.all(loops)
    ws.close()
    return { health, pings }
  }
}

const percentile = (list, p) => {
  const sorted = list.toSorted((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const ms = (x) => Math.round(x * 10) / 10

if (forSeconds !== null) {
  const stop = await probe()
  await pause(Number(forSeconds) * 1000)
  const { health, pings } = await stop()
  const row = (list) => ({
    p50: ms(percentile(list, 50)),
    p90: ms(percentile(list, 90)),
    p99: ms(percentile(list, 99)),
    max: ms(Math.max(0, ...list)),
    n: list.length,
  })
  const result = { health: row(health), ping: row(pings) }
  if (asJson) console.log(JSON.stringify(result))
  else
    for (const [name, r] of Object.entries(result))
      console.log(`${name.padEnd(7)} p50 ${r.p50} ms  p90 ${r.p90} ms  p99 ${r.p99} ms  max ${r.max} ms  (${r.n} answers)`)
  process.exit(0)
}

async function measure(label, read) {
  const stop = await probe()
  await pause(30)
  const t = performance.now()
  let bytes = 0
  let error = null
  try {
    bytes = (await read()).bytes
  } catch (e) {
    error = e.message
  }
  const took = Math.round(performance.now() - t)
  await pause(30)
  const { health, pings } = await stop()
  return {
    label,
    took_ms: took,
    mb: Math.round(bytes / 1e5) / 10,
    health_max: Math.round(Math.max(0, ...health)),
    ping_max: Math.round(Math.max(0, ...pings)),
    error,
  }
}

async function usual() {
  const list = [["board snapshot", () => firstOf("board.watch", {}, "snapshot")]]
  const profiles = (await call("profiles.list")).value
  const projects = []
  for (const p of profiles) {
    list.push([`profile tasks (${p.name})`, () => call("tasks.list", { filter: { _tag: "ByProfile", profile_id: p.id } })])
    projects.push(...(await call("projects.list", { profile_id: p.id })).value)
  }
  const sized = await Promise.all(
    projects.map(async (pr) => ({ pr, n: (await call("tasks.list", { filter: { _tag: "ByProject", project_id: pr.id } })).value.length })),
  )
  for (const { pr } of sized.toSorted((a, b) => b.n - a.n).slice(0, 2)) {
    list.push([`project tasks (${pr.name})`, () => call("tasks.list", { filter: { _tag: "ByProject", project_id: pr.id } })])
  }
  // The longest threads, by the size of their items (read from the test server's database).
  const db = join(vars.HUNTAWAY_TEST_DATA_DIR, "board.db")
  const longest = existsSync(db)
    ? execFileSync(
        "sqlite3",
        ["-readonly", db, `SELECT task_id FROM thread_items GROUP BY task_id ORDER BY sum(length(data)) DESC LIMIT ${Math.max(0, Math.floor(nthreads))}`],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean)
    : []
  for (const id of longest) {
    list.push([`thread, whole (${id.slice(0, 8)})`, () => firstOf("threads.watch", { task_id: id, limit: 1_000_000 }, "snapshot")])
    list.push([`thread, first page (${id.slice(0, 8)})`, () => firstOf("threads.watch", { task_id: id, limit: 100 }, "snapshot")])
  }
  return list
}

const rows = []
for (const [label, read] of await usual()) {
  if (only !== null && !new RegExp(only).test(label)) continue
  const r = await measure(label, read)
  rows.push(r)
  if (!asJson) {
    const err = r.error ? `  ERROR ${r.error.slice(0, 80)}` : ""
    console.log(
      `${label.padEnd(36)} ${String(r.took_ms).padStart(6)} ms  ${String(r.mb).padStart(6)} MB  health ${String(r.health_max).padStart(5)} ms  ping ${String(r.ping_max).padStart(5)} ms${err}`,
    )
  }
}
if (asJson) console.log(JSON.stringify(rows, null, 1))
