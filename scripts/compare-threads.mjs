#!/usr/bin/env node
// The thread sample of `import-legacy --check` (docs/plan/11-migration.md, `--check`): with an old test server on a copy
// of a board and a new test server on its import, each task's thread as the old server answers `GET /thread?limit=300`
// and as the new one's `threads.watch` snapshot gives it, compared item for item.
//
//   node scripts/compare-threads.mjs --old <old test server's env file> --new <new test server's env file> [--sample 200] [--json]
//
// The old env file is the old repository's test-server.sh output (IA_TEST_URL, IA_TEST_TOKEN); the new one this
// repository's (HUNTAWAY_TEST_URL, HUNTAWAY_TEST_TOKEN, HUNTAWAY_TEST_DATA_DIR). Both must be test servers on 127.0.0.1
// (never 7878 or 7879). The tasks are the new board's that have a thread, longest first then a spread of the rest, up to
// --sample. Items are compared by id, type and position, and by their content less what the new store does not keep
// (`turn_id`, `live`: docs/plan/11-migration.md, Table by table). Exits 1 if any thread differs.
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at < 0 ? fallback : args[at + 1]
}
const readEnv = (arg) => {
  const file = statSync(arg).isDirectory() ? join(arg, "env") : arg
  return Object.fromEntries([...readFileSync(file, "utf8").matchAll(/^export ((?:IA|HUNTAWAY)_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]))
}
const testServer = (url) => {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "") || ["7878", "7879"].includes(new URL(url).port)) throw new Error(`${url} isn't a test server`)
  return url
}
const oldVars = readEnv(opt("--old"))
const newVars = readEnv(opt("--new"))
const oldUrl = testServer(oldVars.IA_TEST_URL)
const newUrl = testServer(newVars.HUNTAWAY_TEST_URL)
const sample = Number(opt("--sample", 200))
const asJson = args.includes("--json")
const LIMIT = 300
const DROPPED = new Set(["turn_id", "live"])

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => !DROPPED.has(k) && value[k] !== undefined)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    )
  return value
}

async function oldThread(id) {
  const res = await fetch(`${oldUrl}/api/tasks/${id}/thread?limit=${LIMIT}`, { headers: { authorization: `Bearer ${oldVars.IA_TEST_TOKEN}` } })
  if (!res.ok) throw new Error(`old ${id}: ${res.status}`)
  return res.json()
}

async function newThread(id) {
  const ws = new WebSocket(`${newUrl.replace("http", "ws")}/api/rpc`)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", () => reject(new Error("can't open the new server's socket")))
  })
  try {
    return await new Promise((resolve, reject) => {
      ws.addEventListener("message", (event) => {
        for (const line of String(event.data).split("\n").filter(Boolean)) {
          const m = JSON.parse(line)
          if (m._tag === "Chunk") {
            ws.send(`${JSON.stringify({ _tag: "Ack", requestId: m.requestId })}\n`)
            const snapshot = m.values.find((v) => v.type === "snapshot")
            if (snapshot) resolve(snapshot)
          } else if (m._tag === "Exit" || m._tag === "Defect") reject(new Error(`new ${id}: ${line.slice(0, 200)}`))
        }
      })
      ws.send(
        `${JSON.stringify({ _tag: "Request", id: "1", tag: "threads.watch", payload: { task_id: id, limit: LIMIT }, headers: [["authorization", `Bearer ${newVars.HUNTAWAY_TEST_TOKEN}`]] })}\n`,
      )
    })
  } finally {
    ws.close()
  }
}

// The tasks with a thread, from the new board's database (read-only), longest first.
const counts = execFileSync(
  "sqlite3",
  ["-readonly", join(newVars.HUNTAWAY_TEST_DATA_DIR, "board.db"), "SELECT task_id, count(*) FROM thread_items GROUP BY task_id ORDER BY 2 DESC"],
  {
    encoding: "utf8",
  },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("|")[0])
const step = Math.max(1, Math.floor(counts.length / sample))
const tasks = [...new Set([...counts.slice(0, Math.ceil(sample / 4)), ...counts.filter((_, i) => i % step === 0)])].slice(0, sample)

const results = []
for (const id of tasks) {
  const [before, after] = await Promise.all([oldThread(id), newThread(id)])
  const a = before.items ?? []
  const b = after.items ?? []
  const differences = []
  if (a.length !== b.length) differences.push(`${b.length} items, old ${a.length}`)
  for (let i = 0; i < Math.min(a.length, b.length) && differences.length < 5; i++) {
    if (a[i].id !== b[i].id) differences.push(`item ${i}: id ${b[i].id}, old ${a[i].id}`)
    else if (JSON.stringify(canonical(a[i])) !== JSON.stringify(canonical(b[i]))) differences.push(`item ${i} (${a[i].id}, ${a[i].type}) differs`)
  }
  if ((before.requests ?? []).length !== (after.requests ?? []).length)
    differences.push(`${(after.requests ?? []).length} requests, old ${(before.requests ?? []).length}`)
  results.push({ task: id, items: a.length, differences })
}
const differing = results.filter((r) => r.differences.length > 0)
if (asJson) console.log(JSON.stringify({ compared: results.length, differing }, null, 2))
else {
  for (const r of differing) console.log(`${r.task}: ${r.differences.join("; ")}`)
  console.log(`${results.length} threads compared, ${differing.length} differ`)
}
process.exit(differing.length === 0 ? 0 : 1)
