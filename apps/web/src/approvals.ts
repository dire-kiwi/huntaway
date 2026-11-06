import type { Approval } from "./api";

/** A project change or task deletion waiting for the user's approval, on host `host_id`. */
export type HostApproval = Approval & { host_id: string };

export const sortApprovals = (list: HostApproval[]) => list.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

/** `list` with approval `a` as it is now: in it while it's pending, else out of it. */
export const withApproval = (list: HostApproval[], a: HostApproval) => {
  const others = list.filter((x) => !(x.host_id === a.host_id && x.request_id === a.request_id));
  return a.status === "pending" ? sortApprovals([...others, a]) : others;
};

/**
 * Keeps a host's list of approvals, which can take a while to load, from undoing the changes
 * that arrive (as events) while it loads, dropping a new request or bringing back one that was
 * just answered, and from undoing a newer list.
 */
export function approvalLoads() {
  // Per host, the changes seen during each load still going, by request id.
  const loading = new Map<string, Set<Map<string, HostApproval>>>();
  // Per host, how many loads have started: only the latest one's list counts.
  const started = new Map<string, number>();
  return {
    /** Approval `a` changed. */
    changed(a: HostApproval) {
      loading.get(a.host_id)?.forEach((seen) => seen.set(a.request_id, a));
    },
    /**
     * Starts loading host `h`'s list. `merge` gives it with what changed since, or null if a
     * later load started meanwhile (its list is newer); `done` ends it.
     */
    start(h: string) {
      const seen = new Map<string, HostApproval>();
      const loads = loading.get(h) ?? new Set();
      loading.set(h, loads.add(seen));
      const n = (started.get(h) ?? 0) + 1;
      started.set(h, n);
      return {
        merge: (list: HostApproval[]) => (started.get(h) === n ? [...seen.values()].reduce(withApproval, sortApprovals([...list])) : null),
        done: () => loads.delete(seen),
      };
    },
  };
}
