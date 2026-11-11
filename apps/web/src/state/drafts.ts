import { Option, Schema } from "effect"
import { Atom } from "effect/reactivity"
import type { ComposerDraft } from "@huntaway/client"
import { ExternalLink } from "@huntaway/contracts"
import { stored, storedBare } from "./storage"

// User work that must not be lost, and the new task dialog's remembered choices (inventory 10, section 3.3), under the
// old keys. The new task dialog (layout/newTask) and the task's composer keep drafts here; line comments' and plan
// answers' drafts come with their components (M4, M6).

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

const ComposerDraftJson = Schema.fromJsonString(Schema.Struct({ text: Schema.String, files: Schema.optional(Schema.Array(AttachmentRef)) }))
const decodeComposerDraft = Schema.decodeUnknownOption(ComposerDraftJson)
const encodeComposerDraft = Schema.encodeOption(ComposerDraftJson)

/** The key a task's composer draft is kept under (`ia.composer.draft.<host>:<task>`), as the old composer kept it. */
export const composerDraftKey = (task: { readonly host_id: string; readonly id: string }): string => `ia.composer.draft.${task.host_id}:${task.id}`

/**
 * Whether the browser could not keep a composer's draft (its storage full or turned off): the composer warns that it is
 * only kept until the page closes.
 */
export const composerUnsavedAtom = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive))

function loadComposerDraft(key: string): ComposerDraft | null {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(key)
  } catch {
    return null
  }
  return Option.match(decodeComposerDraft(raw), { onNone: () => null, onSome: (d) => ({ text: d.text, files: d.files ?? [] }) })
}

/** Keeps a composer's draft in the browser's storage (none removes it): false when the browser could not. */
function saveComposerDraft(key: string, draft: ComposerDraft | null): boolean {
  try {
    if (draft === null) window.localStorage.removeItem(key)
    else
      window.localStorage.setItem(
        key,
        Option.getOrElse(encodeComposerDraft({ text: draft.text, files: draft.files }), () => ""),
      )
    return true
  } catch {
    return false
  }
}

/**
 * What has been written to a task's agent and not sent (under `composerDraftKey`), so another tab or task, or a reload,
 * does not lose it. Kept for the page's life, so a draft the browser could not keep is still here when its composer
 * opens again; a send takes what it sent off it (`sendMessage` in @huntaway/client). An empty one is not stored.
 */
export const composerDraftAtom = Atom.family((key: string) =>
  Atom.writable(
    () => loadComposerDraft(key),
    (ctx, value: ComposerDraft | null) => {
      const empty = value === null || (value.text.trim() === "" && value.files.length === 0)
      ctx.set(composerUnsavedAtom(key), !saveComposerDraft(key, empty ? null : value))
      ctx.setSelf(value)
    },
  ).pipe(Atom.keepAlive),
)

const Side = Schema.Literals(["old", "new"])

/** The lines a comment on a diff is on (changes/lineComments.ts says what each field is). */
const CommentLines = {
  where: Schema.String,
  source: Schema.String,
  path: Schema.String,
  side: Side,
  start: Schema.Finite,
  end: Schema.Finite,
  at: Schema.Struct({ side: Side, line: Schema.Finite }),
  lines: Schema.Array(Schema.String),
}

export const LineComment = Schema.Struct({ ...CommentLines, id: Schema.String, note: Schema.String })
export type LineComment = typeof LineComment.Type
export const CommentDraft = Schema.Struct({ ...CommentLines, id: Schema.String, of: Schema.optional(Schema.String), note: Schema.String })
export type CommentDraft = typeof CommentDraft.Type

/** A task's comments on its diff for its agent, and the ones still being written. */
export const LineReview = Schema.Struct({ comments: Schema.Array(LineComment), drafts: Schema.Array(CommentDraft) })
export type LineReview = typeof LineReview.Type

const EMPTY_REVIEW: LineReview = { comments: [], drafts: [] }
const LineReviewJson = Schema.fromJsonString(LineReview)
const decodeReview = Schema.decodeUnknownOption(LineReviewJson)
const encodeReview = Schema.encodeOption(LineReviewJson)

/** The key a task's line comments are kept under (`ia.review.<host>:<task>`), as the old Changes tab kept them. */
export const lineReviewKey = (hostId: string, taskId: string): string => `ia.review.${hostId}:${taskId}`

/** Whether the browser could not keep a task's line comments: they are only kept until the page closes. */
export const lineReviewUnsavedAtom = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive))

/**
 * A task's line comments (the Changes tab's, HA-10) and the ones being written, under `lineReviewKey`, so another tab or
 * task, or a reload, does not lose them; kept for the page's life, so ones the browser could not keep are still here.
 * Another tab's changes are read again as the browser says the key changed. An empty review is not stored.
 */
export const lineReviewAtom = Atom.family((key: string) =>
  Atom.writable(
    () => {
      let raw: string | null = null
      try {
        raw = window.localStorage.getItem(key)
      } catch {
        return EMPTY_REVIEW
      }
      return Option.getOrElse(decodeReview(raw), () => EMPTY_REVIEW)
    },
    (ctx, value: LineReview) => {
      let kept = true
      try {
        if (value.comments.length === 0 && value.drafts.length === 0) window.localStorage.removeItem(key)
        else
          window.localStorage.setItem(
            key,
            Option.getOrElse(encodeReview(value), () => ""),
          )
      } catch {
        kept = false
      }
      ctx.set(lineReviewUnsavedAtom(key), !kept)
      ctx.setSelf(value)
    },
  ).pipe(Atom.keepAlive),
)
