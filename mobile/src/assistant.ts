// The Assistant tab: the selected board's assistant for its picked profile, one long-lived thread outside every project
// (server/src/agent/assistant.rs). Where it is comes from the client's assistantHome, as on the web board: a profile can
// have it on an assistant host of its own (API 98), which may be offline. Paired devices reach it from API 105.
import { assistantHome, type AssistantHome, type Client, type Profile, type Task } from "@huntaway/client";
import type { Board } from "./boards";
import type { BoardProfiles } from "./boardData";

/** The board API from which a paired device may open the assistant (its routes joined the devices' allowlist). */
export const ASSISTANT_TAB_API = 105;

/** Whether the app shows the Assistant tab for a board: on an older one a device can't reach it. */
export const hasAssistantTab = (board: Pick<Board, "apiVersion"> | undefined) => !!board && board.apiVersion >= ASSISTANT_TAB_API;

/** Whether the Assistant tab shows for a board: paired, new enough for the app, and new enough for the tab. */
export const showsAssistant = (board: Pick<Board, "apiVersion"> | undefined, status: { unauthorized: boolean; tooOld: boolean }) =>
  hasAssistantTab(board) && !status.unauthorized && !status.tooOld;

/** Where profile `name`'s assistant is on a board, from its loaded profiles; none when no host there has it. */
export function homeOf(profiles: BoardProfiles, name: string): AssistantHome | undefined {
  const all: Profile[] = [...profiles.byName.values()].flat().map((e) => ({ ...e.profile, host_id: e.hostId }));
  return assistantHome(all, profiles.allHosts, name);
}

/** The assistant the tab has open, and whose it is. */
export interface Opened {
  profile: string;
  home: AssistantHome;
}

/**
 * The assistant to keep open: where `profile`'s is now, if it can be opened there; else, while its host is only
 * unreachable for now (offline, say), the one already open, so its thread and the composer's draft stay. Another
 * profile, or another host, starts again.
 */
export function stillOpen(prev: Opened | undefined, profile: string | null, home: AssistantHome | undefined): Opened | undefined {
  if (!profile || !home) return undefined;
  if (home.profileId) return prev?.profile === profile && prev.home.hostId === home.hostId && prev.home.profileId === home.profileId ? prev : { profile, home };
  return prev?.profile === profile && prev.home.hostId === home.hostId ? prev : undefined;
}

/** The assistant's task, made by its host the first time it's asked for, with the host it's on. */
export async function openAssistant(client: Pick<Client, "assistant">, home: AssistantHome): Promise<Task> {
  if (!home.profileId) throw new Error("The assistant can't be opened there");
  // assistantHome has already followed the board's assistant host setting, so this asks that host for its own.
  const task = await client.assistant(home.hostId, home.profileId, { here: true });
  return { ...task, host_id: home.hostId };
}

/** Why a profile's assistant can't be opened on its host, as a sentence. */
export function unavailableNote(profile: string, hostName: string, why: NonNullable<AssistantHome["unavailable"]>): string {
  switch (why) {
    case "offline":
      return `${profile}'s assistant runs on ${hostName}, which is offline. It's back here once that host reconnects.`;
    case "old":
      return `${profile}'s assistant runs on ${hostName}, which runs an older build that can't be an assistant host. Update it from the web board.`;
    case "no_profile":
      return `${profile}'s assistant runs on ${hostName}, which has no ${profile} profile yet. Add one there from the web board.`;
  }
}
