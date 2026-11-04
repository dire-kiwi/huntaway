// Takes what another app shared into Huntaway (expo-share-intent's provider, at the root) and sends it to an assistant:
// straight to the Assistant tab with one board that can take it, or to the share screen to pick one.
import { usePathname, useRootNavigationState, useRouter } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useEffect, useRef } from "react";
import { boards, statusOf, useBoardStatuses } from "./session";
import { sharedDraft, shares, shareTargets } from "./share";

export function ShareHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const statuses = useBoardStatuses();
  const router = useRouter();
  // Not before the navigator's up: a share can be what opened the app.
  const ready = !!useRootNavigationState()?.key;
  const path = useRef("");
  path.current = usePathname();
  useEffect(() => {
    if (!hasShareIntent || !ready) return;
    const draft = sharedDraft(shareIntent);
    // Taken: the provider forgets it (the files it copied stay until the app's cache is cleared).
    resetShareIntent();
    if (!draft) return;
    const pending = shares.put(draft);
    const { only } = shareTargets(boards.get().boards, (id) => statusOf(statuses, id), boards.get().lastShared);
    if (only) {
      void boards.select(only.id);
      shares.target(only.id);
      router.navigate("/");
    }
    // A share screen already open shows the new share in place of the last (one share waits at a time): not another on top.
    else if (path.current === "/share") router.setParams({ id: String(pending.id) });
    else router.push({ pathname: "/share", params: { id: String(pending.id) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent, ready]);
  useEffect(() => {
    if (error) console.warn(`expo-share-intent: ${error}`);
  }, [error]);
  return null;
}
