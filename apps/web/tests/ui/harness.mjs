// Shared setup for the browser checks in this folder (docs/plan/10-testing.md, the whole-app checks): a test server of
// this worktree (scripts/test-server.sh, no agents) and a browser on it (scripts/ui-check.mjs). They test the built UI,
// so run `pnpm build` (and `pnpm install` at the top of the checkout) first; `pnpm test:ui` builds it.
//
// The old harness's `api(method, path, body)` called the REST API; `server.rpc(method, payload)` calls the same RPC
// methods the web app does, over `POST /api/rpc` (newline-delimited JSON, as `huntaway rpc` does). The old checks ran on
// the demo board (`--demo`); these make the board they need with `seedBoard`, so they say what they start from.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll } from "vite-plus/test"
import { launch, open } from "../../../../scripts/ui-check.mjs"

const script = fileURLToPath(new URL("../../../../scripts/test-server.sh", import.meta.url))

/** A failed RPC: `tag` is the error's `_tag` (`NotFound`, `Conflict`…), `error` all of it. */
export class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?._tag ?? "error"}${error?.message ? `: ${error.message}` : ""}`)
    this.tag = error?._tag
    this.error = error
  }
}

let requestId = 0

/**
 * Start a test server (agents off, no open token, so a browser without the token sees the token screen). Returns { url, token, dataDir, rpc, stop }.
 */
export function startServer(...args) {
  // Never a real claude: test-server.sh runs agents with the real binary by default, and moving a fresh task to In
  // progress sends the message that starts its agent. A check that needs agents to run (a Start button, a run) asks for
  // the fake one with `--fake-claude`.
  if (!args.includes("--fake-claude") && !args.includes("--no-agents")) args = [...args, "--no-agents"]
  const out = execFileSync(script, ["start", ...args], {
    encoding: "utf8",
    env: { ...process.env, HUNTAWAY_TEST_OPEN_TOKEN: "0" },
  })
  const vars = Object.fromEntries([...out.matchAll(/^(?:export )?(HUNTAWAY_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]))
  const url = vars.HUNTAWAY_TEST_URL
  const token = vars.HUNTAWAY_TEST_TOKEN
  /** Calls `method` with `payload` (null for a method that takes none) and resolves to its result, or rejects with an RpcError. */
  const rpc = async (method, payload = null) => {
    const id = String(++requestId)
    const res = await fetch(`${url}/api/rpc`, {
      method: "POST",
      // A connection of its own for each call (HA-392: one kept alive past the server's idle timeout failed the next call).
      headers: { authorization: `Bearer ${token}`, "content-type": "application/ndjson", connection: "close" },
      body: `${JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] })}\n`,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text}`)
    const exit = text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m._tag === "Exit" && m.requestId === id)?.exit
    if (!exit) throw new Error(`${method}: no answer in ${text}`)
    if (exit._tag === "Success") return exit.value
    const fail = exit.cause?.find((c) => c._tag === "Fail")
    if (fail) throw new RpcError(method, fail.error)
    throw new Error(`${method}: ${JSON.stringify(exit.cause)}`)
  }
  // Its error, if it fails, is in the exception's message.
  const stop = () => execFileSync(script, ["stop", vars.HUNTAWAY_TEST_DATA_DIR], { stdio: ["ignore", "ignore", "pipe"] })
  return { url, token, dataDir: vars.HUNTAWAY_TEST_DATA_DIR, rpc, stop }
}

/** A git repository at `dir` with a commit, so a project on it can have worktrees (else its board says it isn't ready). */
export function gitRepo(dir) {
  mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-q", dir])
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"])
  return dir
}

/** A new git repository for a project, in the server's data folder (removed with it). */
export const repoDir = (server, name) => gitRepo(mkdtempSync(join(server.dataDir, `repo-${name}-`)))

/** A profile named `name`. */
export const makeProfile = (server, name = "Default") => server.rpc("profiles.create", { profile: { name } })

/** A project in `profile` on a fresh git repository. */
export const makeProject = (server, profile, name, key) =>
  server.rpc("projects.create", { project: { profile_id: profile.id, name, repo_path: repoDir(server, name.toLowerCase()), ...(key ? { key } : {}) } })

/** A task in `project` (`fields` as `tasks.create` takes them: title, status, description…). */
export const makeTask = (server, project, fields) => server.rpc("tasks.create", { task: { project_id: project.id, ...fields } })

/** Changes a task as `tasks.update` does. */
export const updateTask = (server, task, patch) => server.rpc("tasks.update", { id: task.id, patch })

/** A project's tasks, by title. */
export const tasksByTitle = async (server, project) =>
  Object.fromEntries((await server.rpc("tasks.list", { filter: { _tag: "ByProject", project_id: project.id } })).map((t) => [t.title, t]))

/**
 * The board most checks start from, as the old demo board had it: a profile "Default" with a project "Demo" (key DEM)
 * on a git repository, and `tasks` in it (each `{ title, status?, … }`), made in order. Returns { profile, project, tasks }.
 */
export async function seedBoard(server, tasks = []) {
  const profile = await makeProfile(server, "Default")
  const project = await makeProject(server, profile, "Demo", "DEM")
  const made = []
  for (const t of tasks) made.push(await makeTask(server, project, t))
  return { profile, project, tasks: made }
}

/**
 * A board whose agents can run, for a server started with `--fake-claude`: an agent config on a folder of the server's
 * own (the fake agent reads nothing from it), a profile "Default" on it, and a project "Demo" (key DEM). Returns
 * { config, profile, project }.
 */
export async function seedAgentBoard(server) {
  const dir = join(server.dataDir, "claude-config")
  mkdirSync(dir, { recursive: true })
  const config = await server.rpc("configs.create", { config: { name: "test", config_dir: dir } })
  const profile = await server.rpc("profiles.create", { profile: { name: "Default", claude_config_ids: [config.id] } })
  const project = await makeProject(server, profile, "Demo", "DEM")
  return { config, profile, project }
}

/** The tasks of the old demo board's Demo project that the board's checks use, by column. */
export const DEMO_TASKS = [
  { title: "An idea for later", status: "backlog" },
  { title: "Try dragging this card to another column", status: "todo" },
  { title: "Edit this task's title and description", status: "todo" },
  { title: "Something being worked on", status: "in_progress" },
  { title: "A task waiting on an answer", status: "needs_attention" },
  { title: "Finished work to look over", status: "in_review" },
  { title: "Plan a dark mode for the demo site", status: "in_review", labels: ["plan"] },
  { title: "Merged and closed", status: "done" },
]

let failures = 0

// One browser for the file's checks, each in a context of its own (as fresh as a new browser's): launching one for each
// took longer than most checks. Launched again if it went away (a crash). It's Playwright's headless shell where that's
// installed, which is lighter, and the full Chromium for the checks that ask for it (`fullBrowser`, 6.8): notifications
// and push.
const browsers = new Map()
const sharedBrowser = async (full = false) => {
  if (!(await browsers.get(full))?.isConnected()) browsers.set(full, launch(undefined, { shell: !full }))
  return browsers.get(full)
}
afterAll(async () => {
  for (const b of browsers.values()) await (await b)?.close()
})

/**
 * The board's animations and transitions take no time: Playwright waits for what it clicks to stop moving, and a click
 * in a panel as it slid in waited about 250ms for it.
 */
function noMotion() {
  if (window !== window.top) return
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style")
    style.textContent =
      "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }"
    document.head.append(style)
  })
}

/**
 * Run `fn` with a browser on the server (see `open` in scripts/ui-check.mjs), then close it. Page and console errors that
 * weren't allowed fail the check; if `fn` failed as well, they're added to its error, and a screenshot of the page is
 * saved to <tmp>/ui-check-<pid>-<n>-failed.png. `fullBrowser`: in the full Chromium rather than the headless shell, for
 * notifications and push.
 */
export async function withBrowser(server, { fullBrowser = false, ...opts }, fn) {
  const ui = await open({ url: server.url, token: server.token, log: () => {}, ...opts, browser: opts.browser ?? (await sharedBrowser(fullBrowser)) })
  await ui.context.addInitScript(noMotion)
  try {
    await fn(ui)
  } catch (e) {
    if (ui.errors.length) e.message += `\npage or console errors:\n${ui.errors.join("\n")}`
    const shot = join(tmpdir(), `ui-check-${process.pid}-${++failures}-failed.png`)
    if (
      await ui.page.screenshot({ path: shot }).then(
        () => true,
        () => false,
      )
    )
      e.message += `\nthe page at the time: ${shot} (${ui.page.url()})`
    throw e
  } finally {
    await ui.close()
  }
  if (ui.errors.length) throw new Error(`page or console errors:\n${ui.errors.join("\n")}`)
}

/**
 * Runs `check` (which throws, as an assert does, until what it checks holds) until it passes, for up to `ms`: for what
 * the server saves after a click, which a check would otherwise sleep for and then read. Returns what `check` returned,
 * or throws its last error.
 */
export async function eventually(check, ms = 5000) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 25))) {
    try {
      return await check()
    } catch (e) {
      if (Date.now() > end) throw e
    }
  }
}

export { replies, sampleThread, seedThread } from "./threads.mjs"

/** An RPC's answer, as `routeRpc`'s handler gives it: a success with `value`, or a failure with the tagged `error`. */
export const success = (value) => ({ _tag: "Success", value })
export const failure = (error) => ({ _tag: "Failure", cause: [{ _tag: "Fail", error }] })

/**
 * Sits between the page and its server on the RPC websocket (`/api/rpc`), where the old checks routed `/api/...`
 * requests with `page.route`. Every request the page makes is recorded (`{ tag, payload }`, oldest first, in the array
 * it returns) and given to `handle`, which returns undefined to let it through, an answer (`success(…)`,
 * `failure(…)`) to give instead of the server's, or a promise of either: a request held until the test lets it go.
 * Call it before the page opens.
 */
export async function routeRpc(page, handle = () => undefined) {
  const calls = []
  await page.routeWebSocket(/\/api\/rpc$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      for (const line of String(message).split("\n").filter(Boolean)) {
        const request = JSON.parse(line)
        if (request._tag !== "Request") {
          server.send(`${line}\n`)
          continue
        }
        calls.push({ tag: request.tag, payload: request.payload })
        void Promise.resolve(handle(request)).then((exit) => {
          if (exit === undefined) server.send(`${line}\n`)
          else ws.send(`${JSON.stringify({ _tag: "Exit", requestId: request.id, exit })}\n`)
        })
      }
    })
  })
  return calls
}

/** A gate for `routeRpc`: `hold()` is a promise the handler returns, which `release()` lets through. */
export function gate() {
  const waiting = []
  return {
    held: () => waiting.length,
    hold: () => new Promise((resolve) => waiting.push(resolve)),
    release: (answer) => waiting.shift()?.(answer),
  }
}

/** A task's thread's scrolled area. */
export const threadScroller = (page) => page.locator("[data-thread] [data-autoscroll]").first()

/** A kanban column (or list section) by its label, and the titles of its cards top to bottom. */
export const column = (page, label) => page.locator("section", { has: page.locator(`span:text-is("${label}")`) })
export const titles = (page, label) => column(page, label).locator("[data-task] > div:nth-child(2)").allTextContents()
