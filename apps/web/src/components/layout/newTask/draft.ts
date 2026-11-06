import type { AttachmentRef, ExternalLink, Profile } from "../../../api";

// The "Start agent now" choice is remembered per project on this client.
export const startKey = (projectId: string) => `ia.startAgent.${projectId}`;
// Remembers the "Add another" toggle between dialogs.
export const ADD_ANOTHER_KEY = "ia.newTask.addAnother";
// The model and effort last picked for a new task in a project, on this client. Blank (the
// default) leaves it to the project, profile and host settings.
export const modelKey = (projectId: string) => `ia.newTask.model.${projectId}`;
export const effortKey = (projectId: string) => `ia.newTask.effort.${projectId}`;
// The Claude config last picked, when the project offers more than one.
export const configKey = (projectId: string) => `ia.newTask.claudeConfig.${projectId}`;
// The project last picked for a new task (or groupTarget, or scratchTarget).
export const PROJECT_KEY = "ia.newTask.project";
// What's been written for a new task and not yet created, so closing the dialog doesn't lose it.
// One per project, or per subproject for the dialog that adds to it.
export const draftKey = (projectId: string, subprojectId?: string) => `ia.newTask.draft.${subprojectId ?? projectId}`;
// Stands in for a project id in the keys above for a group's group tasks, and for a profile's scratch tasks.
export const groupTarget = (hostId: string, group: string) => `group:${hostId}:${group}`;
export const scratchTarget = (p: Profile) => `scratch:${p.host_id}:${p.id}`;

export interface Draft {
  description: string;
  /** Uploaded attachments, which are on the project's host. */
  files: AttachmentRef[];
  /** The Asana tasks picked for it, in the project's profile. */
  links?: ExternalLink[];
  /** Some of the tasks for its models were made, and these are the rest of the set (IA-227). */
  fanout?: PendingFanout | null;
}

/** A set of tasks from one prompt that only some of were made: what the rest are made with when it's tried again. */
export interface PendingFanout {
  /** The id they share; null on hosts before API 61. */
  id: string | null;
  /** The keys of those made. */
  made: string[];
  /** The efforts those made took, so a `^` only they take is still one. */
  efforts: string[];
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isPendingFanout = (f: unknown): f is PendingFanout => {
  const x = f as PendingFanout | null;
  return !!x && (x.id === null || typeof x.id === "string") && strings(x.made) && strings(x.efforts);
};

const isLink = (l: unknown): l is ExternalLink => {
  const x = l as ExternalLink | null;
  return !!x && x.provider === "asana" && typeof x.id === "string" && typeof x.url === "string" && typeof x.title === "string";
};

export function loadDraft(key: string): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!d || typeof d.description !== "string") return null;
    return {
      description: d.description,
      files: Array.isArray(d.files) ? d.files : [],
      links: Array.isArray(d.links) ? d.links.filter(isLink) : [],
      fanout: isPendingFanout(d.fanout) ? d.fanout : null,
    };
  } catch {
    return null;
  }
}
