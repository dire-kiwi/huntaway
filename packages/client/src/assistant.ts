import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { Profile } from "./profiles";
import type { Task } from "./tasks";

/** Each profile has an assistant (API 97): one long-lived thread in no project, keyed `A-<n>`, that works in a folder of its
 *  own and never goes to review or merge (see server/src/agent/assistant.rs). The sidebar opens it; it's off the board. */
export const ASSISTANT_API = 97;

/** Whether the host has assistants. An older one shows no Assistant entry. */
export const hasAssistant = (h: Host | undefined) => hostSupports(h, ASSISTANT_API);

export const isAssistant = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "assistant";

/** A routine's run of the assistant (API 99): a thread under it (`parent_id`), off the board, keyed `A-<n>` too. */
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

export const assistantApi = ({ on }: Http) => ({
  /** The profile's assistant, which the host makes the first time it's asked for. From API 98 it has `host_id`: a hub sends this to
   *  the profile's assistant host, if it has one, so the task is there (go on to it through `on(host_id)`). */
  assistant: (h: string, profileId: string, opts?: AssistantOn) => on(h).get<Task>(assistantPath(profileId, opts)),
  /** Send the user's message to the profile's assistant (made first if it has none), as a message in its thread does. */
  sendToAssistant: (h: string, profileId: string, text: string, opts?: AssistantOn) => on(h).post<Task>(assistantPath(profileId, opts), { text }),
});
