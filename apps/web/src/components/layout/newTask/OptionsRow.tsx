import { AsanaIcon, LinkList } from "../../task/ExternalLinks"
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
  kept: { linking, setPickingLink, links, setLinks },
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
        {/* The config picker and its usage note (settings/ClaudeConfigs) come with the settings on this server;
            attaching files (task/Attachments) later too. */}
        <div className="-my-1 ml-auto flex items-center gap-1">
          {linking && (
            <button
              type="button"
              onClick={() => setPickingLink(true)}
              title="Link the Asana task this is for"
              className="flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] text-faint hover:bg-white/5 hover:text-fg"
            >
              <AsanaIcon size={13} /> Link Asana task
            </button>
          )}
        </div>
      </div>
      {linking && links.length > 0 && <LinkList chips links={links} onRemove={(l) => setLinks((ls) => ls.filter((x) => x !== l))} />}
    </>
  )
}
