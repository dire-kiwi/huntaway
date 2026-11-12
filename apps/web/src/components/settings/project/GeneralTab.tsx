import { Archive, Trash2 } from "lucide-react"
import type { HostProject as Project } from "@huntaway/client"
import type { ProjectForm, SetField } from "./ProjectSettings"
import { Button, Field, Input, Toggle } from "../../ui"

/** The General tab: the project's name, key, folder and group, and archiving or deleting it. */
export function GeneralTab({
  project,
  form,
  groups,
  repoChanged,
  moveRepo,
  setMoveRepo,
  onArchive,
  onDelete,
  set,
}: {
  project: Project
  form: ProjectForm
  groups: ReadonlyArray<string>
  repoChanged: boolean
  moveRepo: boolean
  setMoveRepo: (v: boolean) => void
  onArchive: () => void
  onDelete: () => void
  set: SetField
}) {
  return (
    <>
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Key">
            <Input value={form.key} maxLength={10} onChange={(e) => set("key", e.target.value.toUpperCase())} />
          </Field>
        </div>
        {(form.key !== project.key || project.former_keys.length > 0) && (
          <div className="text-xs text-faint">
            Task keys change with the key. Old ones still find their tasks
            {project.former_keys.length ? ` (${project.former_keys.toReversed().join(", ")})` : ""}.
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Field
          label="Repository path"
          hint={
            !repoChanged
              ? undefined
              : moveRepo
                ? `The folder moves here from ${project.repo_path}. Stop the project's agents first.`
                : "Where the project's folder is now, if it has moved: it must be the same repository. Task worktrees are reconnected to it."
          }
        >
          <Input className="font-mono text-[12px]" value={form.repo_path} onChange={(e) => set("repo_path", e.target.value)} />
        </Field>
        {repoChanged && <Toggle checked={moveRepo} onChange={setMoveRepo} label="Move the folder there" />}
      </div>
      <Field label="Group" hint="Projects in a group are together on the sidebar, and the group has a board of all their tasks">
        <Input value={form.group_name ?? ""} placeholder="No group" list="project-groups" onChange={(e) => set("group_name", e.target.value)} />
        <datalist id="project-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
      <Field label="Scratch folder">
        <Input className="font-mono text-[12px]" value={form.scratch_path} readOnly />
      </Field>
      <div className="space-y-3 rounded-xl border border-red-500/30 p-4">
        <h3 className="text-[13px] font-semibold">Danger zone</h3>
        <div className="flex items-center gap-3">
          <div className="flex-1 text-[12px] text-faint">
            Takes the project off the board until it&apos;s unarchived in Settings. Its tasks, worktrees and branches are kept.
          </div>
          <Button className="shrink-0" onClick={onArchive}>
            <Archive size={13} /> Archive project
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 text-[12px] text-faint">Deletes the project, its tasks and their threads, and removes their worktrees.</div>
          <Button variant="danger" className="shrink-0" onClick={onDelete}>
            <Trash2 size={13} /> Delete project
          </Button>
        </div>
      </div>
    </>
  )
}
