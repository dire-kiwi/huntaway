// A stand-in `claude` for test servers (`scripts/test-server.sh --fake-claude`) and whole-server tests: the runner,
// queue and merge logic without a model. The old scripts/fake-claude (Python), ported with its prompt markers and
// knobs (HUNTAWAY_FAKE_CLAUDE_* in place of IA_FAKE_CLAUDE_*). Plain Node: it stands in for an outside program.
//
// An agent run (`-p --output-format stream-json`) reads its first prompt, prints a system init, one assistant message
// and a `result`. With stream-json input it then waits, as Claude Code does, for more: each further user message is
// echoed (`isReplay`) and answered by a turn of its own, and it exits once its input ends (the server closes it). With
// text input it exits after the result. Title generation (`--output-format json`) prints a `result` with the title and
// the tokens it took (`--output-format text`, a bare title). Each call appends a JSON line (args, cwd, config dir,
// TMPDIR, prompt) to $HUNTAWAY_FAKE_CLAUDE_LOG, if set (test-server.sh sets it to <data dir>/fake-claude.log).
//
// Set these in the server's environment (before test-server.sh, which keeps them for `restart`):
//   HUNTAWAY_FAKE_CLAUDE_SLEEP   seconds to wait before replying (to catch a run while it's running)
//   HUNTAWAY_FAKE_CLAUDE_TEXT    the assistant's reply (default "Fake reply to: <prompt>")
//   HUNTAWAY_FAKE_CLAUDE_RESULT  the result's subtype (default success; anything else is an error)
//   HUNTAWAY_FAKE_CLAUDE_EXIT    exit status (default 0)
//   HUNTAWAY_FAKE_CLAUDE_TITLE   the title that title generation prints (default "Fake title")
//   HUNTAWAY_FAKE_CLAUDE_LIMIT   seconds until the usage limit resets (default 7200) for a prompt containing
//                                "out-of-usage", which is refused for the usage limit as Claude Code does
//   HUNTAWAY_FAKE_CLAUDE_USAGE   "out" refuses every run that way; "extra" (or a prompt containing
//                                "on-extra-usage") reports the limit as used up but carries on, on extra usage
//   HUNTAWAY_FAKE_CLAUDE_WINDOW  seconds a 5-hour window lasts: each stream-json run reports its window, which
//                                starts with the first run after the last one ended (kept in a file beside the log);
//                                that first run reports the window that ended, as Claude Code does
//   HUNTAWAY_FAKE_CLAUDE_COST    what each stream-json run costs (default 0): its result reports its session's total,
//                                which goes on over the runs that resume the session (kept in a file beside the log),
//                                as Claude Code's `total_cost_usd` does
//   HUNTAWAY_FAKE_CLAUDE_LOGIN   "out" answers every run as Claude Code does in a config folder with no login
//   HUNTAWAY_FAKE_CLAUDE_SESSIONS  "1" keeps the sessions each config folder (CLAUDE_CONFIG_DIR) has, in a file
//                                beside the log, and fails a --resume of one the folder hasn't, as Claude Code does
//   HUNTAWAY_FAKE_CLAUDE_STREAM_SLEEP  seconds between streamed deltas (default 0.02)
//
// Messages steered into a run (stream-json lines on stdin after the prompt, while it sleeps) are echoed back as Claude
// Code does (`isReplay`), and answered in its reply. A run started with `--permission-prompt-tool stdio` asks for
// permission as Claude Code does, with a `can_use_tool` control request on stdout, for each of these in its prompt:
// "fake-ask-permission" (a Bash call), "fake-ask-question" (AskUserQuestion) and "fake-ask-plan" (ExitPlanMode). It
// waits for each `control_response` on stdin (taking in messages sent meanwhile), and its reply says what each answer
// was ("permission Bash: allow", with a question's answers or a plan's new mode, or "deny: <message>"). An `interrupt`
// meanwhile cancels the request (`control_cancel_request`) and ends the turn as interrupted. A run whose input starts
// with an `initialize` control request that registers the in-process "huntaway" server (`sdkMcpServers`) calls the
// board's tools through it for each "fake-board-call <tool> <JSON arguments>" line in its prompt (an `mcp_message`
// `tools/call` control request), waiting for each answer as for a permission, and its reply says what each returned
// ("board wait: {...}"). A `/compact` prompt prints a compact_boundary. A prompt containing "fake-subagent" runs a
// subagent (a Task call, with a Read inside it), and streams its reply's text (stream_event deltas) before the
// assistant message. A prompt containing "fake-until-interrupted" keeps its turn going until an `interrupt` (which the
// sleep before a reply doesn't heed), then ends it as Claude Code does: "[Request interrupted by user]" and an
// error_during_execution result.
//
// Reviews (plan task 4.6). A reviewer's run (its prompt starts "Review the work on task", and it quotes the task's
// description) calls `submit_review` through the in-process server before it replies: `pass`, unless the description
// says "fake-review-fixes" (`needs_fixes` every round, with one serious issue, "fake issue: …") or
// "fake-review-fixes-once" (`needs_fixes` on a first round; `pass` on a round that checks the issues found before, whose
// prompt says "The previous review found these serious issues"). A run that is asked to fix a review's issues ("Fix them,
// then commit") or whose prompt contains "fake-commit" (a task's first run quotes its description) makes an empty commit
// ("fake work") in its working directory, so the branch has new work for the next round to review. A summarizer's run
// replies as any other (its reply is the summary).
//
// Merges (plan task 4.7). With HUNTAWAY_FAKE_CLAUDE_MERGE set, a run asked to merge (its prompt is the merge request,
// 'The user moved this task to "Ready for merge". … Merge branch `<branch>` into `<base>`', and not the summary an
// approval asks for first, which says "Do not merge yet") merges and then calls `update_task` with `status: "done"` for
// its own task ($HUNTAWAY_TASK_ID) through the in-process server:
//   branch  its base branch is moved to the run's HEAD (`git push . HEAD:<base>`, or to the base's remote when it has
//           one): a fast-forward, which fails (and the task isn't moved) when the base has moved on
//   pr      `gh pr merge <branch> --squash`, with $HUNTAWAY_GH_BIN (the fake gh of `test-server.sh --fake-gh`) or gh
//   refuse  it doesn't merge, and replies so (the board then says it finished without merging)
// Without it, a merge request is answered like any other prompt.
import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

type Json = Record<string, unknown>

const args = process.argv.slice(2)
const env = process.env

const opt = (name: string): string | null => {
  const at = args.indexOf(name)
  return at >= 0 && at + 1 < args.length ? (args[at + 1] ?? null) : null
}

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
const hex = (n: number) => randomUUID().replaceAll("-", "").slice(0, n)
const sleep = (seconds: number) => new Promise<void>((done) => setTimeout(done, seconds * 1000))
const emit = (v: Json) => process.stdout.write(`${JSON.stringify(v)}\n`)
/** Exit once stdout has drained; never resolves. */
const exit = (code: number) =>
  new Promise<never>(() => {
    process.stdout.write("", () => process.exit(code))
  })

/** stdin as lines, read as they arrive. */
class Input {
  private text = ""
  private readonly lines: Array<string> = []
  private ended = false
  private wake: (() => void) | null = null

  constructor() {
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk: string) => {
      this.text += chunk
      let at = this.text.indexOf("\n")
      while (at >= 0) {
        this.lines.push(this.text.slice(0, at + 1))
        this.text = this.text.slice(at + 1)
        at = this.text.indexOf("\n")
      }
      this.notify()
    })
    process.stdin.on("end", () => {
      if (this.text !== "") this.lines.push(this.text)
      this.text = ""
      this.ended = true
      this.notify()
    })
  }

  private notify() {
    const wake = this.wake
    this.wake = null
    wake?.()
  }

  private waitForData(seconds: number | null) {
    return new Promise<void>((done) => {
      const timer = seconds === null ? null : setTimeout(done, seconds * 1000)
      this.wake = () => {
        if (timer !== null) clearTimeout(timer)
        done()
      }
    })
  }

  /** Whether anything is waiting within `seconds` (Python's select). */
  async ready(seconds: number): Promise<boolean> {
    if (this.lines.length > 0 || this.ended || this.text !== "") return true
    await this.waitForData(seconds)
    return this.lines.length > 0 || this.ended || this.text !== ""
  }

  /** The next line (with its newline), "" at the end of input. */
  async line(): Promise<string> {
    while (this.lines.length === 0 && !this.ended) await this.waitForData(null)
    return this.lines.shift() ?? ""
  }

  /** The lines already here, without waiting for more. */
  async waiting(): Promise<Array<string>> {
    await new Promise<void>((done) => setImmediate(done))
    return this.lines.splice(0)
  }

  /** Everything up to the end of input. */
  async all(): Promise<string> {
    while (!this.ended) await this.waitForData(null)
    return this.lines.splice(0).join("")
  }
}

const stdin = new Input()
const streamInput = opt("--input-format") === "stream-json"
// The in-process ("SDK") MCP servers the run's `initialize` control request registered.
const sdkServers: Array<string> = []

/** A user message's text. */
const textOf = (message: unknown): string => {
  const content = field(field(message, "message"), "content")
  if (Array.isArray(content))
    return content
      .filter(isObject)
      .map((b) => str(b.text))
      .join("\n")
  return typeof content === "string" ? content : String(content)
}

const readPrompt = async (): Promise<string> => {
  // stream-json input is one JSON line per message; text input is all of stdin.
  if (!(await stdin.ready(10))) return ""
  if (!streamInput) return stdin.all()
  let line = await stdin.line()
  let m = parse(line)
  // An `initialize` ahead of the prompt, answered as Claude Code does.
  while (field(m, "type") === "control_request") {
    const req = field(m, "request")
    if (field(req, "subtype") === "initialize") {
      const servers = field(req, "sdkMcpServers")
      if (Array.isArray(servers)) sdkServers.push(...servers.map(String))
      emit({ type: "control_response", response: { subtype: "success", request_id: field(m, "request_id"), response: { commands: [] } } })
    } else {
      emit({ type: "control_response", response: { subtype: "error", request_id: field(m, "request_id"), error: "unsupported" } })
    }
    line = await stdin.line()
    m = parse(line)
  }
  const content = field(field(m, "message"), "content")
  if (content === undefined) return line.trim()
  return textOf(m)
}

if (args.includes("--version")) {
  process.stdout.write("0.0.0 (fake-claude)\n")
  await exit(0)
}

const prompt = await readPrompt()
const log = env.HUNTAWAY_FAKE_CLAUDE_LOG
// Files kept beside the log (or in the current folder without one).
const beside = (name: string) => join(dirname(log ?? resolve(".")), name)
const readJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}
if (log !== undefined && log !== "") {
  const entry = { time: Date.now() / 1000, args, cwd: process.cwd(), config_dir: env.CLAUDE_CONFIG_DIR ?? null, tmpdir: env.TMPDIR ?? null, prompt }
  appendFileSync(log, `${JSON.stringify(entry)}\n`)
}

const format = opt("--output-format")
if (format === "text" || format === "json") {
  const title = env.HUNTAWAY_FAKE_CLAUDE_TITLE ?? "Fake title"
  if (format === "text") process.stdout.write(`${title}\n`)
  else {
    // Title generation's result, with the tokens it took, as Claude Code reports them.
    const usage = { "claude-haiku-fake": { inputTokens: 2, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 600, costUSD: 0.0002 } }
    emit({ type: "result", subtype: "success", is_error: false, result: title, session_id: randomUUID(), total_cost_usd: 0.0002, modelUsage: usage })
  }
  await exit(0)
}

const session = opt("--resume") ?? randomUUID()
const model = opt("--model") ?? "fake"
if (env.HUNTAWAY_FAKE_CLAUDE_SESSIONS === "1") {
  // Each config folder's sessions, as Claude Code keeps them in its projects folder.
  const knownFile = beside("fake-claude-sessions")
  const read = readJsonFile(knownFile)
  const known: Record<string, Array<string>> = isObject(read)
    ? Object.fromEntries(Object.entries(read).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]))
    : {}
  const folder = env.CLAUDE_CONFIG_DIR ?? "~/.claude"
  if (opt("--resume") !== null && !(known[folder] ?? []).includes(session)) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 0,
      session_id: session,
      total_cost_usd: 0,
      errors: [`No conversation found with session ID: ${session}`],
    })
    process.stderr.write(`No conversation found with session ID: ${session}\n`)
    await exit(1)
  }
  const list = known[folder] ?? []
  if (!list.includes(session)) list.push(session)
  known[folder] = list
  writeFileSync(knownFile, JSON.stringify(known))
}

emit({ type: "system", subtype: "init", session_id: session, model, cwd: process.cwd(), tools: [] })
await sleep(Number(env.HUNTAWAY_FAKE_CLAUDE_SLEEP ?? "0"))

let steered: Array<string> = []
let answers: Array<string> = []

/** A user message taken in: echoed back as Claude Code does, and answered in the reply. */
const takeIn = (m: Json) => {
  emit({ ...m, isReplay: true, session_id: session })
  const content = field(field(m, "message"), "content")
  steered.push(
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(isObject)
            .map((b) => str(b.text))
            .join(" ")
        : "",
  )
}

// The control requests that came while it slept, which only a turn that waits to be interrupted reads.
const slept: Array<Json> = []
if (streamInput) {
  // What was steered into the turn while it slept, echoed back as Claude Code does when it takes it in.
  for (const line of await stdin.waiting()) {
    const m = parse(line)
    if (isObject(m) && m.type === "user") takeIn(m)
    else if (isObject(m) && m.type === "control_request") slept.push(m)
  }
}

/** The control response to our request `ask`, taking in messages sent meanwhile; an interrupt cancels it and ends the turn. */
const awaitResponse = async (ask: string): Promise<Json> => {
  for (;;) {
    const line = await stdin.line()
    if (line === "") return exit(1)
    const m = parse(line)
    if (!isObject(m)) continue
    if (m.type === "control_response" && field(m.response, "request_id") === ask && isObject(m.response)) return m.response
    if (m.type === "control_request" && field(m.request, "subtype") === "interrupt") {
      emit({ type: "control_cancel_request", request_id: ask })
      emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } })
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "interrupted",
        session_id: session,
        duration_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
      })
      while ((await stdin.line()) !== "") {
        // Read to the end of the input.
      }
      return exit(0)
    }
    if (m.type === "user") takeIn(m)
  }
}

const say = (content: Array<Json>, parent: string | null = null) =>
  emit({
    type: "assistant",
    session_id: session,
    uuid: randomUUID(),
    parent_tool_use_id: parent,
    message: { id: `msg_${hex(32)}`, role: "assistant", model, content },
  })

const toolResult = (id: string, content: string, parent: string | null = null, isError: boolean | null = null) =>
  emit({
    type: "user",
    session_id: session,
    uuid: randomUUID(),
    parent_tool_use_id: parent,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError === null ? {} : { is_error: isError }) }] },
  })

const askPermissions = async (text: string) => {
  const markers =
    opt("--permission-prompt-tool") === "stdio" ? ["fake-ask-permission", "fake-ask-question", "fake-ask-plan"].filter((m) => text.includes(m)) : []
  for (const marker of markers) {
    // Asked as Claude Code asks with --permission-prompt-tool stdio: the call, then a control request for it.
    let name = "Bash"
    let toolInput: Json = { command: "echo fake", description: "Say fake" }
    if (marker === "fake-ask-question") {
      name = "AskUserQuestion"
      toolInput = { questions: [{ question: "Which one?", header: "Pick", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] }
    } else if (marker === "fake-ask-plan") {
      name = "ExitPlanMode"
      toolInput = { plan: "# Plan: fake things\n\n1. Do a fake thing" }
    }
    const tool = `toolu_${hex(12)}`
    const ask = randomUUID()
    say([{ type: "tool_use", id: tool, name, input: toolInput }])
    emit({
      type: "control_request",
      request_id: ask,
      request: { subtype: "can_use_tool", tool_name: name, input: toolInput, tool_use_id: tool, permission_suggestions: [] },
    })
    const r = await awaitResponse(ask)
    const answer = isObject(r.response) ? r.response : { behavior: "deny", message: r.error ?? "error" }
    const allowed = answer.behavior === "allow"
    let said = `permission ${name}: ${allowed ? "allow" : `deny: ${String(answer.message)}`}`
    if (allowed && name === "AskUserQuestion") said += ` ${JSON.stringify(field(answer.updatedInput, "answers") ?? null)}`
    if (allowed && answer.updatedPermissions !== undefined && answer.updatedPermissions !== null) said += ` ${JSON.stringify(answer.updatedPermissions)}`
    answers.push(said)
    toolResult(tool, allowed ? "fake" : String(answer.message), null, !allowed)
  }
}

let rpc = 0
const callBoard = async (text: string) => {
  // Board tool calls, through the in-process server the run registered: "fake-board-call <tool> <JSON arguments>" lines.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith("fake-board-call ")) continue
    // "fake-board-call <tool> <JSON arguments>": the tool's name, then the rest of the line.
    const after = line.slice("fake-board-call ".length).trim()
    const space = after.search(/\s/)
    const name = space < 0 ? after : after.slice(0, space)
    const rest = space < 0 ? "" : after.slice(space).trim()
    await callTool(name, rest === "" ? {} : parse(rest))
  }
}

/** A reviewer's verdict (see "Reviews" above): `submit_review` before it replies. */
const review = async (text: string) => {
  if (!text.startsWith("Review the work on task")) return
  const recheck = text.includes("The previous review found these serious issues")
  const fixes = text.includes("fake-review-fixes-once") ? !recheck : text.includes("fake-review-fixes")
  await callTool(
    "submit_review",
    fixes
      ? {
          verdict: "needs_fixes",
          summary: "Fake review: one thing to fix.",
          serious_issues: ["fake issue: the fake reviewer wants a fix (fake-review-fixes)"],
          minor_issues: [],
        }
      : { verdict: "pass", summary: recheck ? "Fake review: the issues are fixed." : "Fake review: looks good.", serious_issues: [], minor_issues: [] },
  )
}

/** An empty commit in the working directory, for a task's run asked to make one or to fix a review's issues. */
const commit = (text: string) => {
  if (text.startsWith("Review the work on task") || text.startsWith("Summarise the changes made")) return
  if (!text.includes("fake-commit") && !text.includes("Fix them, then commit")) return
  const made = spawnSync(
    "git",
    ["-c", "user.name=fake", "-c", "user.email=fake@example.com", "commit", "-q", "--allow-empty", "--no-verify", "-m", "fake work"],
    {
      encoding: "utf8",
    },
  )
  answers.push(made.status === 0 ? "committed fake work" : `couldn't commit: ${(made.stderr ?? "").trim().slice(0, 200)}`)
}

/** git in the run's folder; what it printed, or why it failed. */
const gitIn = (gitArgs: ReadonlyArray<string>): { readonly ok: boolean; readonly out: string } => {
  const r = spawnSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@example.com", ...gitArgs], { encoding: "utf8" })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 300) }
}

/**
 * The merge (see "Merges" above): asked to merge (the merge request, not the summary for an approval), the branch is
 * merged into its base as `HUNTAWAY_FAKE_CLAUDE_MERGE` says, then `update_task` says it's done.
 */
const merge = async (text: string) => {
  const how = env.HUNTAWAY_FAKE_CLAUDE_MERGE ?? ""
  if (how === "" || !text.startsWith('The user moved this task to "Ready for merge".') || text.includes("Do not merge yet")) return
  const asked = /Merge branch `([^`]+)` into `([^`]+)`/.exec(text)
  const branch = asked?.[1]
  const base = asked?.[2]
  if (how === "refuse" || branch === undefined || base === undefined) {
    answers.push("not merged (fake)")
    return
  }
  let merged: { readonly ok: boolean; readonly out: string }
  if (how === "pr") {
    // The fake GitHub's pull request of the branch, with the gh the board's tools would run (`HUNTAWAY_GH_BIN`).
    const gh = spawnSync(env.HUNTAWAY_GH_BIN ?? "gh", ["pr", "merge", branch, "--squash"], { encoding: "utf8" })
    merged = { ok: gh.status === 0, out: `${gh.stdout ?? ""}${gh.stderr ?? ""}`.trim().slice(0, 300) }
  } else {
    // Its base moved on to the branch (a fast-forward), in the repository and, with a remote, there too.
    const remote = gitIn(["config", `branch.${base}.remote`]).out
    merged = gitIn(["push", "--quiet", "--no-verify", remote === "" ? "." : remote, `HEAD:refs/heads/${base}`])
  }
  answers.push(merged.ok ? `merged ${branch} into ${base}` : `couldn't merge: ${merged.out}`)
  const task = env.HUNTAWAY_TASK_ID
  if (merged.ok && task !== undefined) await callTool("update_task", { task_id: task, status: "done" })
}

/** Calls a tool of the in-process board server, waiting for its answer; what it returned goes in the reply. */
const callTool = async (name: string, toolArgs: unknown) => {
  if (!sdkServers.includes("huntaway")) {
    answers.push(`board ${name}: no in-process board server`)
    return
  }
  const tool = `toolu_${hex(12)}`
  const ask = randomUUID()
  rpc += 1
  say([{ type: "tool_use", id: tool, name: `mcp__huntaway__${name}`, input: toolArgs }])
  emit({
    type: "control_request",
    request_id: ask,
    request: {
      subtype: "mcp_message",
      server_name: "huntaway",
      message: {
        jsonrpc: "2.0",
        id: rpc,
        method: "tools/call",
        params: { name, arguments: toolArgs, _meta: { "claudecode/toolUseId": tool, progressToken: rpc } },
      },
    },
  })
  const r = field(field(await awaitResponse(ask), "response"), "mcp_response")
  const res = field(r, "result")
  const content = field(res, "content")
  const said =
    field(r, "id") === rpc
      ? (Array.isArray(content) ? content : [])
          .filter(isObject)
          .map((c) => str(c.text))
          .join(" ")
      : `wrong JSON-RPC id ${JSON.stringify(field(r, "id") ?? null)}`
  answers.push(`board ${name}: ${said.split(/\s+/).filter(Boolean).join(" ").slice(0, 300)}`)
  toolResult(tool, said, null, field(res, "isError") === true)
}

const subagent = () => {
  // A subagent (the Task tool), which reads a file, then ends; its call's result is what it found.
  const call = `toolu_${hex(12)}`
  const read = `toolu_${hex(12)}`
  say([{ type: "tool_use", id: call, name: "Task", input: { description: "Look around", prompt: "Read the README", subagent_type: "general-purpose" } }])
  emit({ type: "system", subtype: "task_started", task_id: `job_${call}`, tool_use_id: call, description: "Look around", session_id: session })
  say([{ type: "tool_use", id: read, name: "Read", input: { file_path: "README.md" } }], call)
  toolResult(read, "# Readme", call)
  emit({ type: "system", subtype: "task_notification", task_id: `job_${call}`, tool_use_id: call, status: "completed", session_id: session })
  toolResult(call, "It has a README.")
}

const now = () => Date.now() / 1000

/** "6:30pm", as Claude Code says when a limit resets. */
const clock = (seconds: number) => {
  const d = new Date(seconds * 1000)
  const hours = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12
  return `${hours}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "am" : "pm"}`
}

/** One turn on `text`: what it asks, what it calls, and its reply and result. Exits where Claude Code would. */
const turn = async (text: string) => {
  await askPermissions(text)
  await callBoard(text)
  await review(text)
  commit(text)
  await merge(text)
  if (text.trim() === "/compact") {
    emit({ type: "system", subtype: "compact_boundary", session_id: session, compact_metadata: { trigger: "manual", pre_tokens: 1234 } })
  }
  if (text.includes("fake-subagent")) subagent()
  if (text.includes("fake-until-interrupted")) {
    // A turn that goes on until it's interrupted (by one that came during the sleep too), as a long one of Claude
    // Code's does: messages steered meanwhile are taken in, and the interrupt ends the turn with Claude Code's note and
    // an error result. With stream-json input it then waits for more.
    for (;;) {
      const line = slept.length > 0 ? null : await stdin.line()
      if (line === "") await exit(0)
      const m = line === null ? slept.shift() : parse(line)
      if (!isObject(m)) continue
      if (m.type === "user") takeIn(m)
      if (m.type !== "control_request") continue
      const interrupt = field(m.request, "subtype") === "interrupt"
      emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: interrupt ? { still_queued: [] } : {} } })
      if (!interrupt) continue
      emit({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
        parent_tool_use_id: null,
        session_id: session,
        uuid: randomUUID(),
      })
      emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, duration_ms: 1, num_turns: 1, total_cost_usd: 0 })
      return
    }
  }
  const usage = env.HUNTAWAY_FAKE_CLAUDE_USAGE || (text.includes("on-extra-usage") ? "extra" : text.includes("out-of-usage") ? "out" : "")
  const window = env.HUNTAWAY_FAKE_CLAUDE_WINDOW
  if (window !== undefined && window !== "" && usage === "") {
    // The plan's 5-hour window, as Claude Code reports it on each turn.
    const state = beside("fake-claude-window")
    let resets = 0
    try {
      resets = Number.parseInt(readFileSync(state, "utf8"), 10) || 0
    } catch {
      resets = 0
    }
    const windows: Json = { seven_day: { utilization: 0.3, resetsAt: Math.trunc(now() + 86400), status: "allowed" } }
    let old: number | null = null
    if (resets <= now()) {
      // As Claude Code does, the first run after a window ends reports the one that ended, and leaves it out of
      // unifiedWindows; the next run reports the new one.
      old = resets
      resets = Math.trunc(now() + Number(window))
      writeFileSync(state, String(resets))
    } else {
      windows.five_hour = { utilization: 0.01, resetsAt: resets, status: "allowed" }
    }
    const info = {
      status: "allowed",
      resetsAt: old || resets,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      isUsingOverage: false,
      unifiedWindows: windows,
    }
    emit({ type: "rate_limit_event", rate_limit_info: info, session_id: session })
  }
  const limit = Number(env.HUNTAWAY_FAKE_CLAUDE_LIMIT ?? "7200")
  if (usage === "extra") {
    // What a plan with extra usage reports on each turn past its limit, which goes on.
    const resets = Math.trunc(now() + limit)
    const info = {
      status: "rejected",
      resetsAt: resets,
      rateLimitType: "five_hour",
      overageStatus: "allowed",
      isUsingOverage: true,
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: resets, status: "rejected" } },
    }
    emit({ type: "rate_limit_event", rate_limit_info: info, session_id: session })
  }
  if (env.HUNTAWAY_FAKE_CLAUDE_LOGIN === "out") {
    // What Claude Code prints in a config folder with no login: the session is started, and never reaches the API.
    const said = "Not logged in · Please run /login"
    emit({
      type: "assistant",
      session_id: session,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      error: "authentication_failed",
      message: { id: randomUUID(), role: "assistant", model: "<synthetic>", content: [{ type: "text", text: said }] },
    })
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: said,
      session_id: session,
      duration_ms: 50,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      terminal_reason: "api_error",
    })
    await exit(1)
  }
  if (usage === "out") {
    // What Claude Code prints when the plan's 5-hour limit refuses a turn.
    const resets = Math.trunc(now() + limit)
    const info = { status: "rejected", resetsAt: resets, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false }
    const windows = {
      five_hour: { utilization: 1, resetsAt: resets, status: "rejected" },
      seven_day: { utilization: 0.62, resetsAt: resets + 86400, status: "allowed" },
    }
    emit({ type: "rate_limit_event", rate_limit_info: { ...info, unifiedWindows: windows }, session_id: session })
    const said = `You've hit your 5-hour limit · resets ${clock(resets)}`
    emit({
      type: "assistant",
      session_id: session,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      error: "rate_limit",
      api_error_status: 429,
      api_error: "usage_limit_reached",
      api_error_params: { rate_limit_info: info },
      message: { id: randomUUID(), role: "assistant", model: "<synthetic>", content: [{ type: "text", text: said }] },
    })
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      api_error: "usage_limit_reached",
      result: said,
      session_id: session,
      duration_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
    })
    await exit(0)
  }
  let reply = env.HUNTAWAY_FAKE_CLAUDE_TEXT || `Fake reply to: ${text.trim().slice(0, 200)}`
  if (steered.length > 0) reply += ` (and to: ${steered.join("; ").slice(0, 200)})`
  if (answers.length > 0) reply += ` (${answers.join("; ")})`
  if (text.includes("fake-subagent")) {
    emit({ type: "stream_event", session_id: session, parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_s" } } })
    emit({
      type: "stream_event",
      session_id: session,
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    })
    for (let i = 0; i < reply.length; i += 8) {
      emit({
        type: "stream_event",
        session_id: session,
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(i, i + 8) } },
      })
      await sleep(Number(env.HUNTAWAY_FAKE_CLAUDE_STREAM_SLEEP ?? "0.02"))
    }
  }
  emit({
    type: "assistant",
    session_id: session,
    uuid: randomUUID(),
    parent_tool_use_id: null,
    message: { id: `msg_${hex(32)}`, role: "assistant", model, content: [{ type: "text", text: reply }], usage: { input_tokens: 1, output_tokens: 1 } },
  })
  const subtype = env.HUNTAWAY_FAKE_CLAUDE_RESULT ?? "success"
  let total = Number(env.HUNTAWAY_FAKE_CLAUDE_COST ?? "0")
  if (total !== 0 && log !== undefined && log !== "") {
    const costs = beside("fake-claude-costs.json")
    const read = readJsonFile(costs)
    const sessions: Record<string, number> = isObject(read) ? Object.fromEntries(Object.entries(read).map(([k, v]) => [k, Number(v) || 0])) : {}
    total += sessions[session] ?? 0
    sessions[session] = total
    writeFileSync(costs, JSON.stringify(sessions))
  }
  emit({
    type: "result",
    subtype,
    is_error: subtype !== "success",
    result: reply,
    session_id: session,
    duration_ms: 1,
    num_turns: 1,
    total_cost_usd: total,
    modelUsage: total !== 0 ? { [model]: { inputTokens: 1, outputTokens: 1, costUSD: total } } : {},
  })
}

await turn(prompt)
const code = Number(env.HUNTAWAY_FAKE_CLAUDE_EXIT ?? "0")
if (streamInput) {
  // As Claude Code with stream-json input: it waits for more until its input ends. Each message it takes in starts a
  // turn of its own; an interrupt between turns is answered and changes nothing.
  for (;;) {
    const line = await stdin.line()
    if (line === "") break
    const m = parse(line)
    if (!isObject(m)) continue
    if (m.type === "user") {
      steered = []
      answers = []
      emit({ ...m, isReplay: true, session_id: session })
      await turn(textOf(m))
    } else if (m.type === "control_request") {
      emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } })
    }
  }
}
await exit(code)
