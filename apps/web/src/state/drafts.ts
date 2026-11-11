import { Schema } from "effect"
import { Atom } from "effect/reactivity"
import { ExternalLink } from "@huntaway/contracts"
import { stored, storedBare } from "./storage"

// User work that must not be lost, and the new task dialog's remembered choices (inventory 10, section 3.3), under the
// old keys. The new task dialog (layout/newTask) is the M1 component that keeps a draft; the composer's, line
// comments' and plan answers' drafts come with their components (M2 on).

/** A file attached to a draft: enough to fetch it again. */
const AttachmentRef = Schema.Struct({ id: Schema.String, name: Schema.String, path: Schema.String })

/** A set of tasks from one prompt of which only some were made: what the rest are made with when it is tried again. */
const PendingFanout = Schema.Struct({ id: Schema.NullOr(Schema.String), made: Schema.Array(Schema.String), efforts: Schema.Array(Schema.String) })

/**
 * What has been written for a new task and not created yet (`ia.newTask.draft.<project, group or scratch target>`).
 * `v: 2` since `in:` replaced `@` for where it goes; an older draft's text is upgraded by the dialog.
 */
export const NewTaskDraft = Schema.Struct({
  v: Schema.optional(Schema.Literal(2)),
  description: Schema.String,
  files: Schema.Array(AttachmentRef),
  links: Schema.optional(Schema.Array(ExternalLink)),
  fanout: Schema.optional(Schema.NullOr(PendingFanout)),
})
export type NewTaskDraft = typeof NewTaskDraft.Type

export const newTaskDraftAtom = Atom.family((target: string) => stored(`ia.newTask.draft.${target}`, Schema.NullOr(NewTaskDraft), null))

/** The project (or group or scratch target) last picked for a new task (`ia.newTask.project`). */
export const newTaskProjectAtom = storedBare("ia.newTask.project", Schema.String, null)

/** The "Add another" toggle between dialogs (`ia.newTask.addAnother`). */
export const addAnotherAtom = storedBare("ia.newTask.addAnother", Schema.Literals(["0", "1"]), "0")

/** "Start agent now", per project (`ia.startAgent.<project>`). */
export const startAgentAtom = Atom.family((project: string) => storedBare(`ia.startAgent.${project}`, Schema.Literals(["0", "1"]), "0"))

/** The model, effort and agent config last picked for a new task in a project; null leaves it to the project. */
export const newTaskModelAtom = Atom.family((project: string) => storedBare(`ia.newTask.model.${project}`, Schema.String, null))
export const newTaskEffortAtom = Atom.family((project: string) => storedBare(`ia.newTask.effort.${project}`, Schema.String, null))
export const newTaskConfigAtom = Atom.family((project: string) => storedBare(`ia.newTask.claudeConfig.${project}`, Schema.String, null))
