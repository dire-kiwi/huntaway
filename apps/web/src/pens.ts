// Pens (HA-285, API 126): a profile's named sets of tasks, which its board shows as tabs. Each host keeps its own, and a
// profile's board spans hosts, so its tabs are the pens merged by name: a tab is every host's pen of that name, and a
// task is in it if it's in its host's one. Hiding, renaming, moving or deleting a tab does it to each of them.
import { api, hasPens, type Pen, type Task } from "./api";
import { useStore } from "./store";

/** A pen as the store has it: with the host it's on. */
export type HostPen = Pen & { host_id: string };

/** A profile board's tab: its pens of one name (in any case) on each host. */
export interface PenTab {
  /** Its name in lower case, which names it on every host. */
  key: string;
  name: string;
  pens: HostPen[];
  /** Hidden from the tabs: every one of its pens is. */
  hidden: boolean;
}

export const penKey = (name: string) => name.trim().toLowerCase();

/**
 * The tabs of a profile's pens (`profiles`: the profile on each host, as `<host>:<profile id>`), in their order: by the
 * place of each among its host's pens, the board's own host's first.
 */
export function penTabs(pens: HostPen[], profiles: Set<string>, localHostId: string | null): PenTab[] {
  const tabs = new Map<string, PenTab & { order: number[] }>();
  // Each pen's place among its host's, from 0.
  const place = new Map<HostPen, number>();
  const byHost = new Map<string, HostPen[]>();
  for (const p of pens) {
    if (!profiles.has(`${p.host_id}:${p.profile_id}`)) continue;
    byHost.set(p.host_id, [...(byHost.get(p.host_id) ?? []), p]);
  }
  for (const list of byHost.values()) [...list].sort((a, b) => a.position - b.position).forEach((p, i) => place.set(p, i));
  const hosts = [...byHost.keys()].sort((a, b) => Number(b === localHostId) - Number(a === localHostId));
  for (const h of hosts) {
    for (const p of byHost.get(h)!) {
      const key = penKey(p.name);
      const tab = tabs.get(key) ?? { key, name: p.name, pens: [], hidden: true, order: [] };
      tab.pens.push(p);
      tab.hidden &&= p.hidden;
      tab.order.push(place.get(p)!);
      tabs.set(key, tab);
    }
  }
  // A tie between hosts goes the board's own host's way.
  const local = (t: PenTab) => Number(!t.pens.some((p) => p.host_id === localHostId));
  return [...tabs.values()]
    .sort((a, b) => Math.min(...a.order) - Math.min(...b.order) || local(a) - local(b) || a.key.localeCompare(b.key))
    .map((t): PenTab => ({ key: t.key, name: t.name, pens: t.pens, hidden: t.hidden }));
}

/** Whether a task is in the tab's pens. */
export const inTab = (tab: PenTab, t: Task) => !!t.pen_id && tab.pens.some((p) => p.host_id === t.host_id && p.id === t.pen_id);

/** The tab a task's pen is in, if it's in one. */
export const tabOf = (tabs: PenTab[], t: Task) => tabs.find((tab) => inTab(tab, t));

/** Whether a task can go in a pen: one on the board, on a host that has pens. */
export function canPen(t: Task) {
  if (t.kind !== "task" || t.task_type === "assistant" || t.task_type === "routine" || t.task_type === "pens") return false;
  return hasPens(useStore.getState().hosts.find((h) => h.id === t.host_id));
}

/**
 * Moves the tasks into pen `name` (made on a host that has none by it), or with null out of their pens, showing it at
 * once where the pen is known. The saved tasks come back as events; one that fails to save goes back to how it was
 * (unless it has changed since), and the first error is thrown once all have tried.
 */
export async function moveToPen(tasks: Task[], name: string | null) {
  const store = useStore.getState;
  const errors: Error[] = [];
  await Promise.all(
    tasks.filter(canPen).map(async (t) => {
      const pen = name === null ? null : store().pens.find((p) => p.host_id === t.host_id && p.profile_id === t.profile_id && penKey(p.name) === penKey(name));
      if (pen !== undefined && (pen?.id ?? null) === (t.pen_id ?? null)) return;
      if (pen !== undefined) store().upsertTask({ ...t, pen_id: pen?.id ?? null });
      try {
        await api.updateTask(t.host_id, t.id, { pen: name });
      } catch (e) {
        errors.push(e as Error);
        const current = store().tasks[t.id];
        if (current?.updated_at === t.updated_at) store().upsertTask(t);
      }
    }),
  );
  if (errors.length) throw errors[0];
}

/**
 * Makes a pen on the board's own host if it can, else on the first host with the profile that has pens: `profiles` is
 * the profile on each host, by host id.
 */
export async function createPen(profiles: Map<string, string>, name: string) {
  const s = useStore.getState();
  const hosts = s.hosts.filter((h) => h.connected !== false && hasPens(h) && profiles.has(h.id));
  const host = hosts.find((h) => h.local) ?? hosts[0];
  if (!host) throw new Error("No host with this profile has pens yet: update it first");
  const pen = await api.createPen(host.id, profiles.get(host.id)!, { name });
  s.upsertPen({ ...pen, host_id: host.id });
}

/** Does `change` to each of the tab's pens. */
export async function changeTab(tab: PenTab, change: { name?: string; hidden?: boolean }) {
  const s = useStore.getState();
  await Promise.all(
    tab.pens.map(async (p) => {
      const pen = await api.updatePen(p.host_id, p.id, change);
      s.upsertPen({ ...pen, host_id: p.host_id });
    }),
  );
}

export async function deleteTab(tab: PenTab) {
  const s = useStore.getState();
  await Promise.all(
    tab.pens.map(async (p) => {
      await api.deletePen(p.host_id, p.id);
      s.removePen(p.host_id, p.id);
    }),
  );
}

/** Moves a tab to place `to` among `tabs` (hidden ones too), on each host its pens are on. */
export async function moveTab(tabs: PenTab[], tab: PenTab, to: number) {
  const order = tabs.filter((t) => t !== tab);
  order.splice(Math.max(0, Math.min(order.length, to)), 0, tab);
  const s = useStore.getState();
  await Promise.all(
    tab.pens.map(async (p) => {
      // Its place among its own host's pens, in the new order.
      const index = order.flatMap((t) => t.pens.filter((x) => x.host_id === p.host_id)).findIndex((x) => x.id === p.id);
      const pen = await api.updatePen(p.host_id, p.id, { index });
      s.upsertPen({ ...pen, host_id: p.host_id });
    }),
  );
  // The others' places changed too.
  await Promise.all([...new Set(tab.pens.map((p) => p.host_id))].map((h) => s.loadPens(h, tab.pens.find((p) => p.host_id === h)!.profile_id)));
}

// The tab each profile's board shows (a pen's key, or "" for All), on this client.
const tabKey = (profile: string) => `ia.pen.${profile}`;

export const loadTab = (profile: string) => localStorage.getItem(tabKey(profile)) ?? "";

export function saveTab(profile: string, key: string) {
  if (key) localStorage.setItem(tabKey(profile), key);
  else localStorage.removeItem(tabKey(profile));
}
