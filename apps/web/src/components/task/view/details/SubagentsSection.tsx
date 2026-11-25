import { SubagentItems, subagentCounts, useSubagentList } from "../../../layout/AgentsPill"
import { Section } from "./Section"

/**
 * The thread's subagents in the column beside it (HE-112), in the Agents pill's place: each opens its own thread
 * (`onReveal` shows the thread tab first). Only when it has some.
 */
export function SubagentsSection({
  task,
  onReveal,
}: {
  task: { readonly host_id: string; readonly id: string; readonly running: boolean }
  onReveal?: (() => void) | undefined
}) {
  const { list, running, settled } = useSubagentList(task)
  if (list.length === 0) return null
  return (
    <Section title="Subagents" collapsible="subagents" open right={<span className="text-[11.5px] text-faint">{subagentCounts(running, settled)}</span>}>
      <div className="-mx-2 max-h-80 overflow-y-auto" data-subagents>
        <SubagentItems task={task} list={list} onReveal={onReveal} />
      </div>
    </Section>
  )
}
