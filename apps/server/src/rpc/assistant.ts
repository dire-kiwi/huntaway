import { Effect } from "effect"
import { AssistantRpcs, NotFound } from "@huntaway/contracts"
import { Assistant } from "../assistant/Assistant.ts"
import { Brief } from "../assistant/Brief.ts"
import { Google } from "../assistant/Google.ts"
import { Tracked } from "../assistant/Tracked.ts"
import type { SendRefused } from "../runs/Runs.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"
import { sendRefused } from "./tasks.ts"

const taskNotFound = (e: TaskNotFound) => Effect.fail(new NotFound({ what: "task", id: e.id }))
const sent = { TaskNotFound: taskNotFound, SendRefused: (e: SendRefused) => sendRefused(e) }

export const AssistantHandlers = AssistantRpcs.toLayer(
  Effect.gen(function* () {
    const assistant = yield* Assistant
    const brief = yield* Brief
    const google = yield* Google
    const tracked = yield* Tracked
    return AssistantRpcs.of({
      "assistant.get": ({ profile_id }) => assistant.get(profile_id),
      "assistant.send": ({ profile_id, text }) => assistant.send(profile_id, text).pipe(Effect.catchTags(sent)),
      "assistant.memory": ({ profile_id }) => assistant.memory(profile_id),
      "assistant.memoryFile": ({ profile_id, path, rev }) => assistant.memoryFile(profile_id, path, rev ?? null),
      "assistant.writeMemoryFile": ({ profile_id, path, content, expected, force }) =>
        assistant.writeMemoryFile(profile_id, path, content, expected ?? null, force ?? false),
      "assistant.memoryHistory": ({ profile_id, path }) => assistant.memoryHistory(profile_id, path ?? null),
      "assistant.memoryDiff": ({ profile_id, rev, path }) => assistant.memoryDiff(profile_id, rev, path ?? null),
      "assistant.restoreMemory": ({ profile_id, path, rev }) => assistant.restoreMemory(profile_id, path, rev),
      "assistant.importMemory": ({ profile_id, text }) => assistant.importMemory(profile_id, text).pipe(Effect.catchTags(sent)),
      "assistant.google": ({ profile_id, check }) => google.status(profile_id, check ?? false),
      "assistant.setupGoogle": ({ profile_id }) => google.setup(profile_id),
      "assistant.addBrief": ({ profile_id, time, weekdays }) => brief.add(profile_id, time ?? null, weekdays ?? null),
      "assistant.briefFeedback": ({ profile_id, rating, kind, topic, text }) =>
        brief.feedback(profile_id, rating, { kind: kind ?? null, topic: topic ?? null, text: text ?? null }),
      "tasks.removeTracked": ({ id, ids }) => tracked.remove(id, ids).pipe(Effect.catchTag("TaskNotFound", taskNotFound)),
    })
  }),
)
