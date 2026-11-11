// A stand-in `codex app-server` for test servers and whole-server tests (`HUNTAWAY_CODEX_BIN`): the board's Codex runs
// (the adapter, `huntaway codex-run`) and its Codex queries without a model. Plain Node: it stands in for an outside
// program. Started as `fake-codex [-c key=value …] app-server`, it speaks the app-server's JSON lines (no `jsonrpc`
// field) on stdin and stdout, and exits when its stdin ends, as the app-server does.
//
// It answers `initialize`, `skills/extraRoots/set`, `thread/start` (a new thread, `thread/started`; it records whether it
// was given dynamic tools), `thread/resume` (the thread asked for), `thread/revert`, `turn/start`, `turn/steer` (taken
// into the turn going, and said in its reply), `turn/interrupt` (the turn going ends as interrupted) and
// `thread/compact/start` (a compaction: a contextCompaction item, `turn/completed` and `thread/compacted`). Its queries:
// `model/list`, `skills/list`, `account/rateLimits/read` and `config/read`, with small fixed answers.
//
// A turn says `turn/started`, then does what its text asks (below), then streams its reply (`item/started`,
// `item/agentMessage/delta`s, `item/completed` of an agentMessage), its token use (`thread/tokenUsage/updated`) and
// `turn/completed`. Markers in a turn's text, like fake-claude's:
//   fake-ask-permission       a command (`item/started` commandExecution), its approval asked
//                             (`item/commandExecution/requestApproval`); it waits for the answer, then completes the
//                             item (or declines it), and the reply says "permission Bash: <decision>"
//   fake-question             a question (`item/tool/requestUserInput`, question id `q1`); it waits for the answer, and
//                             the reply says "question: <answers as JSON>"
//   fake-board-call <tool> <JSON arguments>   (a line each) a call of the board's dynamic tool (`item/tool/call` in
//                             namespace "huntaway"); it waits for the answer, and the reply says "board <tool>: <text>"
//   fake-until-interrupted    the turn goes on until `turn/interrupt`
//   fake-usage-limit          the turn fails for the usage limit (`codexErrorInfo: "usageLimitExceeded"`)
//   fake-commit               (or a turn asked to fix a review's issues, "Fix them, then commit") an empty commit
//                             ("fake work") in its working directory, as fake-claude makes
// Merges, as fake-claude's (plan task 4.7): with FAKE_CODEX_MERGE=pr and FAKE_CODEX_GH the fake gh, a turn asked to merge
// (the merge request, 'The user moved this task to "Ready for merge". … Merge branch `<branch>` into `<base>`', not the
// summary an approval asks for, which says "Do not merge yet") runs `<FAKE_CODEX_GH> pr merge <branch> --squash`, then
// calls the board's `update_task` with `status: "done"` for its task ($HUNTAWAY_TASK_ID). It never runs another gh.
// A `turn/interrupt` while it waits for an answer, or sleeps, ends the turn as interrupted.
//
// Knobs (environment):
//   FAKE_CODEX_LOG                 appends a JSON line for its start (args, cwd, CODEX_HOME) and each message it's sent
//   FAKE_CODEX_TEXT                the reply (default "Done."); the answers it waited for are added on lines after it
//   FAKE_CODEX_MODEL               the model it says a thread runs on (default "gpt-fake")
//   FAKE_CODEX_MODELS              a JSON file with `model/list`'s `data` (default: two models, one of them cheap)
//   FAKE_CODEX_SLEEP               seconds to wait before a turn's reply (to catch a run while it runs)
//   FAKE_CODEX_NO_DYNAMIC_TOOLS    "1": a `thread/start` with dynamic tools is refused, as an older Codex refuses it
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

type Json = Record<string, unknown>

const env = process.env
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const field = (v: unknown, name: string): unknown => (isObject(v) ? v[name] : undefined)
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const parse = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
const hex = () => randomUUID().replaceAll("-", "").slice(0, 12)
const send = (v: Json) => process.stdout.write(`${JSON.stringify(v)}\n`)
const log = (v: unknown) => {
  if (env.FAKE_CODEX_LOG) appendFileSync(env.FAKE_CODEX_LOG, `${JSON.stringify(v)}\n`)
}

log({ start: { args: process.argv.slice(2), cwd: process.cwd(), codex_home: env.CODEX_HOME ?? null } })

const MODEL = env.FAKE_CODEX_MODEL ?? "gpt-fake"
const models = (): unknown => {
  if (env.FAKE_CODEX_MODELS) return JSON.parse(readFileSync(env.FAKE_CODEX_MODELS, "utf8"))
  const efforts = ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }))
  return [
    {
      id: "gpt-fake",
      model: "gpt-fake",
      displayName: "GPT Fake",
      description: "Most capable model for hard work.",
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-fake-mini",
      model: "gpt-fake-mini",
      displayName: "GPT Fake Mini",
      description: "Fast and affordable model for easier tasks.",
      isDefault: false,
      hidden: false,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: "low",
    },
  ]
}

let thread = ""
let nextRequest = 1000
/** The app-server's requests waiting for the adapter's answer, by id. */
const waiting = new Map<number, (answer: Json) => void>()
/** The turn going: its id, what was steered into it, and how its interruption is heard. */
let turn: { id: string; steered: Array<string>; interrupted: boolean; wake: Array<() => void> } | null = null
let turns = 0

/** Waits `seconds`, or until the turn is interrupted. */
const pause = (seconds: number) =>
  new Promise<void>((done) => {
    const t = turn
    const timer = setTimeout(done, seconds * 1000)
    t?.wake.push(() => {
      clearTimeout(timer)
      done()
    })
  })

/** Asks the adapter `method` and waits for its answer, or for the turn's interruption (null). */
const ask = (method: string, params: Json): Promise<Json | null> =>
  new Promise((done) => {
    const id = nextRequest++
    waiting.set(id, done)
    turn?.wake.push(() => {
      if (waiting.delete(id)) {
        send({ method: "serverRequest/resolved", params: { threadId: thread, requestId: id } })
        done(null)
      }
    })
    send({ id, method, params })
  })

const item = (method: "item/started" | "item/completed", it: Json) => send({ method, params: { threadId: thread, turnId: turn?.id, item: it } })

const runTurn = async (id: string, text: string) => {
  const t = { id, steered: [] as Array<string>, interrupted: false, wake: [] as Array<() => void> }
  turn = t
  const p = { threadId: thread }
  send({ method: "turn/started", params: { ...p, turn: { id, status: "inProgress", items: [] } } })
  const said: Array<string> = []
  if (text.includes("fake-ask-permission")) {
    const cmd = { type: "commandExecution", id: `cmd-${hex()}`, command: "/bin/bash -lc 'echo fake'", cwd: process.cwd(), status: "inProgress" }
    item("item/started", cmd)
    const a = await ask("item/commandExecution/requestApproval", { ...p, turnId: id, itemId: cmd.id, command: cmd.command, cwd: cmd.cwd })
    const decision = str(field(field(a, "result"), "decision")) || "cancel"
    said.push(`permission Bash: ${decision}`)
    const ok = decision === "accept" || decision === "acceptForSession"
    if (!t.interrupted) item("item/completed", { ...cmd, status: ok ? "completed" : "declined", aggregatedOutput: ok ? "fake\n" : "", exitCode: ok ? 0 : null })
  }
  if (text.includes("fake-question") && !t.interrupted) {
    const questions = [{ id: "q1", header: "Pick", question: "Which one?", isOther: false, isSecret: false, options: [{ label: "A" }, { label: "B" }] }]
    const a = await ask("item/tool/requestUserInput", { ...p, turnId: id, itemId: `q-${hex()}`, questions })
    said.push(`question: ${JSON.stringify(field(field(a, "result"), "answers") ?? null)}`)
  }
  for (const line of text.split("\n")) {
    const m = /fake-board-call (\S+)(?: (.*))?$/u.exec(line.trim())
    if (m === null || t.interrupted) continue
    const tool = m[1] ?? ""
    const args = parse(m[2] ?? "{}") ?? {}
    const call = { type: "dynamicToolCall", id: `call-${hex()}`, namespace: "huntaway", tool, arguments: args, status: "inProgress" }
    item("item/started", call)
    const a = await ask("item/tool/call", { ...p, turnId: id, callId: call.id, namespace: "huntaway", tool, arguments: args })
    const result = field(a, "result")
    const content = field(result, "contentItems")
    const out = Array.isArray(content) ? content.map((c) => str(field(c, "text"))).join("\n") : ""
    said.push(`board ${tool}: ${out}`)
    if (!t.interrupted) item("item/completed", { ...call, status: "completed", contentItems: content ?? [], success: field(result, "success") !== false })
  }
  if ((text.includes("fake-commit") || text.includes("Fix them, then commit")) && !t.interrupted) {
    const made = spawnSync(
      "git",
      ["-c", "user.name=fake", "-c", "user.email=fake@example.com", "commit", "-q", "--allow-empty", "--no-verify", "-m", "fake work"],
      { encoding: "utf8" },
    )
    said.push(made.status === 0 ? "committed fake work" : `couldn't commit: ${(made.stderr ?? "").trim().slice(0, 200)}`)
  }
  const merging = /Merge branch `([^`]+)` into/u.exec(text)
  if (
    env.FAKE_CODEX_MERGE === "pr" &&
    merging !== null &&
    text.includes('The user moved this task to "Ready for merge".') &&
    !text.includes("Do not merge yet")
  ) {
    const gh = env.FAKE_CODEX_GH
    const merged = gh === undefined || gh === "" ? null : spawnSync(gh, ["pr", "merge", merging[1] ?? "", "--squash"], { encoding: "utf8" })
    said.push(merged === null ? "couldn't merge: no fake gh" : merged.status === 0 ? `merged ${merging[1]}` : `couldn't merge: ${merged.stderr}`)
    const task = env.HUNTAWAY_TASK_ID
    if (merged?.status === 0 && task !== undefined && !t.interrupted) {
      const args = { task_id: task, status: "done" }
      const call = { type: "dynamicToolCall", id: `call-${hex()}`, namespace: "huntaway", tool: "update_task", arguments: args, status: "inProgress" }
      item("item/started", call)
      const a = await ask("item/tool/call", { ...p, turnId: id, callId: call.id, namespace: "huntaway", tool: "update_task", arguments: args })
      if (!t.interrupted) item("item/completed", { ...call, status: "completed", contentItems: field(field(a, "result"), "contentItems") ?? [], success: true })
    }
  }
  if (text.includes("fake-until-interrupted")) while (!t.interrupted) await pause(3600)
  const sleep = Number(env.FAKE_CODEX_SLEEP ?? "0")
  if (sleep > 0 && !t.interrupted) await pause(sleep)
  if (!t.interrupted && !text.includes("fake-usage-limit")) {
    const reply = [env.FAKE_CODEX_TEXT ?? "Done.", ...t.steered.map((s) => `steered: ${s}`), ...said].join("\n")
    const msg = { type: "agentMessage", id: `msg-${hex()}`, text: "" }
    item("item/started", msg)
    for (const delta of reply.match(/.{1,8}/gsu) ?? []) send({ method: "item/agentMessage/delta", params: { ...p, turnId: id, itemId: msg.id, delta } })
    item("item/completed", { ...msg, text: reply })
  }
  const total = { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 }
  send({ method: "thread/tokenUsage/updated", params: { ...p, turnId: id, tokenUsage: { total, last: total, modelContextWindow: 200000 } } })
  const status = t.interrupted ? "interrupted" : text.includes("fake-usage-limit") ? "failed" : "completed"
  const error = status === "failed" ? { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } : null
  turn = null
  send({ method: "turn/completed", params: { ...p, turn: { id, status, items: [], error } } })
}

const compact = () => {
  const id = `turn-${++turns}`
  const p = { threadId: thread }
  send({ method: "turn/started", params: { ...p, turn: { id, status: "inProgress", items: [] } } })
  const it = { type: "contextCompaction", id: `compact-${hex()}` }
  send({ method: "item/started", params: { ...p, turnId: id, item: it } })
  send({ method: "item/completed", params: { ...p, turnId: id, item: it } })
  send({ method: "turn/completed", params: { ...p, turn: { id, status: "completed", items: [], error: null } } })
  send({ method: "thread/compacted", params: { ...p, turnId: id } })
}

const textOf = (params: unknown): string => {
  const input = field(params, "input")
  return Array.isArray(input) ? input.map((b) => str(field(b, "text"))).join("") : ""
}

const handle = (m: Json) => {
  const id = m.id
  const method = str(m.method)
  const params = m.params
  const result = (r: unknown) => send({ id, result: r })
  const error = (message: string, code = -32600) => send({ id, error: { code, message } })
  if (method === "" && typeof id === "number") {
    const done = waiting.get(id)
    waiting.delete(id)
    done?.(m)
    return
  }
  if (id === undefined) return // A notification (`initialized`).
  switch (method) {
    case "initialize":
      return result({ userAgent: "fake-codex/0.0.0" })
    case "skills/extraRoots/set":
    case "thread/revert":
      return result({})
    case "thread/start": {
      if (field(params, "dynamicTools") !== undefined && env.FAKE_CODEX_NO_DYNAMIC_TOOLS === "1") {
        return error("thread/start.dynamicTools requires experimentalApi capability")
      }
      thread = `thread-${hex()}`
      const model = str(field(params, "model")) || MODEL
      result({ thread: { id: thread }, model })
      return send({ method: "thread/started", params: { thread: { id: thread, preview: "" } } })
    }
    case "thread/resume":
      thread = str(field(params, "threadId"))
      return result({ thread: { id: thread }, model: str(field(params, "model")) || MODEL })
    case "turn/start": {
      const turnId = `turn-${++turns}`
      result({ turn: { id: turnId, status: "inProgress", items: [] } })
      void runTurn(turnId, textOf(params))
      return
    }
    case "turn/steer":
      if (turn === null || field(params, "expectedTurnId") !== turn.id) return error("no active turn to steer")
      turn.steered.push(textOf(params))
      return result({ turnId: turn.id })
    case "turn/interrupt":
      result({})
      if (turn !== null) {
        turn.interrupted = true
        for (const wake of turn.wake.splice(0)) wake()
      }
      return
    case "thread/compact/start":
      result({})
      return compact()
    case "model/list":
      return result({ data: models(), nextCursor: null })
    case "skills/list":
      return result({
        data: [{ cwd: process.cwd(), skills: [{ name: "fake-skill", description: "A skill.", shortDescription: "Fake", enabled: true }], errors: [] }],
      })
    case "account/rateLimits/read":
      return result({
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_800_400_000 },
          planType: "plus",
        },
      })
    case "config/read":
      return result({ config: { mcp_servers: {} }, origins: {} })
    default:
      return error(`unknown method ${method}`, -32601)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", (line) => {
  const m = parse(line)
  if (!isObject(m)) return
  log(m)
  handle(m)
})
// Its stdin ended: it exits, once what it wrote is out.
rl.on("close", () => process.stdout.write("", () => process.exit(0)))
