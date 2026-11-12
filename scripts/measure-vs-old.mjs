#!/usr/bin/env node
// The measurements of docs/plan/10-testing.md (Measurements) on a test server, the new one (scripts/test-server.sh) or
// the old one (dire-kiwi/huntaway's scripts/test-server.sh at f2298f0c), told apart by its env file (HUNTAWAY_TEST_* or
// IA_TEST_*). Test servers on 127.0.0.1 only, never 7878 or 7879; the database is only ever opened read-only.
//
//   node scripts/measure-vs-old.mjs <what> --env <env file or data dir> [options]
//
//   rss                     the server's node process: RSS and swap, in MB
//   ready                   start to ready: the launcher's start (/proc, 10 ms ticks) to the time on the log line
//                           before HUNTAWAY_READY / IA_READY (the "listening" line), in ms
//   health --for S          GET /api/health every 5 ms for S seconds: p50, p90, p99, max (ms)
//   loads                   the old client's loads when it opens the board (apps/web/src/store.ts at f2298f0c: hosts;
//                           profiles, Claude configs, settings; per profile its projects, archived projects, tasks in no
//                           project and pens, settings and approvals; per project its tasks and reviews), in its order,
//                           as many at once as the browser's awaits allow: ms from the first request to the last
//                           answer, bytes, and how many
//   flood --title T [--lines N] [--rate R] [--no-usage] [--probe]
//                           one run of task T (by title) with N assistant lines (default 10,000) from
//                           scripts/fake-claude-flood.mjs, R a second (default 0, as fast as the pipe takes them): ms
//                           from the first line written to the last line's item in the database, the server's CPU per
//                           line (its user and system time from the message sent to the last item), and with --probe
//                           /api/health's p99 meanwhile. Each line carries the same `usage`, as Claude Code's do;
//                           --no-usage leaves it out (so the context meter has nothing to count)
//   runs --titles T1,T2,... [--lines N] [--rate R]
//                           a run of each task at once (each with N lines at R a second), RSS while all are live, once
//                           their last items are stored, when their agents have exited, and 10 s and 60 s after that
//
// The server's agent must be scripts/fake-claude-flood.mjs (with HUNTAWAY_FAKE_CLAUDE_FLOOD_DIR or
// IA_FAKE_CLAUDE_FLOOD_DIR in its launch file) for flood and runs.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"

const [what, ...rest] = process.argv.slice(2)
const opt = (flag, fallback) => {
  const at = rest.indexOf(flag)
  return at < 0 ? fallback : rest[at + 1]
}
const flag = (name) => rest.includes(name)
const envArg = opt("--env", null)
if (envArg === null) throw new Error("--env <test server env file or data dir>")
const envFile = statSync(envArg).isDirectory() ? join(envArg, "env") : envArg
const vars = Object.fromEntries([...readFileSync(envFile, "utf8").matchAll(/^export ((?:HUNTAWAY|IA)_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]))
const old = vars.IA_TEST_URL !== undefined
const v = (name) => vars[`${old ? "IA" : "HUNTAWAY"}_TEST_${name}`]
const url = v("URL")
const token = v("TOKEN")
const dataDir = v("DATA_DIR")
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "") || ["7878", "7879"].includes(new URL(url).port)) throw new Error(`${url} isn't a test server`)

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const percentile = (list, p) => {
  const sorted = list.toSorted((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits
const print = (o) => console.log(JSON.stringify(o))

// The launcher's PID (the env file's, which goes stale after a restart: server.pid is the current one) and its node.
const launcherPid = () => Number(readFileSync(join(dataDir, "server.pid"), "utf8").trim())
const nodePid = () => {
  const pid = launcherPid()
  const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)
  const node = children.find((c) => readFileSync(`/proc/${c}/comm`, "utf8").trim().startsWith("node"))
  if (node === undefined) throw new Error(`no node under ${pid}`)
  return Number(node)
}
const status = (pid, field) => Number(readFileSync(`/proc/${pid}/status`, "utf8").match(new RegExp(`^${field}:\\s+(\\d+)`, "m"))?.[1] ?? 0)
const rss = () => {
  const pid = nodePid()
  return { rss_mb: round(status(pid, "VmRSS") / 1024), swap_mb: round(status(pid, "VmSwap") / 1024) }
}
const TICK = 100
const cpuMs = (pid) => {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / TICK
}

const database = () => {
  const file = ["board.db", "huntaway-2.db", "huntaway.db"].map((f) => join(dataDir, f)).find((f) => existsSync(f))
  return new DatabaseSync(file, { readOnly: true })
}
const taskId = (db, title) => {
  const row = db.prepare("SELECT id FROM tasks WHERE title = ?").get(title)
  if (row === undefined) throw new Error(`no task "${title}"`)
  return row.id
}

/** A message to the task: the new server's `tasks.send`, the old one's POST /tasks/{id}/messages. */
async function send(id, text) {
  if (old) {
    const res = await fetch(`${url}/api/tasks/${id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) throw new Error(`send: ${res.status} ${await res.text()}`)
    return
  }
  const body = `${JSON.stringify({ _tag: "Request", id: "1", tag: "tasks.send", payload: { id, text }, headers: [["authorization", `Bearer ${token}`]] })}\n`
  const res = await fetch(`${url}/api/rpc`, { method: "POST", headers: { "content-type": "application/ndjson" }, body })
  const answer = await res.text()
  if (!answer.includes('"Success"')) throw new Error(`send: ${answer.slice(0, 300)}`)
}

/** /api/health every 5 ms until stopped: the answers' times. */
function probe() {
  const times = []
  const state = { on: true }
  const loop = (async () => {
    while (state.on) {
      const t = performance.now()
      await fetch(`${url}/api/health`).then((r) => r.text())
      times.push(performance.now() - t)
      await pause(5)
    }
  })()
  return async () => {
    state.on = false
    await loop
    return {
      p50: round(percentile(times, 50)),
      p90: round(percentile(times, 90)),
      p99: round(percentile(times, 99)),
      max: round(Math.max(0, ...times)),
      n: times.length,
    }
  }
}

const floodDir = () => {
  const launch = readFileSync(join(dataDir, "launch"), "utf8")
  const dir = launch.match(/^export (?:HUNTAWAY|IA)_FAKE_CLAUDE_FLOOD_DIR=(.*)$/m)?.[1]
  if (dir === undefined) throw new Error("the server's agent isn't scripts/fake-claude-flood.mjs (no FLOOD_DIR in its launch file)")
  return dir
}
/** Arms a flood and starts the task's run; resolves once the run took it. */
async function startFlood(id, lines, rate, usage = true) {
  const dir = floodDir()
  const tag = randomUUID().slice(0, 8)
  writeFileSync(join(dir, "armed.tmp"), JSON.stringify({ tag, lines, rate, usage }))
  const { renameSync } = await import("node:fs")
  renameSync(join(dir, "armed.tmp"), join(dir, "armed"))
  await send(id, `Please reply (flood ${tag}).`)
  for (let i = 0; existsSync(join(dir, "armed")); i++) {
    if (i > 3000) throw new Error("no run took the flood in 30 s")
    await pause(10)
  }
  return tag
}
const floodRecord = (tag) =>
  readFileSync(join(floodDir(), "floods.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((r) => r.tag === tag)
/** Waits until the task's last line is stored: the time it was seen (Date.now()). */
async function stored(db, id, tag, timeoutMs = 300_000) {
  const last = db.prepare("SELECT data FROM thread_items WHERE task_id = ? ORDER BY pos DESC LIMIT 4")
  const needle = `flood-last-line ${tag}`
  const until = Date.now() + timeoutMs
  for (;;) {
    if (last.all(id).some((r) => r.data.includes(needle))) return Date.now()
    if (Date.now() > until) throw new Error(`the last line of flood ${tag} wasn't stored in ${timeoutMs} ms`)
    await pause(2)
  }
}
/** The flood's agents still running (scripts/fake-claude-flood.mjs processes with this flood dir). */
const floodAgents = () => {
  const dir = floodDir()
  let n = 0
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      // `node …/fake-claude-flood.mjs …` (the server's own command line names it too, as its --claude-bin).
      const script = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[1] ?? ""
      if (!script.endsWith("fake-claude-flood.mjs")) continue
      if (
        readFileSync(`/proc/${pid}/environ`, "utf8")
          .split("\0")
          .some((e) => e.endsWith(`_FAKE_CLAUDE_FLOOD_DIR=${dir}`))
      )
        n++
    } catch {
      // gone meanwhile
    }
  }
  return n
}

if (what === "rss") print(rss())
else if (what === "ready") {
  const pid = launcherPid()
  // Its start, in ticks since boot, against the uptime now (btime drifts with the clock).
  const startTicks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19])
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0])
  const started = Date.now() - (uptime * 1000 - (startTicks * 1000) / TICK)
  const log = readFileSync(join(dataDir, "server.log"), "utf8").split("\n")
  const at = log.findIndex((l) => /^(HUNTAWAY|IA)_READY /.test(l))
  if (at < 0) throw new Error("not ready")
  const stamp = log
    .slice(0, at)
    .findLast((l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l))
    ?.split(" ")[0]
  print({ ready_ms: Math.round(Date.parse(stamp) - started) })
} else if (what === "health") {
  const stop = probe()
  await pause(Number(opt("--for", 10)) * 1000)
  print(await stop())
} else if (what === "loads") {
  if (!old) throw new Error("loads is the old client's; for the new one, scripts/event-loop-probe.mjs --only 'board snapshot'")
  let bytes = 0
  let count = 0
  const get = async (path) => {
    const res = await fetch(`${url}/api${path}`, { headers: { authorization: `Bearer ${token}` } })
    const text = await res.text()
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${text.slice(0, 200)}`)
    bytes += text.length
    count++
    return JSON.parse(text)
  }
  const t = performance.now()
  const hosts = await get("/hosts")
  const h = `/h/${encodeURIComponent(hosts.find((x) => x.local).id)}`
  const [profiles] = await Promise.all([get(`${h}/profiles`), get(`${h}/claude-configs`), get(`${h}/settings`)])
  await Promise.all([
    get(`${h}/settings`),
    get(`${h}/project-approvals?all=true&automations=true&workflows=true`),
    ...profiles.map(async (p) => {
      const [projects] = await Promise.all([
        get(`${h}/profiles/${p.id}/projects`),
        get(`${h}/profiles/${p.id}/group-tasks?include_assistant=true&include_pens=true&include_pen_threads=true`),
        get(`${h}/profiles/${p.id}/projects?archived=true`),
        get(`${h}/profiles/${p.id}/pens`),
      ])
      await Promise.all(projects.flatMap((pr) => [get(`${h}/projects/${pr.id}/tasks?kind=task`), get(`${h}/projects/${pr.id}/tasks?kind=review`)]))
    }),
  ])
  print({ ms: Math.round(performance.now() - t), mb: round(bytes / 1e6, 2), loads: count })
} else if (what === "flood") {
  const db = database()
  const id = taskId(db, opt("--title", null))
  const lines = Number(opt("--lines", 10_000))
  const rate = Number(opt("--rate", 0))
  const pid = nodePid()
  const stop = flag("--probe") ? probe() : null
  const cpu0 = cpuMs(pid)
  const tag = await startFlood(id, lines, rate, !flag("--no-usage"))
  const seen = await stored(db, id, tag)
  const cpu1 = cpuMs(pid)
  const record = floodRecord(tag)
  const health = stop === null ? undefined : await stop()
  print({
    ms: seen - record.first_written,
    written_ms: record.last_written - record.first_written,
    cpu_ms_per_line: round((cpu1 - cpu0) / lines, 3),
    lines,
    rate,
    health,
  })
} else if (what === "runs") {
  const db = database()
  const ids = opt("--titles", "")
    .split(",")
    .map((t) => taskId(db, t))
  const lines = Number(opt("--lines", 300))
  const rate = Number(opt("--rate", 20))
  const before = rss()
  const tags = []
  for (const id of ids) tags.push(await startFlood(id, lines, rate))
  await pause(2000)
  const live = { ...rss(), agents: floodAgents() }
  await Promise.all(ids.map((id, i) => stored(db, id, tags[i])))
  const done = rss()
  for (let i = 0; floodAgents() > 0; i++) {
    if (i > 6000) throw new Error("the agents didn't exit in 60 s")
    await pause(10)
  }
  const ended = rss()
  await pause(10_000)
  const after10 = rss()
  await pause(50_000)
  print({ before, live, stored: done, ended, after_10s: after10, after_60s: rss() })
} else {
  console.error("usage: measure-vs-old.mjs rss|ready|health|loads|flood|runs --env <file> …")
  process.exit(2)
}
