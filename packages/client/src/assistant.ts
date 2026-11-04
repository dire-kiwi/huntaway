import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { Automation, Weekday } from "./automations";
import type { Profile } from "./profiles";
import type { Task } from "./tasks";

/** Each profile has an assistant (API 107): one long-lived thread in no project, keyed `A-<n>`, that works in a folder of its
 *  own and never goes to review or merge (see server/src/agent/assistant.rs). The sidebar opens it; it's off the board. */
export const ASSISTANT_API = 107;

/** Its memory (API 109): USER.md, MEMORY.md and daily logs in its workspace, which the board loads into each of its runs and
 *  commits after each turn that changed them (see server/src/agent/assistant/memory.rs). The Memory tab edits them. */
export const MEMORY_API = 109;

/** Google and the morning brief (API 115): the Google card (whether the assistant's Google Workspace server is connected), the
 *  morning brief routine template, the assistant's `brief` document (one version a day) and ratings of its items, which go into
 *  MEMORY.md (see server/src/agent/assistant/google.rs and brief.rs). */
export const BRIEF_API = 115;

/** Whether the host has the Google card, the brief template and the Brief tab. */
export const hasBrief = (h: Host | undefined) => hostSupports(h, BRIEF_API);

/** A file the Google server reads, on the assistant's host. */
export interface GoogleFile {
  path: string;
  exists: boolean;
  /** Readable by its owner alone. */
  private: boolean;
}

/** An account with credentials in the Google server's folder. */
export interface GoogleAccount {
  email: string;
  file: string;
  refresh_token: boolean;
  private: boolean;
  scopes: string[];
  /** What the brief reads that it wasn't granted. */
  missing_scopes: string[];
}

/** Whether Google is connected for the assistant, on its host, and what's missing if it isn't. */
export interface GoogleStatus {
  connected: boolean;
  /** The account it acts as, once connected. */
  account: string | null;
  /** What's in the way, in words. */
  problem: string | null;
  warnings: string[];
  /** The host's global MCP server called `google`, if it has one: `on` when the profile switches it on. */
  server: { id: string; enabled: boolean; on: boolean; command: string; command_found: boolean } | null;
  client_secret: GoogleFile;
  credentials_dir: string;
  accounts: GoogleAccount[];
  /** What to run on the host to sign in. */
  consent_command: string;
  /** The host's name and the port the sign-in listens on, for the ssh command. */
  host: string;
  consent_port: number;
  /** With `check`: whether Google took the refresh token, and why not. */
  verified?: boolean;
  verify_error?: string;
}

/** How the user rated one of the brief's items: `clear` takes a rating back. */
export type BriefRating = "up" | "down" | "clear";

/** An item of the brief, as the page marks it (`data-brief-kind`, `data-brief-topic`) and its text. */
export interface BriefItem {
  kind?: string;
  topic?: string;
  text?: string;
}

/** Whether the host has assistants. An older one shows no Assistant entry. */
export const hasAssistant = (h: Host | undefined) => hostSupports(h, ASSISTANT_API);

/** Whether the host has the assistant's memory files and their API. */
export const hasMemory = (h: Host | undefined) => hostSupports(h, MEMORY_API);

export const isAssistant = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "assistant";

/** A routine's run of the assistant (API 111): a thread under it (`parent_id`), off the board, keyed `A-<n>` too. */
export const isRoutine = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "routine";

/** The assistant or one of its routine threads: off the board. */
export const isAssistants = (t: Pick<Task, "kind" | "task_type">) => isAssistant(t) || isRoutine(t);

/** A profile can have its assistant run on a linked host of its own (`Profile.assistant_host`), and a linked host's agents can
 *  use the board's tools up the link when Settings → Hosts lets them (`Host.uplink`), from API 108 on both. */
export const ASSISTANT_HOST_API = 108;

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
 *  (`?local=1`, API 108; older hosts ignore it). Without it a host whose profile names another assistant host sends it on. */
export interface AssistantOn {
  here?: boolean;
}

const assistantPath = (profileId: string, opts?: AssistantOn) => `/profiles/${enc(profileId)}/assistant${opts?.here ? "?local=1" : ""}`;

/** A file in the assistant's workspace. `kind`: USER.md, MEMORY.md, a daily log (`memory/YYYY-MM-DD.md`) or anything else. */
export interface MemoryFile {
  path: string;
  kind: "user" | "memory" | "log" | "other";
  size: number;
  /** Its length in characters, for the files a run is told (USER.md, MEMORY.md, today's and yesterday's logs), unless
   *  it's too big or isn't text. Null for the rest (from hosts before HA-160, it's there too). */
  chars: number | null;
  modified: string | null;
}

export interface MemoryOverview {
  task_id: string;
  /** The workspace, on its host. */
  dir: string;
  /** How many characters of USER.md, MEMORY.md and each loaded daily log a run is told. */
  cap: number;
  /** And how many bytes (from HA-160; older hosts don't say). */
  cap_bytes?: number;
  /** Today's log's path, in the host's time zone. */
  today: string;
  /** Whether the workspace has history (a git repository of the board's, next to it). */
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
    /** The profile's assistant, which the host makes the first time it's asked for. From API 108 it has `host_id`: a hub sends this to
     *  the profile's assistant host, if it has one, so the task is there (go on to it through `on(host_id)`). */
    assistant: (h: string, profileId: string, opts?: AssistantOn) => on(h).get<Task>(assistantPath(profileId, opts)),
    /** Send the user's message to the profile's assistant (made first if it has none), as a message in its thread does. */
    sendToAssistant: (h: string, profileId: string, text: string, opts?: AssistantOn) => on(h).post<Task>(assistantPath(profileId, opts), { text }),
    /** The rest are the assistant's memory (API 109), on the host it's on (its task's `host_id` and `profile_id`). */
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
    /** Google and the brief (API 115), on the assistant's host too. */
    /** Whether Google is connected; `check` also tries the refresh token with Google. */
    googleStatus: (h: string, profileId: string, check = false) =>
      on(h).get<GoogleStatus>(`/profiles/${enc(profileId)}/assistant/google${check ? "?check=1" : ""}`),
    /** Add the host's Google server (unless it has one) and switch it on for the profile. */
    setupGoogle: (h: string, profileId: string) => on(h).post<GoogleStatus>(`/profiles/${enc(profileId)}/assistant/google`, {}),
    /** Add the morning brief routine, on `weekdays` at `time` (the host's time zone; weekdays at 7:30 without them). */
    addBrief: (h: string, profileId: string, b: { time?: string; weekdays?: Weekday[] }) => on(h).post<Automation>(`/profiles/${enc(profileId)}/assistant/brief`, b),
    /** Rate one of the brief's items: it becomes (or changes, or drops) a line in MEMORY.md. */
    rateBrief: (h: string, profileId: string, rating: BriefRating, item: BriefItem) =>
      on(h).post<{ line: string | null; content: string; commit: string | null }>(`/profiles/${enc(profileId)}/assistant/brief/feedback`, { rating, ...item }),
  };
};
