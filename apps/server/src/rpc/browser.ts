import { Effect } from "effect"
import { BrowserRpcs, NotFound } from "@huntaway/contracts"
import { Browsers } from "../browser/Browsers.ts"
import { Tasks } from "../tasks/Tasks.ts"

const taskNotFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "task", id: e.id }))

export const BrowserHandlers = BrowserRpcs.toLayer(
  Effect.gen(function* () {
    const browsers = yield* Browsers
    const tasks = yield* Tasks
    return BrowserRpcs.of({
      "browser.open": ({ task_id, role }) =>
        browsers.ticket(task_id, role).pipe(
          Effect.map((ticket) => ({ ticket })),
          Effect.catchTag("TaskNotFound", taskNotFound),
        ),
      "browser.status": ({ task_id }) =>
        tasks.get(task_id).pipe(
          Effect.andThen(browsers.state(task_id)),
          Effect.map((s) => (s === null ? null : { url: s.url, title: s.title, loading: s.loading })),
          Effect.catchTag("TaskNotFound", taskNotFound),
        ),
    })
  }),
)
