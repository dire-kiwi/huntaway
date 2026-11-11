import { Context, DateTime, Effect, Layer, Result } from "effect"
import { Invalid, NotFound } from "@huntaway/contracts"
import type { Automation, BriefFeedback, BriefRating, Conflict, ProfileId, Task, TaskDocument, TaskId, Unavailable, Weekday } from "@huntaway/contracts"
import { Automations } from "../automations/Automations.ts"
import { localDay, TaskDocuments } from "../docs/TaskDocuments.ts"
import { TaskDocumentRepo } from "../docs/TaskDocumentRepo.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { MEMORY_FILE } from "../prompts/memory.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { TaskNotFound } from "../tasks/Tasks.ts"
import { Assistant } from "./Assistant.ts"
import { apply, cleanTopic, DEFAULT_TIME, ITEMS_LABEL, items, kindOf, LABEL, line, routine, WEEKDAYS } from "./briefText.ts"
import { BRIEF_FILE, BRIEF_ITEMS_FILE } from "./memory/text.ts"
import { Memory } from "./Memory.ts"

// The morning brief (docs/plan/inventory/02-agent-support.md 2.12; huntaway's agent/assistant/brief.ts and the brief's
// half of agent/documents.ts): the template that adds its routine, the assistant's `brief` document (`brief.html` in its
// workspace, which its routine threads write) kept one version a day with its items (`brief.json`, `brief_items`), and
// the user's ratings of the items, which go into MEMORY.md for later briefs to follow. The plain parts are `brief.ts`.

export interface BriefShape {
  /** Adds the morning brief routine to the profile: on `weekdays` (Monday to Friday) at `time` (07:30), in a fresh thread. */
  readonly add: (profile: ProfileId, time: string | null, weekdays: ReadonlyArray<Weekday> | null) => Effect.Effect<Automation, NotFound | Invalid | Conflict>
  /** Rates one of the brief's items: its line in MEMORY.md, committed as the user's. */
  readonly feedback: (
    profile: ProfileId,
    rating: BriefRating,
    item: { readonly kind: string | null; readonly topic: string | null; readonly text: string | null },
  ) => Effect.Effect<BriefFeedback, NotFound | Invalid | Conflict | Unavailable>
  /** A version of the assistant's brief (the latest unless given), with the items its run wrote the same day. */
  readonly document: (task: TaskId, version: number | undefined) => Effect.Effect<TaskDocument, TaskNotFound | NotFound>
  /**
   * After a tool call or a turn of the assistant or one of its routine threads (which write it): the brief and its items
   * follow their files, a version a day; the end of a turn closes them.
   */
  readonly keep: (task: TaskId, endOfTurn: boolean) => Effect.Effect<void>
}

export class Brief extends Context.Service<Brief, BriefShape>()("huntaway-server/assistant/Brief") {
  static readonly layer = Layer.effect(
    Brief,
    Effect.gen(function* () {
      const assistant = yield* Assistant
      const memory = yield* Memory
      const automations = yield* Automations
      const documents = yield* TaskDocuments
      const repo = yield* TaskDocumentRepo
      const tasks = yield* TaskRepo
      const db = yield* Db
      const events = yield* Events

      const add = Effect.fn("Brief.add")(function* (profile: ProfileId, time: string | null, weekdays: ReadonlyArray<Weekday> | null) {
        const at = time !== null && time.trim() !== "" ? time.trim() : DEFAULT_TIME
        const days = weekdays !== null && weekdays.length > 0 ? weekdays : WEEKDAYS
        yield* assistant.here(profile)
        const made = yield* automations
          .create({ _tag: "Profile", id: profile }, routine(at, days))
          .pipe(Effect.catchTags({ ProfileNotFound: () => Effect.fail(new NotFound({ what: "profile", id: profile })), ProjectNotFound: Effect.die }))
        return yield* automations.wire(made)
      })

      const feedback = Effect.fn("Brief.feedback")(function* (
        profile: ProfileId,
        rating: BriefRating,
        item: { readonly kind: string | null; readonly topic: string | null; readonly text: string | null },
      ) {
        const { dir } = yield* assistant.open(profile)
        const kind = kindOf(item.kind)
        const topic = [item.topic, item.text]
          .filter((v): v is string => v !== null)
          .map(cleanTopic)
          .find((v) => v !== "")
        if (topic === undefined) return yield* new Invalid({ field: "topic", reason: "say what the item is (its topic or text)" })
        const date = yield* memory.today
        const message =
          rating === "clear"
            ? `Take back a rating of the morning brief (${kind}: ${topic})`
            : `Rate the morning brief: ${rating === "up" ? "more" : "less"} ${kind}: ${topic}`
        // Read, changed and committed under the workspace's lock, so two ratings at once (or an edit) both land.
        const [content, commit] = yield* memory.change(dir, MEMORY_FILE, message, (now) => apply(now, rating, kind, topic, date))
        const out: BriefFeedback = { line: rating === "clear" ? null : line(rating, kind, topic, date), content, commit }
        return out
      })

      /** The brief's file, for the assistant `t`: `brief.html` in its workspace. */
      const fileOf = (t: Task) => Effect.map(Effect.option(memory.checked(t)), (dir) => (dir._tag === "Some" ? `${dir.value}/${BRIEF_FILE}` : null))

      const document = Effect.fn("Brief.document")(function* (id: TaskId, asked: number | undefined) {
        const task = yield* tasks.get(id)
        if (task === null) return yield* new TaskNotFound({ id })
        const versions = yield* repo.versions(id, LABEL)
        const version = asked ?? versions.at(-1)?.version ?? null
        const content = version === null ? null : yield* repo.content(id, LABEL, version)
        if (asked !== undefined && content === null) return yield* new NotFound({ what: "version", id: String(asked) })
        // The items to rate: those the run wrote the same day as the version shown, in the host's time zone.
        const shownAt = versions.find((v) => v.version === version)?.created_at
        const shown = shownAt === undefined ? null : localDay(DateTime.makeUnsafe(shownAt))
        let listed: ReadonlyArray<ReturnType<typeof items>[number]> = []
        if (shown !== null) {
          const lists = yield* repo.versions(id, ITEMS_LABEL)
          const same = lists.toReversed().find((l) => localDay(DateTime.makeUnsafe(l.created_at)) === shown)
          const text = same === undefined ? null : yield* repo.content(id, ITEMS_LABEL, same.version)
          if (text !== null) listed = items(text)
        }
        const doc: TaskDocument = {
          label: "brief",
          file: task.kind === "task" && task.task_type === "assistant" ? yield* fileOf(task) : null,
          versions,
          version: content === null ? null : version,
          content,
          items: listed,
        }
        return doc
      })

      const keep = Effect.fn("Brief.keep")(function* (id: TaskId, endOfTurn: boolean) {
        const task = yield* tasks.get(id)
        if (task === null) return
        const whose = yield* Effect.result(assistant.whoseWorkspace(task))
        if (Result.isFailure(whose) || whose.success === null) return
        const owner = whose.success
        const file = yield* fileOf(owner)
        if (file === null) return
        const dir = file.slice(0, file.lastIndexOf("/"))
        let changed = false
        for (const [label, f] of [
          [LABEL, file],
          [ITEMS_LABEL, `${dir}/${BRIEF_ITEMS_FILE}`],
        ] as const) {
          changed = (yield* documents.keepFile(owner.id, label, f, { endOfTurn, daily: true })) || changed
          if (endOfTurn) yield* db.tx(repo.close(owner.id, label))
        }
        if (!changed) return
        const at = yield* nowTimestamp
        yield* db.tx(
          Effect.gen(function* () {
            yield* tasks.write(owner.id, { document_at: at }, at)
            const after = yield* tasks.get(owner.id)
            if (after !== null) yield* events.emit({ type: "task", task: after })
          }),
        )
      })

      return Brief.of({ add, feedback, document, keep })
    }),
  )
}
