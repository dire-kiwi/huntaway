// Each profile's assistant (API 97): one long-lived thread in no project that the sidebar opens, full width, at
// `/assistant/<profile>` (see server/src/agent/assistant.rs). It's off the boards. Where it is: assistantHome in the client
// package, which follows the profile's assistant host (API 98).
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, assistantHome, isAssistant, type AssistantHome, type Task } from "./api";
import { useStore } from "./store";

/** The profile's assistant, made by its host the first time it's asked for: its id once it's in the store (live updates
 *  keep it there), and the error if it couldn't be had. */
export function useAssistant(name: string): { taskId?: string; error?: string; missing: boolean; home?: AssistantHome } {
  const home = useAssistantHome(name);
  const [hostId, profileId] = [home?.hostId, home?.profileId];
  const known = useStore((s) => Object.values(s.tasks).find((t) => isAssistant(t) && t.host_id === hostId && t.profile_id === profileId)?.id);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
    if (!hostId || !profileId) return;
    let live = true;
    api
      // assistantHome has already followed this board's assistant host setting: that host's own profile may name another.
      .assistant(hostId, profileId, { here: true })
      .then((t: Task) => live && useStore.getState().upsertTask({ ...t, host_id: hostId }))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [hostId, profileId]);
  return { taskId: known, error, missing: !home, home };
}

/** Where profile `name`'s assistant is (see assistantHome), kept as long as that doesn't change. */
export function useAssistantHome(name: string): AssistantHome | undefined {
  const [hostId, profileId, unavailable] = useStore(
    useShallow((s) => {
      const home = assistantHome(s.profiles, s.hosts, name);
      return [home?.hostId, home?.profileId, home?.unavailable];
    }),
  );
  return useMemo(() => (hostId ? { hostId, profileId, unavailable } : undefined), [hostId, profileId, unavailable]);
}

/** Why a profile's assistant can't be opened on its host, as a sentence. */
export function unavailableNote(profile: string, hostName: string, why: NonNullable<AssistantHome["unavailable"]>): string {
  switch (why) {
    case "offline":
      return `${profile}'s assistant runs on ${hostName}, which is offline. It's there again once the host reconnects.`;
    case "old":
      return `${profile}'s assistant runs on ${hostName}, which runs an older build that can't be an assistant host. Update it in Settings → Hosts.`;
    case "no_profile":
      return `${profile}'s assistant runs on ${hostName}, which has no ${profile} profile yet. Add one there in Settings → Profiles.`;
  }
}
