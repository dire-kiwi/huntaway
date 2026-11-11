import { type HostProfile as Profile, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"
import { asanaLink, AsanaPicker } from "../task/ExternalLinks"
import { Modal } from "../ui"
import { submitBlocks } from "./newTask/blocks"
import { Editor, Legend } from "./newTask/Editor"
import { Footer } from "./newTask/Footer"
import { Notes } from "./newTask/Notes"
import { OptionsRow } from "./newTask/OptionsRow"
import { ReadsAs } from "./newTask/ReadsAs"
import { useAgentChoice } from "./newTask/useAgentChoice"
import { useCompletion } from "./newTask/useCompletion"
import { useDraft } from "./newTask/useDraft"
import { useEditorLayout } from "./newTask/useEditorLayout"
import { useEditorText } from "./newTask/useEditorText"
import { useOptions } from "./newTask/useOptions"
import { useSubmit } from "./newTask/useSubmit"
import { useTokens } from "./newTask/useTokens"
import { useOrigin, useWhere } from "./newTask/useWhere"

/**
 * The new task form. Its options are tokens typed in the description (IA-220): `/plan` its type, `in:IA` where it goes
 * (or `in:group`, `in:none`), `!sonnet` its model (several make a task with each, IA-227), `^high` its effort, `#IA-212`
 * a task to merge first and `from:IA-12` what its worktree starts from. They're taken
 * out of what its agent is given. With none, it goes where the dialog was opened, with the options last picked there.
 */
export function NewTaskModal({
  project: initial,
  projects,
  group: groupName,
  scratch,
  onClose,
  status = "todo",
  onCreated,
}: {
  /** Where it goes. Without one, it can only be a scratch task (`scratch`). */
  project?: Project | undefined
  /** Projects to pick from (`in:` and their key), starting at `project`. Without them the task goes in `project`. */
  projects?: ReadonlyArray<Project> | undefined
  /** The group `projects` are, which offers a group task too: one in no project that plans the group's work (API 34). */
  group?: string | undefined
  /** The profile (on the host its scratch tasks go to) that offers a scratch task in no project too, with no repository (API 47). */
  scratch?: Profile | null | undefined
  onClose: () => void
  status?: Status | undefined
  /** Told of the tasks it makes (on a pen's tab, to put them in the pen). */
  onCreated?: ((tasks: Task[]) => void) | undefined
}) {
  const opened = { initial, projects, groupName, scratch }
  // Where the dialog starts and its draft, the text, where its `in:` (or type) sends it, and what it runs with there.
  const origin = useOrigin(opened)
  const ed = useEditorText(origin.saved)
  const place = useWhere(opened, origin, ed)
  const agent = useAgentChoice(place)
  const tok = useTokens(place, agent, ed, origin.saved)
  const kept = useDraft(origin, place, agent, ed, tok)
  const options = useOptions(place, tok)
  const blocks = submitBlocks(place, agent, tok, options)
  const submission = useSubmit({ opened, status, onClose, onCreated, origin, ed, where: place, agent, tok, kept, options, blocks })
  const completion = useCompletion(opened, origin, ed, place, agent, tok)
  const layout = useEditorLayout(ed, completion)

  const { group, hosts } = origin
  const { project, noProject, asGroup, host } = place
  const { noun, docType } = tok
  const { attach, pickingLink, setPickingLink, links, setLinks } = kept
  const { description, input, edit } = ed
  const { target } = place
  const { text } = tok
  const { submit } = submission
  const hostCount = hosts.length
  const where = noProject
    ? scratch?.name
    : asGroup
      ? docType
        ? `the ${group} group`
        : group
      : `${project?.name}${hostCount > 1 && projects?.some((p) => p.host_id !== project?.host_id) ? ` (${host?.name})` : ""}`

  return (
    <Modal
      title={
        <span>
          New {noun}{" "}
          <span className="font-normal text-muted">
            {asGroup ? "for" : "in"} {where}
          </span>
        </span>
      }
      onClose={onClose}
      // Not while the Asana dialog is open over it, whose Enter (with Ctrl or Cmd too) is its own.
      onSubmit={pickingLink ? undefined : () => void submit()}
      width="max-w-xl"
    >
      <form
        className="space-y-3"
        {...attach.dropProps}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Editor ed={ed} completion={completion} layout={layout} where={place} tok={tok} attach={attach} />
        <ReadsAs opened={opened} origin={origin} where={place} agent={agent} tok={tok} />
        <Legend completion={completion} />
        <OptionsRow where={place} tok={tok} options={options} agent={agent} kept={kept} />
        <Notes opened={opened} origin={origin} where={place} tok={tok} worktree={options.worktree} blocks={blocks} whenLoaded={submission.whenLoaded} />
        <Footer submission={submission} options={options} tok={tok} kept={kept} blocks={blocks} onClose={onClose} />
      </form>
      {pickingLink && (
        <AsanaPicker
          hostId={target.host_id}
          profileId={target.profile_id}
          linked={links}
          onClose={() => setPickingLink(false)}
          onPick={(t) => {
            setPickingLink(false)
            setLinks((ls) => [...ls, asanaLink(t)])
            // Nothing written yet (tokens aside): the Asana task says what to do.
            const about = [t.name, t.notes.trim()].filter(Boolean).join("\n\n")
            const next = description.trim() ? `${description.trimEnd()}\n\n${about}` : about
            if (!text.trim()) edit(next, next.length)
            else input.current?.focus()
          }}
        />
      )}
    </Modal>
  )
}
