import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { Profile } from "./profiles";
import type { Task } from "./tasks";

/** Each profile has an assistant (API 97): one long-lived thread in no project, keyed `A-<n>`, that works in a folder of its
 *  own and never goes to review or merge (see server/src/agent/assistant.rs). The sidebar opens it; it's off the board. */
export const ASSISTANT_API = 97;

/** Its memory (API 99): USER.md, MEMORY.md and daily logs in its workspace, which the board loads into each of its runs and
 *  commits after each turn that changed them (see server/src/agent/assistant/memory.rs). The Memory tab edits them. */
export const MEMORY_API = 99;

/** Whether the host has assistants. An older one shows no Assistant entry. */
export const hasAssistant = (h: Host | undefined) => hostSupports(h, ASSISTANT_API);

/** Whether the host has the assistant's memory files and their API. */
export const hasMemory = (h: Host | undefined) => hostSupports(h, MEMORY_API);

export const isAssistant = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "assistant";

/** A routine's run of the assistant (API 101): a thread under it (`parent_id`), off the board, keyed `A-<n>` too. */
export const isRoutine = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "routine";

/** The assistant or one of its routine threads: off the board. */
export const isAssistants = (t: Pick<Task, "kind" | "task_type">) => isAssistant(t) || isRoutine(t);

/** A profile can have its assistant run on a linked host of its own (`Profile.assistant_host`), and a linked host's agents can
 *  use the board's tools up the link when Settings → Hosts lets them (`Host.uplink`), from API 98 on both. */
export const ASSISTANT_HOST_API = 98;

/** Where a profile's assistant is. `profileId` is its profile on that host, missing when it can't be opened there: the host
 *  is `offline`, `old` (from before assistant hosts), or has `no_profile` of that name. */
export interface AssistantHome {
  hostId: string;
  profileId?: string;
  unavailable?: "offline" | "old" | "no_profile";
}

/** Where profile `name`'s assistant is: the one place a board looks for it. Profiles are merged across hosts by name. The board's
 *  own host's profile can name an assistant host, which it's on then, whatever state that host is in; otherwise it's on the
 *  board's own host, else the first connected host with assistants that has the profile. None when no host has one. */
export function assistantHome(profiles: Profile[], hosts: Host[], name: string): AssistantHome | undefined {
  const local = hosts.find((h) => h.local);
  const picked = profiles.find((p) => p.name === name && p.host_id === local?.id)?.assistant_host;
  if (picked && picked !== local?.id) {
    const host = hosts.find((h) => h.id === picked);
    if (!host?.connected) return { hostId: picked, unavailable: "offline" };
    if (!hostSupports(host, ASSISTANT_HOST_API)) return { hostId: picked, unavailable: "old" };
    const there = profiles.find((p) => p.name === name && p.host_id === picked);
    return there ? { hostId: picked, profileId: there.id } : { hostId: picked, unavailable: "no_profile" };
  }
  const homes = profiles
    .filter((p) => p.name === name)
    .map((p) => ({ profile: p, host: hosts.find((h) => h.id === p.host_id) }))
    .filter(({ host }) => !!host?.connected && hasAssistant(host));
  const home = homes.find(({ host }) => host!.local) ?? homes[0];
  return home && { hostId: home.profile.host_id, profileId: home.profile.id };
}

/** `here`: the assistant on host `h` itself, as assistantHome found it, rather than wherever that host's profile sends it
 *  (`?local=1`, API 98; older hosts ignore it). Without it a host whose profile names another assistant host sends it on. */
export interface AssistantOn {
  here?: boolean;
}

const assistantPath = (profileId: string, opts?: AssistantOn) => `/profiles/${enc(profileId)}/assistant${opts?.here ? "?local=1" : ""}`;

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
    /** The profile's assistant, which the host makes the first time it's asked for. From API 98 it has `host_id`: a hub sends this to
     *  the profile's assistant host, if it has one, so the task is there (go on to it through `on(host_id)`). */
    assistant: (h: string, profileId: string, opts?: AssistantOn) => on(h).get<Task>(assistantPath(profileId, opts)),
    /** Send the user's message to the profile's assistant (made first if it has none), as a message in its thread does. */
    sendToAssistant: (h: string, profileId: string, text: string, opts?: AssistantOn) => on(h).post<Task>(assistantPath(profileId, opts), { text }),
    /** The rest are the assistant's memory (API 99), on the host it's on (its task's `host_id` and `profile_id`). */
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
