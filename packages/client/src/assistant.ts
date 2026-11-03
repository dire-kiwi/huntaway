import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { Task } from "./tasks";

/** Each profile has an assistant (API 97): one long-lived thread in no project, keyed `A-<n>`, that works in a folder of its
 *  own and never goes to review or merge (see server/src/agent/assistant.rs). The sidebar opens it; it's off the board. */
export const ASSISTANT_API = 97;

/** Its memory (API 98): USER.md, MEMORY.md and daily logs in its workspace, which the board loads into each of its runs and
 *  commits after each turn that changed them (see server/src/agent/assistant/memory.rs). The Memory tab edits them. */
export const MEMORY_API = 98;

/** Whether the host has assistants. An older one shows no Assistant entry. */
export const hasAssistant = (h: Host | undefined) => hostSupports(h, ASSISTANT_API);

/** Whether the host has the assistant's memory files and their API. */
export const hasMemory = (h: Host | undefined) => hostSupports(h, MEMORY_API);

export const isAssistant = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "assistant";

/** A file in the assistant's workspace. `kind`: USER.md, MEMORY.md, a daily log (`memory/YYYY-MM-DD.md`) or anything else. */
export interface MemoryFile {
  path: string;
  kind: "user" | "memory" | "log" | "other";
  size: number;
  /** Its length in characters, unless it's too big or isn't text. */
  chars: number | null;
  modified: string | null;
}

export interface MemoryOverview {
  task_id: string;
  /** The workspace, on its host. */
  dir: string;
  /** How many characters of USER.md, MEMORY.md and each loaded daily log a run is told. */
  cap: number;
  /** Today's log's path, in the host's time zone. */
  today: string;
  /** Whether the workspace has history (it's a git repository). */
  history: boolean;
  files: MemoryFile[];
  /** What to paste into another assistant for it to write out what it knows about you. */
  import_prompt: string;
}

export interface MemoryCommit {
  sha: string;
  /** "Assistant", or "You" for an edit from the Memory tab. */
  author: string;
  date: string;
  message: string;
  files: string[];
}

/** A file written: its content, and the commit that saved it (none if it didn't change). */
export interface MemoryWrite {
  path: string;
  content: string;
  commit: string | null;
}

const q = (o: Record<string, string | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");

export const assistantApi = ({ on }: Http) => {
  const memory = (profileId: string) => `/profiles/${enc(profileId)}/assistant/memory`;
  return {
    /** The profile's assistant, which the host makes the first time it's asked for. */
    assistant: (h: string, profileId: string) => on(h).get<Task>(`/profiles/${enc(profileId)}/assistant`),
    /** Send the user's message to the profile's assistant (made first if it has none), as a message in its thread does. */
    sendToAssistant: (h: string, profileId: string, text: string) => on(h).post<Task>(`/profiles/${enc(profileId)}/assistant`, { text }),
    /** Its workspace's files and how much of each a run is told. */
    memory: (h: string, profileId: string) => on(h).get<MemoryOverview>(memory(profileId)),
    /** A file, now or as it was in commit `rev`. */
    memoryFile: (h: string, profileId: string, path: string, rev?: string) =>
      on(h).get<{ path: string; content: string }>(`${memory(profileId)}/file?${q({ path, rev })}`),
    /** Write a file, committed as yours. `expected`: what the editor opened (null for a new file), so a save over what the
     *  assistant wrote meanwhile fails with a 409; `force` writes it anyway. */
    writeMemoryFile: (h: string, profileId: string, path: string, content: string, expected: string | null, force = false) =>
      on(h).post<MemoryWrite>(`${memory(profileId)}/file`, { path, content, expected, force }),
    /** The workspace's commits (or a file's), newest first. */
    memoryHistory: (h: string, profileId: string, path?: string) => on(h).get<{ commits: MemoryCommit[] }>(`${memory(profileId)}/history?${q({ path })}`),
    /** What a commit changed (in one file), as a patch. */
    memoryDiff: (h: string, profileId: string, rev: string, path?: string) => on(h).get<{ diff: string }>(`${memory(profileId)}/diff?${q({ rev, path })}`),
    /** Put a file back as it was in a commit. */
    restoreMemoryFile: (h: string, profileId: string, path: string, rev: string) => on(h).post<MemoryWrite>(`${memory(profileId)}/restore`, { path, rev }),
    /** Send another assistant's answer to the import prompt to the assistant, to fold into its memory. */
    importMemory: (h: string, profileId: string, text: string) => on(h).post<Task>(`${memory(profileId)}/import`, { text }),
  };
};
