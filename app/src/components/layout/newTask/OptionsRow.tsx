import type { Task } from "../../../api";
import { ConfigSelect, ConfigUsageNote } from "../../settings/ClaudeConfigs";
import { AttachButton } from "../../task/Attachments";
import { AsanaIcon, LinkList } from "../../task/ExternalLinks";
import { Toggle } from "../../ui";
import { pickerClass } from "./ModelPicker";
import type { AgentChoice } from "./useAgentChoice";
import type { DraftExtras } from "./useDraft";
import type { Options } from "./useOptions";
import type { Tokens } from "./useTokens";
import type { Where } from "./useWhere";

/** The row of toggles and the config picker, the buttons that link an Asana task and attach files, and the Asana tasks linked. */
export function OptionsRow({
  subproject,
  where: { inProject },
  tok: { codeTask, asSubproject, fanout, startFrom },
  options: { worktree, setWorktree, agents, start, setStart },
  agent: { pickConfig, configs, config, setConfig, configObj },
  kept: { linking, setPickingLink, attach, links, setLinks },
}: {
  subproject?: Task;
  where: Where;
  tok: Tokens;
  options: Options;
  agent: AgentChoice;
  kept: DraftExtras;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-1">
        {!subproject && inProject && codeTask && !asSubproject && !fanout && startFrom === undefined && <Toggle checked={worktree} onChange={setWorktree} label="Own git worktree" />}
        {agents && <Toggle checked={start} onChange={setStart} label="Start agent now" />}
        {pickConfig && <ConfigSelect className={pickerClass} configs={configs} value={config} onChange={setConfig} />}
        <ConfigUsageNote config={configObj} />
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
          <AttachButton draft={attach} label="Attach files" />
        </div>
      </div>
      {linking && links.length > 0 && <LinkList chips links={links} onRemove={(l) => setLinks((ls) => ls.filter((x) => x !== l))} />}
    </>
  );
}
