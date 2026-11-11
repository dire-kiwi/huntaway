import { Effect } from "effect"
import { NotFound, TaskDocumentRpcs } from "@huntaway/contracts"
import { TaskDocuments } from "../docs/TaskDocuments.ts"
// 6.7: the assistant's morning brief.
import { Brief } from "../assistant/Brief.ts"

export const TaskDocumentHandlers = TaskDocumentRpcs.toLayer(
  Effect.gen(function* () {
    const documents = yield* TaskDocuments
    const brief = yield* Brief
    return TaskDocumentRpcs.of({
      "tasks.document": ({ id, label, version }) =>
        label === "brief"
          ? brief.document(id, version).pipe(Effect.catchTag("TaskNotFound", (e) => Effect.fail(new NotFound({ what: "task", id: e.id }))))
          : documents.get(id, label, version).pipe(
              Effect.catchTags({
                TaskNotFound: (e) => Effect.fail(new NotFound({ what: "task", id: e.id })),
                VersionNotFound: (e) => Effect.fail(new NotFound({ what: "version", id: String(e.version) })),
              }),
            ),
    })
  }),
)
