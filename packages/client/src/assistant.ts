import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";
import type { Task } from "./tasks";

/** Each profile has an assistant (API 108): one long-lived thread in no project, keyed `A-<n>`, that works in a folder of its
 *  own and never goes to review or merge (see server-ts/src/agent/assistant.ts). The sidebar opens it; it's off the board. */
export const ASSISTANT_API = 108;

/** Whether the host has assistants. An older one shows no Assistant entry. */
export const hasAssistant = (h: Host | undefined) => hostSupports(h, ASSISTANT_API);

export const isAssistant = (t: Pick<Task, "kind" | "task_type">) => t.kind === "task" && t.task_type === "assistant";

export const assistantApi = ({ on }: Http) => ({
  /** The profile's assistant, which the host makes the first time it's asked for. */
  assistant: (h: string, profileId: string) => on(h).get<Task>(`/profiles/${enc(profileId)}/assistant`),
  /** Send the user's message to the profile's assistant (made first if it has none), as a message in its thread does. */
  sendToAssistant: (h: string, profileId: string, text: string) => on(h).post<Task>(`/profiles/${enc(profileId)}/assistant`, { text }),
});
