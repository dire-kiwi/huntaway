import { Option, Predicate, Schema } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { BackgroundItem, BackgroundWork, RunId } from "@huntaway/contracts"

// A run's background work (HA-405; inventory 01, sections 2 and 3; huntaway's runs/background.ts and
// runner/background.ts): what the run's files say of the agent's background tasks, and the rules over them, as plain
// functions. `BackgroundWork` keeps the files and the task's column; `RunInput` decides what they mean for the input.

/**
 * One of the agent's background tasks, as Claude Code's `background_tasks_changed` lists it: its `task_type`
 * (`local_bash` for a shell, which the Bash tool's `run_in_background` and the Monitor tool start; `local_agent` for a
 * subagent), its description, and when the board first saw it; for a shell, the command and the tool that started it,
 * from its `task_started`. Null for what isn't known.
 */
export interface BackgroundTask {
  readonly id: string | null
  readonly type: string | null
  readonly description: string | null
  readonly since: string | null
  readonly command?: string | null | undefined
  readonly tool?: string | null | undefined
}

/**
 * The background tasks that ended during the agent's turn, and those whose outcome Claude Code has given it (`taken`:
 * the `<task-notification>` it replays when it does). One whose outcome it hasn't gets a turn of its own after that one.
 */
export interface BackgroundEnded {
  readonly ended: ReadonlyArray<string | null>
  readonly taken: ReadonlyArray<string>
}

/** A calls that may start a background shell, by tool use id (`background-calls`). */
export type BackgroundCalls = Readonly<Record<string, { readonly tool: string; readonly command: string | null }>>

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const json = (text: string | null): unknown => (text === null ? undefined : Option.getOrUndefined(parseJson(text)))
const str = (v: unknown): string | null => (typeof v === "string" ? v : null)
const field = (v: unknown, key: string): unknown => (Predicate.isObject(v) ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined)

const decodeTimestamp = Schema.decodeUnknownOption(Timestamp)

/** `background`: a JSON list of tasks, or (older builds) of their ids, or just their count. */
export const parseBackground = (text: string | null): ReadonlyArray<BackgroundTask> => {
  if (text === null) return []
  const list = json(text)
  if (Array.isArray(list)) {
    return list.map((t): BackgroundTask =>
      Predicate.isObject(t)
        ? {
            id: str(field(t, "id")),
            type: str(field(t, "type")),
            description: str(field(t, "description")),
            since: str(field(t, "since")),
            command: str(field(t, "command")),
            tool: str(field(t, "tool")),
          }
        : { id: str(t), type: null, description: null, since: null },
    )
  }
  const n = Number.parseInt(text, 10)
  return Number.isFinite(n) && n > 0 ? Array.from({ length: n }, (): BackgroundTask => ({ id: null, type: null, description: null, since: null })) : []
}

/** A JSON list of strings (`background-waited`); anything else is none. */
export const parseIds = (text: string | null): ReadonlyArray<string> => {
  const v = json(text)
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : []
}

/** `background-killed`: the tasks the board stopped. */
export const parseKilled = (text: string | null): ReadonlyArray<BackgroundTask> => {
  const v = json(text)
  return Array.isArray(v) ? parseBackground(text).filter((_, i) => Predicate.isObject(v[i])) : []
}

/** `background-ended`; an unreadable one (an older build's empty file) says some ended, none known taken in. */
export const parseEnded = (text: string | null): BackgroundEnded | null => {
  if (text === null) return null
  const v = json(text)
  const ended = field(v, "ended")
  const taken = field(v, "taken")
  if (Array.isArray(ended) && Array.isArray(taken)) {
    return { ended: ended.map(str), taken: taken.filter((id): id is string => typeof id === "string") }
  }
  return { ended: [null], taken: [] }
}

/** `background-calls`. */
export const parseCalls = (text: string | null): BackgroundCalls => {
  const v = json(text)
  if (!Predicate.isObject(v) || Array.isArray(v)) return {}
  const out: Record<string, { readonly tool: string; readonly command: string | null }> = {}
  for (const [id, call] of Object.entries(v)) {
    const tool = str(field(call, "tool"))
    if (tool !== null) out[id] = { tool, command: str(field(call, "command")) }
  }
  return out
}

/** The tasks in `e` whose outcome Claude Code hasn't given the agent yet. */
export const notTakenIn = (e: BackgroundEnded): ReadonlyArray<string | null> => e.ended.filter((id) => id === null || !e.taken.includes(id))

/**
 * Whether a background task keeps its run's task working once the turn that started it has ended: a subagent does, but
 * a shell (a dev server or a watcher as often as a build) only if the agent said it waits on it (`background_wait`).
 */
export const holds = (t: BackgroundTask, waited: ReadonlyArray<string>): boolean => t.type !== "local_bash" || (t.id !== null && waited.includes(t.id))

/** What a background task is, for the board. */
export const kindOf = (t: BackgroundTask): BackgroundItem["kind"] =>
  t.type === "local_bash" ? "shell" : t.type === "local_agent" || t.type === "remote_agent" || t.type === "in_process_teammate" ? "subagent" : "other"

/**
 * The run's background work as its task shows it; null without any. Idle: its turn has ended, no message sent to it
 * waits to start the next, and nothing left holds it.
 */
export const workOf = (
  run: RunId,
  list: ReadonlyArray<BackgroundTask>,
  waited: ReadonlyArray<string>,
  facts: { readonly betweenTurns: boolean; readonly live: boolean; readonly sent: boolean },
): BackgroundWork | null => {
  if (list.length === 0) return null
  return {
    run_id: run,
    idle: facts.betweenTurns && facts.live && !facts.sent && !list.some((t) => holds(t, waited)),
    tasks: list.map((t) => ({
      id: t.id,
      kind: kindOf(t),
      description: t.description ?? t.command ?? null,
      command: t.command ?? null,
      since: Option.getOrNull(decodeTimestamp(t.since)),
      waited: t.id !== null && waited.includes(t.id),
    })),
  }
}

/**
 * Claude Code's list (`tasks` of its `background_tasks_changed`), with what was known of each before: its type and
 * description, when it was first seen (`now` for a new one), and what started it.
 */
export const listed = (before: ReadonlyArray<BackgroundTask>, tasks: ReadonlyArray<unknown>, now: string): ReadonlyArray<BackgroundTask> =>
  tasks.map((t): BackgroundTask => {
    const id = str(field(t, "task_id"))
    const old = id === null ? undefined : before.find((b) => b.id === id)
    return {
      id,
      type: str(field(t, "task_type")) ?? old?.type ?? null,
      description: str(field(t, "description")) ?? old?.description ?? null,
      since: old?.since ?? now,
      command: old?.command ?? null,
      tool: old?.tool ?? null,
    }
  })

/** Most lines the lost-work note keeps, each at most this long. */
export const NOTE_ITEMS = 10
const NOTE_LABEL = 160

/** A stopped task's line in the note. */
export const labelOf = (t: BackgroundTask): string => {
  const what =
    t.command != null && t.description !== null && t.command !== t.description
      ? `${t.command} (${t.description})`
      : (t.command ?? t.description ?? "(no description)")
  const one = what.replace(/\s+/gu, " ").trim()
  return one.length > NOTE_LABEL ? `${one.slice(0, NOTE_LABEL - 1)}…` : one
}

/**
 * What the end of a run stopped of its background work: what the board stopped, then what was left going, but not what
 * the board left running as it ended the run (`detached`, HA-409) unless it stopped that after all.
 */
export const lostAtEnd = (
  killed: ReadonlyArray<BackgroundTask>,
  left: ReadonlyArray<BackgroundTask>,
  detached: ReadonlyArray<BackgroundTask> = [],
): ReadonlyArray<BackgroundTask> =>
  [...killed, ...left.filter((t) => t.id === null || !killed.some((k) => k.id === t.id))].filter(
    (t) => t.id === null || killed.some((k) => k.id === t.id) || !detached.some((d) => d.id === t.id),
  )

/** What the board left running as it ended the run (`detached`), unless it stopped that after all. */
export const leftAtEnd = (killed: ReadonlyArray<BackgroundTask>, detached: ReadonlyArray<BackgroundTask>): ReadonlyArray<BackgroundTask> =>
  detached.filter((d) => !killed.some((k) => k.id === d.id))

// ---- dev servers left running (HA-409) ----------------------------------------------------------------------------

/**
 * Words that make a command a server's, as whole words of it (`pnpm dev`, `python3 -m http.server`), or names ending
 * in `-server` or `_server` (`kiwipass-server`, `npx http-server`); `start` only as a package manager's script (`npm
 * start`, `pnpm run start`) or a dev server tool's (`expo start`), not another command's (`ia-api start`).
 */
const SERVER_WORDS = new Set(["dev", "serve", "server", "preview", "storybook", "runserver", "http.server"])
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"])
/** Tools whose `start` runs a server (`npx expo start`, `next start`, `react-native start`), as a package manager's does (HE-95). */
const START_TOOLS = new Set(["expo", "next", "react-native"])
/** Commands that only run the one after them (`exec target/release/app-server`, `nohup ./server`) (HE-95). */
const LAUNCHERS = new Set(["exec", "nohup", "setsid", "env", "command"])
/** Words of a command that ends by itself and that the agent waits on: a test run, a build, a check. */
const WAITED_WORDS = new Set([
  "test",
  "tests",
  "build",
  "check",
  "typecheck",
  "lint",
  "install",
  "ci",
  "cargo",
  "make",
  "pytest",
  "jest",
  "vitest",
  "mocha",
  "tsc",
  "e2e",
  "gradle",
  "gradlew",
])
/** Commands that wait on something or end by themselves (`timeout 900 pnpm test`, `until grep …; do sleep 5; done`). */
const WAITED_COMMANDS = new Set(["timeout", "until", "while", "for", "sleep", "wait"])
/** Commands that only set up the next one (`cd apps/server && …`) or say something (`echo server $?`). */
const SETUP_COMMANDS = new Set(["cd", "pushd", "export", "source", ".", "echo", "printf"])

/** A word's last path part (`target/release/app-server` → `app-server`). */
const baseName = (w: string): string => w.slice(w.lastIndexOf("/") + 1)

/**
 * Whether a script's or program's file name says it is waited on (`scripts/build.mjs`, `./run-tests.sh`, `ia-api
 * wait-idle`), but not a server's (`scripts/test-server.sh`).
 */
const waitedName = (w: string): boolean => {
  const name = baseName(w).replace(/\.[a-z0-9]+$/u, "")
  return !/[-_]server$/u.test(name) && name.split(/[-_.]/u).some((part) => WAITED_WORDS.has(part) || WAITED_COMMANDS.has(part))
}

/**
 * What a command's words say it is (`astro dev`, `pnpm preview`, `python3 -m http.server`, `vite`, `exec
 * target/release/app-server` a server's; `pnpm test`, `test:ui`, `cargo …`, `timeout …`, an `until` loop, `node
 * scripts/build.mjs` one the agent waits to hear the end of, even if what it runs listens on ports, as a test run's
 * servers do), or neither (`null`), by its words, not its text: redirections (`> $TMPDIR/test.log`, `2>/dev/null`),
 * `cd` and the like, variables and launchers (`exec`, `nohup`) before a command, and words with a `/` (paths such as
 * `apps/server`) don't count, but for the program's own path, which counts by its name, and a path's or a hyphenated
 * word's file name, which can say it's waited on. A Bash call's description ("Run the e2e tests") reads the same way.
 */
const commandKind = (command: string | null | undefined): "server" | "waited" | null => {
  if (command === null || command === undefined || command === "") return null
  const text = command.replace(/\d*(?:&>>?|>>?\|?|<)&?\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gu, " ")
  let server = false
  for (const segment of text.split(/&&|\|\||[;|&\n()]/u)) {
    const words = segment
      .trim()
      .split(/\s+/u)
      .map((w) => w.replace(/^["']+|["']+$/gu, ""))
      .filter((w) => w !== "")
    while (words.length > 0 && (/^[A-Za-z_]\w*=/u.test(words[0] ?? "") || LAUNCHERS.has(words[0] ?? ""))) words.shift()
    const first = words[0]
    if (first === undefined || SETUP_COMMANDS.has(first)) continue
    if (WAITED_COMMANDS.has(first.toLowerCase())) return "waited"
    for (let i = 0; i < words.length; i++) {
      const raw = (words[i] ?? "").toLowerCase()
      if ((i === 0 || raw.includes("/") || (raw.includes("-") && !raw.startsWith("-"))) && waitedName(raw)) return "waited"
      if (raw.includes("/") && i > 0) continue
      const w = baseName(raw)
      const head = w.split(":")[0] ?? w
      if (WAITED_WORDS.has(head) || WAITED_WORDS.has(w)) return "waited"
      if (SERVER_WORDS.has(w) || (w.includes(":") && SERVER_WORDS.has(head)) || /[-_]server$/u.test(w)) server = true
      if (w === "vite" && words[i + 1] !== "build") server = true
      const prev = words[i - 1] === "run" ? words[i - 2] : words[i - 1]
      const before = prev === undefined ? undefined : baseName(prev.toLowerCase())
      if (w === "start" && before !== undefined && (PACKAGE_MANAGERS.has(before) || START_TOOLS.has(before))) server = true
    }
  }
  return server ? "server" : null
}

/**
 * Whether a background shell may be left running as its turn ends (HA-409, HE-106): a dev server's, which never holds
 * its task in In progress, and not one the agent waits to hear the end of (a test run, a build, a check, a wait). Its
 * command says which; a command that says neither (`node --input-type=module < $TMPDIR/email-dev.mjs`, ODS-92's
 * preview server, fed its script on stdin) is read by the description the agent gave its Bash call, and one whose
 * description says neither too may be left as well. What makes it a server is that it listens on a port, which
 * `RunInput` looks at: this only rules out what the agent waits on. The old `looks_like_server`.
 */
export const mayOutliveTurn = (command: string | null | undefined, description?: string | null): boolean =>
  (commandKind(command) ?? commandKind(description)) !== "waited"

/**
 * Whether a run's turn can end with what it has going in the background left running (HA-409): all of it is shells the
 * Bash tool started (not a Monitor, which only reports to the agent) not waited on by their commands or descriptions (`mayOutliveTurn`)
 * and that the agent doesn't wait on. `RunInput` also asks that the task goes to review, the host can find the shells
 * again, and each of them listens on a port.
 */
export const detachable = (list: ReadonlyArray<BackgroundTask>, waited: ReadonlyArray<string>): boolean =>
  list.length > 0 &&
  list.every((t) => t.id !== null && t.type === "local_bash" && t.tool === "Bash" && mayOutliveTurn(t.command, t.description) && !holds(t, waited))

/** `tasks` added to `before` (what the board stopped), each id once. */
export const addKilled = (before: ReadonlyArray<BackgroundTask>, tasks: ReadonlyArray<BackgroundTask>): ReadonlyArray<BackgroundTask> => [
  ...before,
  ...tasks.filter((t) => t.id === null || !before.some((b) => b.id === t.id)),
]
