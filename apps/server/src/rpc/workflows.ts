import { Effect } from "effect"
import { Conflict, Invalid, WorkflowRpcs } from "@huntaway/contracts"
import type { WorkflowRefused } from "../workflows/WorkflowEngine.ts"
import { WorkflowEngine } from "../workflows/WorkflowEngine.ts"
import { Workflows } from "../workflows/Workflows.ts"

/** A run the engine refused: a request that's wrong (`Invalid`), or one the board's state refuses (`Conflict`). */
const refused = (e: WorkflowRefused) =>
  Effect.fail(e.invalid ? new Invalid({ field: "task_id", reason: e.reason }) : new Conflict({ reason: "changed_meanwhile", detail: e.reason }))

export const WorkflowHandlers = WorkflowRpcs.toLayer(
  Effect.gen(function* () {
    const workflows = yield* Workflows
    const engine = yield* WorkflowEngine
    return WorkflowRpcs.of({
      "workflows.list": ({ project_id }) => workflows.list(project_id),
      "workflows.get": ({ id }) => workflows.get(id),
      "workflows.create": ({ workflow }) => workflows.create(workflow),
      "workflows.update": ({ id, patch }) => workflows.update(id, patch),
      "workflows.delete": ({ id }) => workflows.delete(id).pipe(Effect.asVoid),
      "workflows.run": ({ id, task_id }) => engine.run(id, task_id).pipe(Effect.catchTag("WorkflowRefused", refused)),
      "workflows.runsOfTask": ({ task_id }) => engine.runsOfTask(task_id),
      "workflows.stopRun": ({ id }) => engine.stopRun(id, "Stopped by the user.").pipe(Effect.map((stopped) => ({ stopped }))),
    })
  }),
)
