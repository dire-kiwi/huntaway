import { Effect } from "effect"
import { NotFound, TaskDocumentRpcs } from "@huntaway/contracts"
import { TaskDocuments } from "../docs/TaskDocuments.ts"

export const TaskDocumentHandlers = TaskDocumentRpcs.toLayer(
  Effect.gen(function* () {
    const documents = yield* TaskDocuments
    return TaskDocumentRpcs.of({
      "tasks.document": ({ id, label, version }) =>
        documents.get(id, label, version).pipe(
          Effect.catchTags({
            TaskNotFound: (e) => Effect.fail(new NotFound({ what: "task", id: e.id })),
            VersionNotFound: (e) => Effect.fail(new NotFound({ what: "version", id: String(e.version) })),
          }),
        ),
    })
  }),
)
