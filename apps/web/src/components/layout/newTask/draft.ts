import { parseJson } from "../../ui/json"
import { type AttachmentRef, type HostProfile as Profile } from "@huntaway/client"
import { Effort, type ExternalLink } from "@huntaway/contracts"
import { Schema } from "effect"
import { codeRanges } from "../taskTokens"

// The "Start agent now" choice is remembered per project on this client.
export const startKey = (projectId: string) => `ia.startAgent.${projectId}`
// Remembers the "Add another" toggle between dialogs.
export const ADD_ANOTHER_KEY = "ia.newTask.addAnother"
// The model and effort last picked for a new task in a project, on this client. Blank (the
// default) leaves it to the project, profile and host settings.
export const modelKey = (projectId: string) => `ia.newTask.model.${projectId}`
export const effortKey = (projectId: string) => `ia.newTask.effort.${projectId}`

const isEffort = Schema.is(Effort)

/** An effort as kept or typed: one of the efforts, or "" (the default) for anything else. */
export const asEffort = (v: string | null | undefined): Effort | "" => (v && isEffort(v) ? v : "")
// The Claude config last picked, when the project offers more than one.
export const configKey = (projectId: string) => `ia.newTask.claudeConfig.${projectId}`
// The project last picked for a new task (or groupTarget, or scratchTarget).
export const PROJECT_KEY = "ia.newTask.project"
// What's been written for a new task and not yet created, so closing the dialog doesn't lose it.
// One per project (or group, or no project).
export const draftKey = (projectId: string) => `ia.newTask.draft.${projectId}`
// Stands in for a project id in the keys above for a group's group tasks, and for a profile's scratch tasks.
export const groupTarget = (hostId: string, group: string) => `group:${hostId}:${group}`
export const scratchTarget = (p: Profile) => `scratch:${p.host_id}:${p.id}`

export interface Draft {
  description: string
  /** Uploaded attachments, which are on the project's host. */
  files: AttachmentRef[]
  /** The Asana tasks picked for it, in the project's profile. */
  links?: ExternalLink[] | undefined
  /** Some of the tasks for its models were made, and these are the rest of the set (IA-227). */
  fanout?: PendingFanout | null | undefined
  /** 2 since HA-303, which moved where it goes from `@IA` to `in:IA`. */
  v?: 2 | undefined
}

/** A draft's text from before HA-303 with its `@` tokens (where it goes) as `in:` ones, outside code. */
export function upgradeDescription(text: string): string {
  const code = codeRanges(text)
  return text.replace(/(?<=^|\s)@(?=[\w.-]*\w(?![\w/@#^[-]))/g, (m, at: number) => (code.some(([s, e]) => at >= s && at < e) ? m : "in:"))
}

/** A set of tasks from one prompt that only some of were made: what the rest are made with when it's tried again. */
export interface PendingFanout {
  /** The id they share; null on hosts before API 61. */
  id: string | null
  /** The keys of those made. */
  made: string[]
  /** The efforts those made took, so a `^` only they take is still one. */
  efforts: string[]
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isPendingFanout = (x: unknown): x is PendingFanout =>
  isRecord(x) && (x["id"] === null || typeof x["id"] === "string") && strings(x["made"]) && strings(x["efforts"])

const isLink = (x: unknown): x is ExternalLink =>
  isRecord(x) && x["provider"] === "asana" && typeof x["id"] === "string" && typeof x["url"] === "string" && typeof x["title"] === "string"

const isAttachmentRef = (x: unknown): x is AttachmentRef =>
  isRecord(x) && typeof x["id"] === "string" && typeof x["name"] === "string" && typeof x["path"] === "string"

export function loadDraft(key: string): Draft | null {
  try {
    const d = parseJson(localStorage.getItem(key) ?? "null")
    if (!isRecord(d)) return null
    const description = d["description"]
    if (typeof description !== "string") return null
    const files: unknown = d["files"]
    const links: unknown = d["links"]
    return {
      description: d["v"] === 2 ? description : upgradeDescription(description),
      files: Array.isArray(files) ? files.filter(isAttachmentRef) : [],
      links: Array.isArray(links) ? links.filter(isLink) : [],
      fanout: isPendingFanout(d["fanout"]) ? d["fanout"] : null,
    }
  } catch {
    return null
  }
}
