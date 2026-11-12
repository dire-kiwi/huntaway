#!/usr/bin/env node
// Seeds the old server's test board (dire-kiwi/huntaway's scripts/test-server.sh --seed at f2298f0c) through its REST
// API with a board of measurable size, for the measurements against the old server (docs/plan/10-testing.md,
// Measurements): two more projects, each on a fresh git repository in the test server's data dir, beside the seeded
// one, and N tasks (default 2,848) over the three projects and the columns, each with a title (so none is generated)
// and a description of 60 words. The new server gets the same board by importing it (scripts/copy-live-board.sh with
// HUNTAWAY_LIVE_DATA_DIR at the old test server's data dir). Test servers on 127.0.0.1 only, never 7878 or 7879.
//
//   node scripts/seed-old-board.mjs <the old test server's env file> [N]
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [envFile, count] = process.argv.slice(2)
if (envFile === undefined) throw new Error("usage: seed-old-board.mjs <env file> [N]")
const vars = Object.fromEntries([...readFileSync(envFile, "utf8").matchAll(/^export (IA_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]))
const url = vars.IA_TEST_URL
const token = vars.IA_TEST_TOKEN
const dir = vars.IA_TEST_DATA_DIR
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "") || ["7878", "7879"].includes(new URL(url).port)) throw new Error(`${url} isn't a test server`)
if (vars.IA_TEST_PROFILE === undefined || vars.IA_TEST_PROJECT === undefined) throw new Error("start the old test server with --seed")
const n = Number(count ?? 2848)

const api = async (method, path, body) => {
  const res = await fetch(`${url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const projects = [vars.IA_TEST_PROJECT]
for (const name of ["Alpha", "Beta"]) {
  const repo = join(dir, `repo-${name}`)
  mkdirSync(repo)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  writeFileSync(join(repo, "README.md"), `# ${name}\n`)
  execFileSync("git", ["-C", repo, "add", "README.md"])
  execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial commit"])
  projects.push((await api("POST", `/profiles/${vars.IA_TEST_PROFILE}/projects`, { name, repo_path: repo })).id)
}

// Most of a real board is done; the rest spread over the other columns.
const columns = [
  ["done", "done"],
  ["done", "done"],
  ["done", "wont_fix"],
  ["todo"],
  ["backlog"],
  ["backlog"],
  ["in_review"],
  ["needs_attention"],
  ["ready_for_merge"],
  ["done", "not_done"],
]
const words = "the board keeps every task its agent works through review and merge with a pull request and a worktree".split(" ")
const text = (i, length) => Array.from({ length }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ")
const started = Date.now()
for (let i = 0; i < n; i += 16) {
  await Promise.all(
    Array.from({ length: Math.min(16, n - i) }, (_, k) => {
      const at = i + k
      const [status, resolution] = columns[at % columns.length]
      return api("POST", `/projects/${projects[at % 3]}/tasks`, {
        title: `Task ${at}: ${text(at, 6)}`,
        description: text(at, 60),
        status,
        ...(resolution === undefined ? {} : { resolution }),
      })
    }),
  )
}
console.log(JSON.stringify({ projects: projects.length, tasks: n, ms: Date.now() - started }))
