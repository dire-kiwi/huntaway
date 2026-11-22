import { BOARD_TOOLS } from "@huntaway/shared"
import { Effect } from "effect"
import { McpServers } from "../McpServers.ts"
import type { RegisteredTool } from "../McpServers.ts"
// 6.5
import { automationTools } from "./automations.ts"
// HE-77
import { a2uiTools } from "./a2ui.ts"
import { connectionTools } from "./connections.ts"
import { penTools } from "./pens.ts"
import { projectTools } from "./projects.ts"
import { questionTools } from "./questions.ts"
import { reviewTools } from "./review.ts"
import { suggestionTools } from "./suggestions.ts"
import { taskTools } from "./tasks.ts"
import { trackingTools } from "./tracking.ts"
import { waitTools } from "./wait.ts"
import { workflowTools } from "./workflows.ts"

// The board's own server, `huntaway` (docs/plan/07-agents.md, Board tools): every area's tools, registered in the
// order the old server listed them (mcp.ts `board_tools`), which is the order runs are shown them. An area that adds
// tools adds its list here; `BOARD_TOOLS` places each. Still to come: the automations (6.5) and the workflows (6.6).

/** Every tool of the board's server, in `tools/list`'s order (in packages/shared, where the ACP adapter reads it too). */
export { BOARD_TOOLS }

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
      ...Object.values(yield* connectionTools),
      ...Object.values(yield* trackingTools),
      ...Object.values(yield* waitTools),
      ...Object.values(yield* projectTools),
      ...Object.values(yield* taskTools),
      ...Object.values(yield* penTools),
      // HE-61
      ...Object.values(yield* suggestionTools),
      // HE-77
      ...Object.values(yield* a2uiTools),
      ...Object.values(yield* reviewTools),
      // 6.5
      ...Object.values(yield* automationTools),
      // 6.6
      ...Object.values(yield* workflowTools),
    ]
    return all.toSorted((a, b) => rank(a) - rank(b))
  }),
)
