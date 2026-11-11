import { Toggle } from "../../ui"
import type { AgentChoice } from "./useAgentChoice"
import type { DraftExtras } from "./useDraft"
import type { Options } from "./useOptions"
import type { Tokens } from "./useTokens"
import type { Where } from "./useWhere"

/** The row of toggles and the config picker, the buttons that link an Asana task and attach files, and the Asana tasks linked. */
export function OptionsRow({
  where: { inProject },
  tok: { codeTask, fanout, startFrom, mergesInto },
  options: { worktree, setWorktree, agents, start, setStart },
}: {
  where: Where
  tok: Tokens
  options: Options
  agent: AgentChoice
  kept: DraftExtras
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
        {inProject && codeTask && !fanout && startFrom === undefined && !mergesInto && (
          <Toggle checked={worktree} onChange={setWorktree} label="Own git worktree" />
        )}
        {agents && <Toggle checked={start} onChange={setStart} label="Start agent now" />}
        {/* The config picker and its usage note (settings/ClaudeConfigs) come with the settings on this server; linking
            an Asana task (task/ExternalLinks) and attaching files (task/Attachments) come later too. */}
      </div>
    </>
  )
}
