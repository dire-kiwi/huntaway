// Each profile's assistant (API 107): one long-lived thread in no project that the sidebar opens, full width, at
// `/assistant/<profile>` (see server-ts/src/agent/assistant.ts). It's off the boards.
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, hasAssistant, isAssistant, type Host, type Profile, type Task } from "./api";
import { useStore } from "./store";

/** Where a profile's assistant is: the one place the board looks for it. Profiles are merged across hosts by name, so
 *  it's this board's own host's profile of that name, else the first connected host with assistants that has one. Hosts
 *  before API 107 have none. */
export function assistantHome(profiles: Profile[], hosts: Host[], name: string): { hostId: string; profileId: string } | undefined {
  const homes = profiles
    .filter((p) => p.name === name)
    .map((p) => ({ profile: p, host: hosts.find((h) => h.id === p.host_id) }))
    .filter(({ host }) => !!host?.connected && hasAssistant(host));
  const home = homes.find(({ host }) => host!.local) ?? homes[0];
  return home && { hostId: home.profile.host_id, profileId: home.profile.id };
}

/** The profile's assistant, made by its host the first time it's asked for: its id once it's in the store (live updates
 *  keep it there), and the error if it couldn't be had. */
export function useAssistant(name: string): { taskId?: string; error?: string; missing: boolean } {
  const [hostId, profileId] = useStore(useShallow((s) => {
    const home = assistantHome(s.profiles, s.hosts, name);
    return [home?.hostId, home?.profileId];
  }));
  const known = useStore((s) => Object.values(s.tasks).find((t) => isAssistant(t) && t.host_id === hostId && t.profile_id === profileId)?.id);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
    if (!hostId || !profileId) return;
    let live = true;
    api
      .assistant(hostId, profileId)
      .then((t: Task) => live && useStore.getState().upsertTask({ ...t, host_id: hostId }))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [hostId, profileId]);
  return { taskId: known, error, missing: !hostId };
}
