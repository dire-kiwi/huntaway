import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { assert, layer } from "@effect/vitest"
import { DateTime, Effect, Fiber, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { ProfileId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { Profile, Task } from "@huntaway/contracts"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import { ContextStatsRepo } from "../agents/ContextStatsRepo.ts"
import { Prompts } from "../agents/Prompts.ts"
import { Routines } from "../automations/Routines.ts"
import { RoutineHost } from "../automations/RoutineHost.ts"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Events } from "../platform/Events.ts"
import { MEMORY_FILE, USER_FILE } from "../prompts/memory.ts"
import { Permissions, SKIPPED } from "../permissions/Permissions.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { AssistantLaunch } from "../runs/AssistantLaunch.ts"
import { LaunchFacts } from "../runs/LaunchFacts.ts"
import { TurnHooks } from "../runs/TurnHooks.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { Assistant } from "./Assistant.ts"
import { gitDir } from "./memory/workspace.ts"
import { MAX_IMPORT } from "./memory/text.ts"
import { Memory } from "./Memory.ts"
import { Tracked } from "./Tracked.ts"

/** JSON text, through a schema (the global `JSON` throws). */
const encodeJson = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown))
const json = (v: unknown): string => Result.getOrElse(encodeJson(v), () => "")

// The profile's assistant on the whole board's services (the old agent/assistant/tests.test.ts, and the cases of
// memory/tests.test.ts that need the assistant's task): made once, off the board, its workspace and memory, what its
// runs are told and where they work, its turns committed and its replies told to push, and its tracked work.
//
// Dropped, with why: the database migrations' cases (`a_database_at_version_89…`, `…version_91…`: the importer's, 9.1);
// assistant hosts (`an_assistant_host_must_be_a_linked_host…`: Profiles.test.ts; `the_hub_sends_a_profiles_assistant_to_its_host`,
// `a_message_to_the_assistant_goes_to_its_host`: over a link, tests/e2e/hosts-assistant.test.ts); `the_assistant_writes_its_workspace_without_asking`:
// `Permissions`' own folder rule (permissions/Permissions.test.ts covers the assistant's folder); `no_project_can_have_the_assistants_key`:
// projects/checks (`A` is refused with `G` and `S` there); `a_claude_run_is_given_its_memory_in_a_file`: the system prompt
// is always a file now (agents/claude/launch.ts); here, that the memory comes last in what a run is told.

const board = TestBoard()

const profile = (name: string) => Effect.flatMap(Profiles, (p) => p.create({ name })).pipe(Effect.orDie)

const git = (dir: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, {
    env: { PATH: process.env["PATH"] ?? "", GIT_DIR: gitDir(dir), GIT_WORK_TREE: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
  })
const log = (dir: string) =>
  git(dir, ["log", "--format=%an%x1f%s"])
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\x1f"))

/** The profile's assistant and its workspace. */
const opened = (p: Profile) => Effect.flatMap(Assistant, (a) => a.open(p.id)).pipe(Effect.orDie)

/** A routine thread under `assistant`, as a fresh run makes one. */
const threadUnder = (assistant: Task, workDir = assistant.work_dir) =>
  Effect.gen(function* () {
    const id = TaskId.make(`routine-${assistant.id.slice(0, 8)}-${workDir === assistant.work_dir ? "own" : "other"}`)
    const repo = yield* TaskRepo
    yield* repo.insert(
      id,
      {
        family: "assistant",
        profile_id: assistant.profile_id,
        project_id: null,
        generateTitle: false,
        columns: { title: "A routine", status: "in_progress", task_type: "routine", parent_id: assistant.id, work_dir: workDir },
      },
      assistant.created_at,
    )
    return (yield* repo.get(id)) ?? assert.fail("no thread")
  })

layer(board)("Assistant", (it) => {
  it.effect("a profile's assistant is made once, on first open, with its workspace", () =>
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const p = yield* profile("first")
      assert.isNull(yield* assistant.find(p.id))
      const a = yield* assistant.get(p.id)
      assert.deepStrictEqual([a.title, a.title_pinned, a.task_type, a.project_id, a.key, a.status], ["Assistant", true, "assistant", null, "A-1", "todo"])
      assert.strictEqual(a.work_dir, `assistants/${a.id}`)
      const dir = `${(yield* DataDir).root}/assistants/${a.id}`
      assert.isTrue(readFileSync(`${dir}/${USER_FILE}`, "utf8").startsWith("# About the user"))
      // Opened again: the same one.
      assert.strictEqual((yield* assistant.get(p.id)).id, a.id)
      // First opens at once make one between them.
      const q = yield* profile("second")
      const all = yield* Effect.forEach([1, 2, 3, 4], () => assistant.get(q.id), { concurrency: 4 })
      assert.strictEqual(new Set(all.map((t) => t.id)).size, 1)
      const sql = yield* SqlClient.SqlClient
      const [n] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE profile_id = ${q.id} AND task_type = 'assistant'`
      assert.strictEqual(n?.n, 1)
      assert.strictEqual((yield* Effect.flip(assistant.get(ProfileId.make("nope"))))._tag, "NotFound")
    }),
  )

  it.effect("the assistant is off the board unless asked for, and lasts", () =>
    Effect.gen(function* () {
      const p = yield* profile("board")
      const a = yield* (yield* Assistant).get(p.id)
      const repo = yield* TaskRepo
      assert.isFalse((yield* repo.list({ _tag: "ByProfile", profile_id: p.id })).some((t) => t.id === a.id))
      assert.isTrue((yield* repo.list({ _tag: "ByProfile", profile_id: p.id, include_assistant: true })).some((t) => t.id === a.id))
      // It never goes to review or merge, isn't done or parked, and can't be deleted.
      const tasks = yield* Tasks
      for (const status of ["in_review", "ready_for_merge", "done", "backlog"] as const) {
        const e = yield* Effect.flip(tasks.update(a.id, { status }, Actor.user))
        assert.strictEqual(e._tag, "Invalid", status)
      }
      assert.strictEqual((yield* Effect.flip(tasks.delete(a.id, { deleteBranch: false }, Actor.user)))._tag, "Conflict")
    }),
  )

  it.effect("a message to the profile's assistant goes to its thread", () =>
    Effect.gen(function* () {
      const p = yield* profile("talk")
      const a = yield* (yield* Assistant).send(p.id, "Hello there").pipe(Effect.orDie)
      const page = yield* (yield* Threads).page(a.id, Number.MAX_SAFE_INTEGER, 50).pipe(Effect.orDie)
      // The user's message as it is: no "# A-1: Assistant" wrapper.
      assert.isTrue(
        page.items.some((i) => i.type === "user_message" && i.text === "Hello there"),
        json(page.items),
      )
    }),
  )

  it.effect("a message to the assistant skips the permission prompt it is waiting on, and goes to its agent", () =>
    Effect.gen(function* () {
      const p = yield* profile("skip")
      const a = yield* (yield* Assistant).get(p.id)
      yield* (yield* TaskRepo).write(a.id, { running: true }, a.created_at)
      const agent = yield* fakeAgent({ task: a.id })
      const permissions = yield* Permissions
      const told = yield* Effect.forkChild(
        permissions.ask({ run: agent.run, call_id: "c" }, { tool_name: "Bash", input: { command: "ls" }, tool_use_id: null }),
      )
      yield* Effect.raceFirst(
        permissions.asking("c"),
        Effect.flatMap(Fiber.join(told), (d) => Effect.die(`decided without asking: ${json(d)}`)),
      )
      yield* (yield* Assistant).send(p.id, "Never mind that").pipe(Effect.orDie)
      assert.deepStrictEqual(yield* Fiber.join(told), { behavior: "deny", message: SKIPPED })
      // The message went to the agent.
      assert.include(json(yield* agent.input), "Never mind that")
    }),
  )

  it.effect("its runs work in its workspace, told its memory last; a routine thread's in its assistant's", () =>
    Effect.gen(function* () {
      const p = yield* profile("runs")
      const { task: a, dir } = yield* opened(p)
      writeFileSync(`${dir}/${USER_FILE}`, "# About the user\n- Their name is Robin\n")
      const launch = yield* AssistantLaunch
      const ws = (yield* launch.workspace(a)) ?? assert.fail("no workspace")
      assert.strictEqual(ws.cwd, dir)
      assert.include(ws.memory, '<memory-file path="USER.md">\n# About the user\n- Their name is Robin\n</memory-file>')
      assert.include(ws.memory, dir)
      // The memory comes last in what it's told.
      const told = yield* (yield* Prompts).system(a.id, { codex: false, permission_mode: "default", memory: ws.memory }).pipe(Effect.orDie)
      assert.include(told, "personal assistant")
      assert.isTrue(
        told.trimEnd().endsWith("There's no log for today yet.\n\n### Notes by topic\n\nThere are no notes by topic in `memory/` yet."),
        told.slice(-300),
      )
      // A routine thread works in its assistant's workspace, with its memory.
      const thread = yield* threadUnder(a)
      const its = (yield* launch.workspace(thread)) ?? assert.fail("no workspace for the routine")
      assert.strictEqual(its.cwd, dir)
      assert.include(its.memory, "Their name is Robin")
      // One whose assistant's folder isn't its own doesn't start.
      const stray = yield* threadUnder(a, "elsewhere")
      assert.strictEqual((yield* Effect.flip(launch.workspace(stray)))._tag, "WorkspaceRefused")
      // Other threads are as before.
      const scratch = yield* (yield* Tasks).create({ title: "scratch", task_type: "scratch", profile_id: p.id }, Actor.user).pipe(Effect.orDie)
      assert.isNull(yield* launch.workspace(scratch))
    }),
  )

  it.effect("the assistant's turns are committed, and tell push it replied; other threads' don't", () =>
    Effect.gen(function* () {
      const p = yield* profile("turns")
      const { task: a, dir } = yield* opened(p)
      const memory = yield* Memory
      const hooks = yield* TurnHooks
      const events = yield* Events
      const watch = yield* events.watch(undefined)
      const replies = yield* watch.live.pipe(
        Stream.filter((e) => e.type === "assistant_reply"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      )
      assert.strictEqual(log(dir).length, 1)
      writeFileSync(`${dir}/${MEMORY_FILE}`, "- remembered\n")
      // A compaction's turn and a run's end aren't replies; the assistant's own turn is.
      yield* hooks.turnEnded(a.id, { compact: true })
      yield* hooks.turnEnded(a.id)
      yield* memory.idle
      assert.deepStrictEqual(log(dir)[0], ["Assistant", "Update MEMORY.md"])
      writeFileSync(`${dir}/notes.md`, "routine's notes\n")
      const thread = yield* threadUnder(a)
      yield* hooks.turnEnded(thread.id, { compact: false })
      yield* memory.idle
      assert.deepStrictEqual(log(dir)[0], ["Assistant", "Update notes.md"])
      yield* hooks.turnEnded(a.id, { compact: false })
      const [reply] = yield* Fiber.join(replies)
      assert.deepStrictEqual(reply?.type === "assistant_reply" ? [reply.task_id, reply.profile_id] : reply, [a.id, p.id])
    }),
  )

  it.effect("the assistant's prompt starts with its routines' unread reports, read once its agent has started", () =>
    Effect.gen(function* () {
      const p = yield* profile("reports")
      const a = yield* (yield* Assistant).get(p.id)
      const launch = yield* AssistantLaunch
      assert.isNull(yield* launch.reports(a))
      yield* (yield* Threads)
        .report(a.id, "info", "All quiet but one", { automation: "Inbox", outcome: "reported", text: "All quiet but one", key: "A-2" })
        .pipe(Effect.orDie)
      const r = (yield* launch.reports(a)) ?? assert.fail("no reports")
      assert.include(r.preface, "All quiet but one")
      assert.strictEqual((yield* (yield* Routines).unreadReports(a.id))?.reports.length, 1)
      yield* r.started
      assert.isNull(yield* launch.reports(a))
      // A routine thread isn't told them.
      assert.isNull(yield* launch.reports(yield* threadUnder(a)))
    }),
  )

  it.effect("routines reach the assistant through RoutineHost: made if need be, its workspace checked", () =>
    Effect.gen(function* () {
      const p = yield* profile("routines")
      const host = yield* RoutineHost
      const a = yield* host.assistant(p.id)
      assert.strictEqual(a.task_type, "assistant")
      assert.strictEqual(yield* host.workspace(a), `${(yield* DataDir).root}/assistants/${a.id}`)
      assert.isTrue(((yield* host.google(p.id)) ?? "").startsWith("not connected: There's no Google server"))
    }),
  )

  it.effect("a later run of its conversation is told what changed in its memory before its message", () =>
    Effect.gen(function* () {
      const p = yield* profile("updates")
      const { task: a, dir } = yield* opened(p)
      const launch = yield* AssistantLaunch
      const repo = yield* TaskRepo
      const today = `memory/${yield* (yield* Memory).today}.md`
      const inSession = (session: string) =>
        Effect.gen(function* () {
          yield* repo.write(a.id, { session_id: session }, a.created_at)
          return (yield* repo.get(a.id)) ?? assert.fail("no assistant")
        })
      /** A prompt run's workspace, its conversation told once its agent has started (`started`). */
      const runOf = (t: Task, started = true, compact = false) =>
        Effect.gen(function* () {
          const w = (yield* launch.workspace(t, { compact })) ?? assert.fail("no workspace")
          if (started) yield* w.told
          return w
        })
      // A new conversation is told its memory in its instructions, and nothing before its message.
      assert.strictEqual((yield* runOf(a)).update, "")
      const s1 = yield* inSession("s1")
      // Nothing changed since: nothing.
      assert.strictEqual((yield* runOf(s1)).update, "")
      // A log made since is told whole; then only what's added at its end.
      writeFileSync(`${dir}/${today}`, "# Today\n- First thing\n")
      const made = (yield* runOf(s1)).update
      assert.include(made, `<memory-file path="${today}">\n# Today\n- First thing\n</memory-file>`)
      assert.notInclude(made, "USER.md")
      writeFileSync(`${dir}/${today}`, "# Today\n- First thing\n- Second thing\n")
      const added = (yield* runOf(s1)).update
      assert.include(added, `<memory-file path="${today}" part="end">\n- Second thing\n</memory-file>`)
      assert.notInclude(added, "First thing")
      assert.isTrue(added.startsWith("<memory-update>") && added.endsWith("</memory-update>\n\n"), added)
      // The user's edit, whole; told again until a run's agent starts with it.
      writeFileSync(`${dir}/${USER_FILE}`, "# About the user\n- Their name is Sam\n")
      assert.include((yield* runOf(s1, false)).update, "- Their name is Sam")
      assert.include((yield* runOf(s1)).update, "- Their name is Sam")
      assert.strictEqual((yield* runOf(s1)).update, "")
      // A compaction is told nothing; after one, the next run is told all of it.
      assert.strictEqual((yield* runOf(s1, true, true)).update, "")
      yield* TestClock.adjust("1 minute")
      yield* (yield* ContextStatsRepo).insertCompaction({
        task_id: a.id,
        run_id: RunId.make("compaction"),
        at: Timestamp.make(DateTime.formatIso(yield* DateTime.now)),
        tokens: null,
        post_tokens: null,
        max_tokens: null,
        model: null,
        source: "idle",
        duration_ms: null,
      })
      const all = (yield* runOf(s1)).update
      assert.include(all, "Your memory files as they are now")
      assert.include(all, "- Their name is Sam")
      assert.include(all, "- Second thing")
      // So is another session's.
      assert.include((yield* runOf(yield* inSession("s2"))).update, "Your memory files as they are now")
      // A routine thread's conversation is its own: one it hasn't told is told all of it.
      const thread = yield* threadUnder(a)
      yield* repo.write(thread.id, { session_id: "r1" }, a.created_at)
      const routine = (yield* repo.get(thread.id)) ?? assert.fail("no routine")
      assert.include((yield* runOf(routine)).update, "Your memory files as they are now")
      assert.strictEqual((yield* runOf(yield* inSession("s2"))).update, "")
      // A launch puts it first in the run's message, and tells the conversation once the agent starts.
      writeFileSync(`${dir}/${MEMORY_FILE}`, "# Memory\n- The car is blue\n")
      const facts = yield* LaunchFacts
      const run = (yield* fakeAgent({ task: a.id })).run
      const prepared = yield* facts.claude(run, "What colour is the car?")
      const sent = prepared.spec.prompt
      assert.isTrue(sent.indexOf("<memory-update>") >= 0 && sent.indexOf("<memory-update>") < sent.indexOf("What colour is the car?"), sent)
      assert.include(sent, "- The car is blue")
      yield* prepared.started ?? Effect.void
      assert.notInclude((yield* facts.claude((yield* fakeAgent({ task: a.id })).run, "And now?")).spec.prompt, "<memory-update>")
      // A command stays at the start of the message, which is the only place Claude Code runs one: the update follows it.
      writeFileSync(`${dir}/${MEMORY_FILE}`, "# Memory\n- The car is red\n")
      const command = yield* facts.claude((yield* fakeAgent({ task: a.id })).run, "/remember the car")
      assert.include(command.spec.prompt, '"content":"/remember the car\\n\\n<memory-update>')
      assert.include(command.spec.prompt, "- The car is red")
    }),
  )

  it.effect("a note by topic is listed, and put before a message that names its keyword, once a conversation", () =>
    Effect.gen(function* () {
      const p = yield* profile("notes")
      const { task: a, dir } = yield* opened(p)
      const launch = yield* AssistantLaunch
      const repo = yield* TaskRepo
      mkdirSync(`${dir}/memory`, { recursive: true })
      const invoices =
        "---\nname: Invoices\ndescription: How the user bills clients\nkeywords: [invoice, billing]\nmetadata:\n  type: project\n---\n- Sent on the 1st.\n"
      writeFileSync(`${dir}/memory/invoices.md`, invoices)
      // A file there with no keywords is as before: neither listed nor loaded.
      writeFileSync(`${dir}/memory/plain.md`, "---\nname: Plain\ndescription: no keywords\n---\n- PLAIN BODY\n")
      const runOf = (t: Task, message: string) =>
        Effect.gen(function* () {
          const w = (yield* launch.workspace(t, { compact: false, message })) ?? assert.fail("no workspace")
          yield* w.told
          return w
        })
      // The instructions list it, by path, name and description only.
      const first = yield* runOf(a, "Good morning")
      assert.include(first.memory, "- `memory/invoices.md` (project): Invoices — How the user bills clients")
      assert.notInclude(first.memory, "Sent on the 1st")
      assert.notInclude(first.memory, "memory/plain.md")
      // A message that names none of its keywords isn't told it.
      assert.strictEqual(first.update, "")
      // One that does is told it before the message, even a new conversation's.
      const named = yield* runOf(a, "Did the Invoice for May go out?")
      assert.include(named.update, "<memory-notes>\nYour notes by topic")
      assert.include(named.update, '<memory-file path="memory/invoices.md">\n- Sent on the 1st.\n</memory-file>')
      assert.notInclude(named.update, "PLAIN BODY")
      // A later run of the conversation that has it isn't told it again, until it changes.
      yield* repo.write(a.id, { session_id: "n1" }, a.created_at)
      const s1 = (yield* repo.get(a.id)) ?? assert.fail("no assistant")
      // (Its first run's session is the one its agent started, which had it.)
      assert.strictEqual((yield* runOf(s1, "billing again")).update, "")
      writeFileSync(`${dir}/memory/invoices.md`, invoices.replace("the 1st", "the 2nd"))
      const changed = (yield* runOf(s1, "Hello")).update
      assert.include(changed, "- Sent on the 2nd.")
      // Another session can't be sure it has it: told it again when its message names it, not otherwise.
      yield* repo.write(a.id, { session_id: "n2" }, a.created_at)
      const s2 = (yield* repo.get(a.id)) ?? assert.fail("no assistant")
      assert.notInclude((yield* runOf(s2, "Hello")).update, "<memory-notes>\n")
      assert.include((yield* runOf(s2, "billing")).update, "- Sent on the 2nd.")
      // A note made meanwhile changes the list, which the next run is told.
      writeFileSync(`${dir}/memory/car.md`, "---\nname: The car\ndescription: Its service history\nkeywords: car\n---\n- Serviced in March.\n")
      const listed = (yield* runOf(s1, "Hello")).update
      assert.include(listed, "<memory-update>")
      assert.include(listed, "- `memory/car.md`: The car — Its service history")
      assert.notInclude(listed, "Serviced in March")
      // A launch puts the note before the message.
      const facts = yield* LaunchFacts
      const prepared = yield* facts.claude((yield* fakeAgent({ task: a.id })).run, "When is the car due?")
      const sent = prepared.spec.prompt
      assert.isTrue(sent.indexOf("- Serviced in March.") >= 0 && sent.indexOf("- Serviced in March.") < sent.indexOf("When is the car due?"), sent)
    }),
  )

  it.effect("a workspace that is a symlink is refused, and its memory isn't loaded", () =>
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const memory = yield* Memory
      const mine = yield* profile("personal")
      const theirs = yield* profile("work")
      const { task: a, dir: myDir } = yield* opened(mine)
      const { task: b, dir: theirDir } = yield* opened(theirs)
      writeFileSync(`${theirDir}/SECRET.md`, "WORK SECRET")
      // Personal's workspace is swapped for a symlink to work's.
      rmSync(myDir, { recursive: true })
      symlinkSync(theirDir, myDir)
      assert.strictEqual((yield* Effect.flip(memory.checked(a)))._tag, "Unavailable")
      const refused = [
        yield* Effect.flip(assistant.memory(mine.id)),
        yield* Effect.flip(assistant.memoryFile(mine.id, "SECRET.md", null)),
        yield* Effect.flip(assistant.writeMemoryFile(mine.id, "SECRET.md", "overwritten", null, true)),
        yield* Effect.flip(assistant.memoryHistory(mine.id, null)),
      ]
      for (const e of refused) {
        assert.strictEqual(e._tag, "Unavailable")
        assert.notInclude(json(e), "WORK SECRET")
      }
      assert.strictEqual(readFileSync(`${theirDir}/SECRET.md`, "utf8"), "WORK SECRET")
      // Its runs don't start there, aren't told work's memory, and its turns don't commit there.
      assert.strictEqual((yield* Effect.flip((yield* AssistantLaunch).workspace(a)))._tag, "WorkspaceRefused")
      const told = (yield* memory.forRun(a, null)).system
      assert.isTrue(told.includes("Your memory isn't loaded") && !told.includes("<memory-file"), told)
      yield* (yield* TurnHooks).turnEnded(a.id, { compact: false })
      yield* memory.idle
      assert.strictEqual(log(theirDir).length, 1)
      // Nor is anything made through it when it's opened.
      yield* assistant.get(mine.id)
      assert.isFalse(existsSync(`${theirDir}/memory/x`))

      // The same for the folder of all the assistants.
      unlinkSync(myDir)
      const assistants = `${(yield* DataDir).root}/assistants`
      const elsewhere = `${mkdtempSync(`${tmpdir()}/huntaway-elsewhere-`)}/assistants`
      renameSync(assistants, elsewhere)
      symlinkSync(elsewhere, assistants)
      assert.strictEqual((yield* Effect.flip(memory.checked(b)))._tag, "Unavailable")
      assert.strictEqual((yield* Effect.flip(assistant.memoryFile(theirs.id, "SECRET.md", null)))._tag, "Unavailable")
      // Put back for the other tests on this board.
      unlinkSync(assistants)
      renameSync(elsewhere, assistants)
    }),
  )

  it.effect("the memory API stays in its profile's workspace", () =>
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const mine = yield* profile("mine")
      const theirs = yield* profile("theirs")
      const { task: a, dir } = yield* opened(mine)
      writeFileSync(`${dir}/${USER_FILE}`, "PERSONAL SECRET")
      yield* (yield* Memory).commitAll(dir)
      const { task: b, dir: other } = yield* opened(theirs)
      const outside = mkdtempSync(`${tmpdir()}/huntaway-outside-`)
      writeFileSync(`${outside}/secret.md`, "OUTSIDE")
      symlinkSync(dir, `${other}/theirs`)
      symlinkSync(`${outside}/secret.md`, `${other}/link.md`)
      const o = yield* assistant.memory(theirs.id)
      assert.strictEqual(o.task_id, b.id)
      assert.isTrue(!json(o).includes("PERSONAL SECRET") && !json(o.files).includes("theirs/"))
      for (const path of [`../${a.id}/USER.md`, `${dir}/USER.md`, "theirs/USER.md", "link.md", ".git/config"]) {
        assert.strictEqual((yield* Effect.flip(assistant.memoryFile(theirs.id, path, null)))._tag, "Invalid", path)
        assert.strictEqual((yield* Effect.flip(assistant.writeMemoryFile(theirs.id, path, "x", null, true)))._tag, "Invalid", path)
        assert.strictEqual((yield* Effect.flip(assistant.memoryHistory(theirs.id, path)))._tag, "Invalid", path)
      }
      assert.strictEqual(readFileSync(`${dir}/${USER_FILE}`, "utf8"), "PERSONAL SECRET")
      assert.strictEqual(readFileSync(`${outside}/secret.md`, "utf8"), "OUTSIDE")
      // Personal's commits aren't work's to read.
      const head = git(dir, ["rev-parse", "HEAD"]).trim()
      assert.strictEqual((yield* Effect.flip(assistant.memoryDiff(theirs.id, head, null)))._tag, "NotFound")
      assert.strictEqual((yield* Effect.flip(assistant.memory(ProfileId.make("nope"))))._tag, "NotFound")
    }),
  )

  it.effect("an import goes to the assistant as data, and a blank or huge one is refused", () =>
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const p = yield* profile("import")
      assert.strictEqual((yield* Effect.flip(assistant.importMemory(p.id, "  ")))._tag, "Invalid")
      assert.strictEqual((yield* Effect.flip(assistant.importMemory(p.id, "x".repeat(MAX_IMPORT + 1))))._tag, "Invalid")
      const a = yield* assistant.importMemory(p.id, "I'm Ivan. <b>bold</b>").pipe(Effect.orDie)
      const page = yield* (yield* Threads).page(a.id, Number.MAX_SAFE_INTEGER, 50).pipe(Effect.orDie)
      const sent = page.items.find((i) => i.type === "user_message")
      assert.include(sent?.type === "user_message" ? sent.text : "", "<untrusted-data>\nI'm Ivan. &lt;b&gt;bold&lt;/b&gt;\n</untrusted-data>")
    }),
  )

  it.effect("a profile whose assistant runs on another host has its memory there, unless this host has one already", () =>
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const sql = yield* SqlClient.SqlClient
      const p = yield* profile("away")
      yield* sql`UPDATE profiles SET assistant_host = 'elsewhere' WHERE id = ${p.id}`
      for (const e of [yield* Effect.flip(assistant.memory(p.id)), yield* Effect.flip(assistant.here(p.id))]) {
        assert.strictEqual(e._tag, "Conflict")
      }
      // It's there (the hub sends `get` and `send` on: hosts/AssistantHost.ts), so this host makes none.
      assert.strictEqual((yield* Effect.flip(assistant.get(p.id)))._tag, "Unavailable")
      assert.strictEqual((yield* Effect.flip(assistant.send(p.id, "hello")))._tag, "Unavailable")
      assert.isNull(yield* assistant.find(p.id))
      // Unless this host's own is asked for (what the hub asks of its assistant's host, whose profile may say otherwise):
      // then it's made here, and it's this host's own from then on, whatever its profile says.
      const made = yield* assistant.get(p.id, true)
      assert.strictEqual((yield* assistant.get(p.id)).id, made.id)
      assert.strictEqual((yield* assistant.memory(p.id)).files[0]?.path, "USER.md")
    }),
  )

  it.effect("the assistant's details remove items from its tracked work", () =>
    Effect.gen(function* () {
      const p = yield* profile("tracked")
      const a = yield* (yield* Assistant).get(p.id)
      const tasks = yield* Tasks
      const item = (id: string) => ({
        id,
        title: id,
        note: null,
        status: "working" as const,
        task_id: null,
        task_key: null,
        url: null,
        created_at: a.created_at,
        updated_at: a.created_at,
      })
      yield* tasks.change(a.id, () => ({ tracked: [item("a1"), item("b2"), item("c3")] }), Actor.board).pipe(Effect.orDie)
      const tracked = yield* Tracked
      const after = yield* tracked.remove(a.id, ["a1", "c3", "zz"])
      assert.deepStrictEqual(
        after.tracked.map((i) => i.id),
        ["b2"],
      )
      const scratch = yield* tasks.create({ title: "scratch", task_type: "scratch", profile_id: p.id }, Actor.user).pipe(Effect.orDie)
      assert.strictEqual((yield* Effect.flip(tracked.remove(scratch.id, ["b2"])))._tag, "Invalid")
      assert.strictEqual((yield* Effect.flip(tracked.remove(TaskId.make("nope"), ["b2"])))._tag, "TaskNotFound")
    }),
  )
})

// HA-203: the data folder itself may be a symlink (as a --data-dir can be): the workspace and its history are found.
const real = mkdtempSync(`${tmpdir()}/huntaway-real-`)
const via = `${mkdtempSync(`${tmpdir()}/huntaway-via-`)}/via`
symlinkSync(real, via)

layer(TestBoard({ dataDir: via }))("Assistant, on a data folder reached through a symlink", (it) => {
  it.effect("the workspace and its history are found through it", () =>
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const p = yield* profile("p")
      const o = yield* assistant.memory(p.id)
      // (The data folder as the server found it, through the symlink or not.)
      assert.strictEqual(o.dir, `${(yield* DataDir).root}/assistants/${o.task_id}`)
      assert.isTrue(existsSync(`${real}/assistants/${o.task_id}.git`))
      yield* assistant.writeMemoryFile(p.id, "notes/a.md", "a", null, false)
      assert.strictEqual(readFileSync(`${real}/assistants/${o.task_id}/notes/a.md`, "utf8"), "a")
      assert.deepStrictEqual(log(o.dir)[0], ["You", "Edit notes/a.md"])
    }),
  )
})

// HE-8: on a board imported from an old one (`import.json`), an assistant keeps its workspace in the old data folder,
// where its sessions ran; that folder's `assistants/<id>` is its own, and no other folder outside the board's is.
const importedInto = mkdtempSync(`${tmpdir()}/huntaway-imported-`)
const oldFolder = mkdtempSync(`${tmpdir()}/huntaway-old-`)
writeFileSync(
  `${importedInto}/import.json`,
  json({ from: oldFolder, at: "2026-11-12T00:00:00.000Z", old_host_id: "old-host", rehearsal: false, database: "huntaway-2.db" }),
)

layer(TestBoard({ dataDir: importedInto }))("Assistant, on an imported board", (it) => {
  it.effect("its workspace in the old data folder is its own; one elsewhere is refused", () =>
    Effect.gen(function* () {
      const memory = yield* Memory
      const p = yield* profile("p")
      const { task: a } = yield* opened(p)
      const at = (workDir: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE tasks SET work_dir = ${workDir} WHERE id = ${a.id}`.pipe(Effect.orDie)
          return (yield* (yield* TaskRepo).get(a.id)) ?? assert.fail("no assistant")
        })
      assert.strictEqual(yield* memory.checked(yield* at(`${oldFolder}/assistants/${a.id}`)), `${oldFolder}/assistants/${a.id}`)
      assert.isTrue(existsSync(`${oldFolder}/assistants/${a.id}`))
      const elsewhere = mkdtempSync(`${tmpdir()}/huntaway-elsewhere-`)
      assert.strictEqual((yield* Effect.flip(memory.checked(yield* at(`${elsewhere}/assistants/${a.id}`))))._tag, "Unavailable")
    }),
  )
})
