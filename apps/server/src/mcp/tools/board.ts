import { Effect } from "effect"
import { McpServers } from "../McpServers.ts"
import type { RegisteredTool } from "../McpServers.ts"
import { penTools } from "./pens.ts"
import { projectTools } from "./projects.ts"
import { questionTools } from "./questions.ts"
import { reviewTools } from "./review.ts"
import { taskTools } from "./tasks.ts"
import { trackingTools } from "./tracking.ts"
import { waitTools } from "./wait.ts"
import { workflowTools } from "./workflows.ts"

// The board's own server, `huntaway` (docs/plan/07-agents.md, Board tools): every area's tools, registered in the
// order the old server listed them (mcp.ts `board_tools`), which is the order runs are shown them. An area that adds
// tools adds its list here; `BOARD_TOOLS` places each. Still to come: the automations (6.5) and the workflows (6.6).

/** Every tool of the board's server, in `tools/list`'s order. */
export const BOARD_TOOLS: ReadonlyArray<string> = [
  "request_user_input",
  "finish_work",
  "track_work",
  "untrack_work",
  "list_tracked_work",
  "wait",
  "background_wait",
  "list_projects",
  "list_tasks",
  "get_task",
  "get_task_field",
  "create_task",
  "update_task",
  "delete_task",
  "list_pens",
  "create_pen",
  "update_pen",
  "delete_pen",
  "send_to_task",
  "get_project",
  "update_project",
  "create_project",
  "list_automations",
  "create_automation",
  "update_automation",
  "delete_automation",
  "run_automation",
  "list_workflows",
  "create_workflow",
  "update_workflow",
  "delete_workflow",
  "run_workflow",
  "submit_review",
]

const rank = (r: RegisteredTool) => {
  const i = BOARD_TOOLS.indexOf(r.tool.name)
  return i === -1 ? BOARD_TOOLS.length : i
}

/** The board's tools on the `huntaway` server, in order. */
export const BoardTools = McpServers.register(
  "huntaway",
  Effect.gen(function* () {
    const all: ReadonlyArray<RegisteredTool> = [
      ...Object.values(yield* questionTools),
      ...Object.values(yield* trackingTools),
      ...Object.values(yield* waitTools),
      ...Object.values(yield* projectTools),
      ...Object.values(yield* taskTools),
      ...Object.values(yield* penTools),
      ...Object.values(yield* reviewTools),
      // 6.6
      ...Object.values(yield* workflowTools),
    ]
    return all.toSorted((a, b) => rank(a) - rank(b))
  }),
)
