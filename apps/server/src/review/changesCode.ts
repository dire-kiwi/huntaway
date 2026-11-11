import { commandChangesCode } from "@huntaway/shared"
import { DONT_ASK_DENIAL } from "../permissions/prompts.ts"
import type { ToolUseRecord } from "../threads/ThreadReaders.ts"

// "Did the agent change code?" (docs/plan/inventory/04-git-review.md 2.10; huntaway's git/changes.ts `changes_code`):
// whether a tool call changed code, so its task has something to review. The plan puts it in the git area (06-server.md,
// Git); it is here, beside its one caller, because it reads the permissions area's denial (`DONT_ASK_DENIAL`), which is
// below git. The shell reader is `@huntaway/shared`'s `commandChangesCode`.

const DENIALS = ["The command was declined.", "The user denied this action.", DONT_ASK_DENIAL]

/** Whether a tool call's result says it was denied, so it never ran. */
const denied = (result: NonNullable<ToolUseRecord["result"]>): boolean => result.is_error && DENIALS.some((d) => result.content.includes(d))

/**
 * Whether a tool call, given its result if it has one, changed code. An edit is all or nothing, so it only did if it
 * succeeded. A shell command may have written files before it failed or was cut short, so it did unless it was denied
 * and never ran.
 */
export const changesCode = (call: Pick<ToolUseRecord["call"], "name" | "input">, result: ToolUseRecord["result"]): boolean => {
  switch (call.name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
    case "ApplyPatch":
      return result !== null && !result.is_error
    case "Bash": {
      const input = call.input
      const command = typeof input === "object" && input !== null && "command" in input && typeof input.command === "string" ? input.command : ""
      return !(result !== null && denied(result)) && commandChangesCode(command)
    }
    default:
      return false
  }
}
