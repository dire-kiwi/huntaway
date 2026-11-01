import { create } from "zustand";
import { useEffect, useMemo } from "react";
import { approvalLoads, sortApprovals, withApproval, type HostApproval } from "./approvals";
import { loadProjectOrder, moveProjects, saveProjectOrder, sortProjects } from "./projectOrder";
import {
  api,
  ApiError,
  canRunAgents,
  hostCompat,
  hostSupports,
  isScratch,
  wsUrl,
  type ClaudeConfig,
  type Host,
  type HostSettings,
  type Message,
  type MessagePage,
  type Profile,
  type Project,
  type Task,
  type Usage,
} from "./api";
import { forgetThreadModels } from "./threadModel";
import { addDelta, clearDelta } from "./deltas";

/**
 * The board spans every connected host and every profile on them. Each host has its own
 * profiles, which the board merges by name: a profile's board shows its tasks from every host
 * that has it.
 */
interface State {
  authed: boolean | null;
  connected: boolean;
  /** Projects and tasks have been fetched. */
  loaded: boolean;
  hosts: Host[];
  /** The host this UI is served from. */
  localHostId: string | null;
  /** Profiles from every connected host (tagged with host_id). */
  profiles: Profile[];
  /** Claude configs from every connected host that has them (API 20). */
  claudeConfigs: ClaudeConfig[];
  projects: Project[];
  /** Archived projects (API 46). They're off the board: their tasks aren't loaded, and their tasks' events are left out. */
  archived: Project[];
  projectOrder: string[];
  /** Every profile's tasks (review threads too), by id. */
  tasks: Record<string, Task>;
  /** The messages of the threads that are shown (see useThreadMessages), by task id: the latest ones, and older pages as they're scrolled to (see `threads`). */
  messages: Record<string, Message[]>;
  /** How much of each open thread is loaded, on hosts that page them (API 56). */
  threads: Record<string, ThreadPages>;
  /** Progress of a rebuild/restart of the local host, from websocket events. */
  restart: { phase: string; error: string | null; log: string[] } | null;
  /** Agent defaults per host (used to show what threads inherit). */
  hostSettings: Record<string, HostSettings>;
  /** Claude usage for every config (or profile, on older hosts) on every host, by `usageKey`. */
  usage: Record<string, Usage>;
  /** Project changes agents are waiting for the user to approve, on every host, oldest first. */
  approvals: HostApproval[];

  setAuthed: (v: boolean) => void;
  loadAll: () => Promise<void>;
  loadProfiles: () => Promise<void>;
  refreshProfileData: () => Promise<void>;
  refreshHost: (hostId: string) => Promise<void>;
  loadHostSettings: (hostId: string) => Promise<void>;
  loadUsage: (refresh?: boolean) => Promise<void>;
  loadApprovals: (hostId: string) => Promise<void>;
  /**
   * Loads a thread's latest messages, or once they're loaded, newer ones; `again` (after a reconnect)
   * loads them again from the oldest loaded one on, for changes to them too.
   */
  loadMessages: (taskId: string, again?: boolean) => Promise<void>;
  /** Loads the thread's next page of older messages, if it has more. */
  loadOlderMessages: (taskId: string) => Promise<void>;
  upsertTask: (t: Task) => void;
  upsertProject: (p: Project) => void;
  /** Moves projects `ids` next to projects `targetIds` (see projectOrder.moveProjects). */
  moveProjects: (ids: string[], targetIds: string[], position: "before" | "after") => void;
  removeProject: (hostId: string, id: string) => void;
}

/**
 * Connected hosts this UI can work with and that can run agents. A hub that can't run agents
 * (e.g. one deployed only to show other hosts) gets no new work; boardHosts says what it shows.
 */
const usable = (h: Host) => canRunAgents(h) && ["ok", "outdated"].includes(hostCompat(h));
const usableHosts = (hosts: Host[]) => hosts.filter(usable);

/**
 * Hosts whose profiles and projects are on the board: the usable ones, plus this host even if
 * it can't run agents (it usually has none, but a PR preview seeds a demo project).
 */
export const boardHosts = (hosts: Host[]) => hosts.filter((h) => (h.local && h.connected) || usable(h));

/** Where new work goes by default: this host if it can run agents, else the first one that can. */
export function defaultAgentHost(): string | null {
  const hosts = useStore.getState().hosts;
  return (hosts.find((h) => h.local && canRunAgents(h)) ?? usableHosts(hosts)[0])?.id ?? null;
}

/**
 * Where a profile's new scratch tasks go: this host if it can run agents, otherwise the host
 * picked in Settings → Hosts (if it's usable), otherwise the default; or failing those, the
 * first usable host with the profile. Null when none of them has it.
 */
export function scratchHost(profileName: string): Profile | null {
  const s = useStore.getState();
  const local = s.hosts.find((h) => h.local);
  const picked = s.hostSettings[local?.id ?? ""]?.scratch_host;
  const preferred = [
    local && canRunAgents(local) ? local.id : null,
    usableHosts(s.hosts).find((h) => h.id === picked)?.id,
    defaultAgentHost(),
    ...usableHosts(s.hosts).map((h) => h.id),
  ];
  const on = (h: string | null | undefined) => s.profiles.find((p) => p.host_id === h && p.name === profileName && hostSupports(s.hosts.find((x) => x.id === h), 47));
  return preferred.map(on).find((p) => !!p) ?? null;
}

export interface ThreadPages {
  /** There are older messages than the loaded ones. */
  more: boolean;
  /** What lists the subagents started before the loaded messages (MessagePage.subagents), for buildSubagents. */
  subagents: Message[];
  loading: boolean;
}

/**
 * Messages from events for threads with a load under way, in order, by task id. A response can be
 * older than them (read before a message was stored or changed, e.g. a permission answered), so they're
 * applied over it (see whileLoading).
 */
const loadEvents = new Map<string, { loads: number; events: Message[] }>();

/**
 * Runs `load` for a thread, then `apply` with its result and the thread's events since it started:
 * if something shows the thread, or it's still kept after being closed (see retainThread), as a
 * reload after a reconnect has changes the kept messages missed.
 */
async function whileLoading<T>(taskId: string, load: () => Promise<T>, apply: (result: T, events: Message[]) => void) {
  const buffer = loadEvents.get(taskId) ?? { loads: 0, events: [] };
  buffer.loads++;
  loadEvents.set(taskId, buffer);
  try {
    const result = await load();
    if (threadViews.has(taskId) || useStore.getState().messages[taskId]) apply(result, buffer.events);
  } finally {
    if (--buffer.loads === 0) loadEvents.delete(taskId);
  }
}

/** How many of a thread's main-conversation messages a page has. */
const PAGE = 100;

/** `list` with `page`'s messages added or updated (the later of two with one id wins), in order. */
function mergeMessages(list: Message[], page: Message[]): Message[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of page) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** `events`: those that came while the page loaded (see whileLoading). */
function withPage(s: State, taskId: string, page: Message[], change: { more: boolean; subagents?: Message[] }, events: Message[] = []): Partial<State> {
  let list = mergeMessages(s.messages[taskId] ?? [], page);
  // Not those older than what's loaded now: changes to them come with their page.
  const newer = events.filter((m) => !list.length || m.id >= list[0].id);
  if (newer.length) list = mergeMessages(list, newer);
  const prev = s.threads[taskId];
  const first = list[0]?.id ?? Infinity;
  const subagents = (change.subagents ?? prev?.subagents ?? []).filter((m) => m.id < first);
  return {
    messages: { ...s.messages, [taskId]: list },
    threads: { ...s.threads, [taskId]: { loading: prev?.loading ?? false, more: change.more, subagents } },
  };
}

const tag = <T extends object>(items: T[], host_id: string) => items.map((x) => ({ ...x, host_id }));

/**
 * The ids of a host's tasks and projects that changed (by an event, or here) while a list of them loaded, and the
 * number of the host's latest refresh when it started (see refreshes).
 */
interface HostChanges {
  tasks: Set<string>;
  projects: Set<string>;
  gen: number;
}

/**
 * Changes to each host's tasks and projects while lists of them load (see refreshHost). A list can be older than
 * them (read before a task changed, was added or was deleted), so what the store has for them is kept over it.
 */
const hostLoads = new Map<string, Set<HostChanges>>();

function startHostLoad(h: string, gen = refreshes.get(h)?.started ?? 0) {
  const changes: HostChanges = { tasks: new Set(), projects: new Set(), gen };
  const loads = hostLoads.get(h) ?? new Set();
  loads.add(changes);
  hostLoads.set(h, loads);
  const done = () => {
    loads.delete(changes);
    if (!loads.size && hostLoads.get(h) === loads) hostLoads.delete(h);
  };
  return { changes, done };
}

/** Each host's refreshes, numbered as they start, and the latest one in the store: an older one that ends later is dropped. */
const refreshes = new Map<string, { started: number; applied: number }>();

/** Profile list loads, numbered as they start, and the latest one in the store: an older one that ends later is dropped. */
const profileLoads = { started: 0, applied: 0 };

/** The loadAll under way, the one queued to start after it (see loadAll), and the hosts lists numbered like profileLoads. */
const allLoads: { running: Promise<void> | null; queued: Promise<void> | null; started: number; applied: number } = {
  running: null,
  queued: null,
  started: 0,
  applied: 0,
};
/** How long a queued loadAll waits for the one under way at most. */
const LOAD_ALL_WAIT_MS = 2000;

type SetState = (partial: Partial<State>) => void;

function startLoadAll(set: SetState, get: () => State) {
  const gen = ++allLoads.started;
  const run = (async () => {
    const hosts = await api.hosts();
    // A newer load read them later (and loads the rest with them).
    if (allLoads.applied > gen) return;
    allLoads.applied = gen;
    const localHostId = hosts.find((h) => h.local)?.id ?? null;
    set({ hosts, localHostId, authed: true });
    // A board-only hub isn't among the usable hosts, but its settings pick the scratch host.
    await Promise.all([get().loadProfiles(), localHostId && get().loadHostSettings(localHostId)]);
  })();
  allLoads.running = run;
  const done = () => {
    if (allLoads.running === run) allLoads.running = null;
  };
  run.then(done, done);
  return run;
}

/** Collisions already logged: host ids and the task id. */
const collisions = new Set<string>();

/**
 * Whether task `id` is another host's than h's, which keeps it: ids are only unique on their host, so the first host's
 * task stays and the second one's (or its event) is dropped, with a warning the first time.
 */
function otherHosts(tasks: Record<string, Task>, h: string, id: string) {
  const cur = tasks[id];
  if (!h || !cur || cur.host_id === h) return false;
  const key = `${cur.host_id} ${h} ${id}`;
  if (!collisions.has(key)) {
    collisions.add(key);
    console.warn(`Task ${id} is on hosts ${cur.host_id} and ${h}: only ${cur.host_id}'s is shown, and ${h}'s is left out.`);
  }
  return true;
}

/** Marks a change for the host's loads under way, or with `before` only for those started before that refresh. */
function changed(h: string, kind: "tasks" | "projects", id: string, before = Infinity) {
  for (const c of hostLoads.get(h) ?? []) if (c.gen < before) c[kind].add(id);
}

/**
 * Whether a loaded copy of host h's task `t` goes in the store: not if another host's task has its id, and not over a
 * change that came while it loaded (`changes`), unless it's newer than that (a delete stays).
 */
function takesLoaded(tasks: Record<string, Task>, h: string, t: Task, changes: HostChanges) {
  if (otherHosts(tasks, h, t.id)) return false;
  const cur = tasks[t.id];
  if (!changes.tasks.has(t.id)) return true;
  return !!cur && !!t.updated_at && !!cur.updated_at && t.updated_at > cur.updated_at;
}

export const useStore = create<State>((set, get) => ({
  authed: null,
  connected: false,
  loaded: false,
  hosts: [],
  localHostId: null,
  profiles: [],
  claudeConfigs: [],
  projects: [],
  archived: [],
  projectOrder: loadProjectOrder(),
  tasks: {},
  messages: {},
  threads: {},
  restart: null,
  hostSettings: {},
  usage: {},
  approvals: [],

  setAuthed: (v) => set({ authed: v }),

  loadAll: () => {
    // A burst of calls (a reconnect, then hosts_changed for each link coming back) shares one more load after the one
    // under way, which starts after them and so reads what they were for; but not more than a moment after them, so
    // a slow host doesn't hold back the others' changes. Loads that overlap then apply in order.
    if (allLoads.queued) return allLoads.queued;
    if (!allLoads.running) return startLoadAll(set, get);
    const queued = Promise.race([allLoads.running.catch(() => {}), new Promise((r) => setTimeout(r, LOAD_ALL_WAIT_MS))]).then(() => {
      allLoads.queued = null;
      return startLoadAll(set, get);
    });
    allLoads.queued = queued;
    return queued;
  },

  loadProfiles: async () => {
    const gen = ++profileLoads.started;
    const online = boardHosts(get().hosts);
    const [lists, configs] = await Promise.all([
      Promise.all(online.map((h) => api.profiles(h.id).then((ps) => tag(ps, h.id)).catch(() => [] as Profile[]))),
      Promise.all(
        online.filter((h) => hostSupports(h, 20)).map((h) => api.claudeConfigs(h.id).then((cs) => tag(cs, h.id)).catch(() => [] as ClaudeConfig[])),
      ),
    ]);
    // A newer load read them later (and refreshes the hosts' tasks with them).
    if (profileLoads.applied > gen) return;
    profileLoads.applied = gen;
    const profiles = lists.flat();
    set({ profiles, claudeConfigs: configs.flat() });
    get().loadUsage().catch(() => {});
    await get().refreshProfileData();
  },

  refreshProfileData: async () => {
    const hosts = boardHosts(get().hosts);
    await Promise.all(hosts.flatMap((h) => [get().refreshHost(h.id), get().loadHostSettings(h.id), get().loadApprovals(h.id)]));
    // Drop data from hosts that went away.
    const live = new Set(hosts.map((h) => h.id));
    set((s) => ({
      loaded: true,
      // By the hosts there are now: one that reconnected meanwhile has had its approvals loaded
      // by a newer refresh.
      approvals: s.approvals.filter((a) => boardHosts(s.hosts).some((h) => h.id === a.host_id)),
      projects: s.projects.filter((p) => live.has(p.host_id)),
      archived: s.archived.filter((p) => live.has(p.host_id)),
      tasks: Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => live.has(t.host_id))),
    }));
    for (const taskId of Object.keys(get().messages)) get().loadMessages(taskId, true).catch(() => {});
  },

  refreshHost: async (h) => {
    const profiles = get().profiles.filter((p) => p.host_id === h);
    const reviews = hostSupports(get().hosts.find((x) => x.id === h), 12);
    const groups = hostSupports(get().hosts.find((x) => x.id === h), 34);
    const archiving = hostSupports(get().hosts.find((x) => x.id === h), 46);
    let projects: Project[] = [];
    let archived: Project[] = [];
    let tasks: Task[] = [];
    const count = refreshes.get(h) ?? { started: 0, applied: 0 };
    refreshes.set(h, count);
    const gen = ++count.started;
    const load = startHostLoad(h, gen);
    try {
      const loaded = await Promise.all(
        profiles.map(async (profile) => {
          // Group and scratch tasks are in no project.
          const [ps, projectless, gone] = await Promise.all([
            api.projects(h, profile.id),
            groups ? api.groupTasks(h, profile.id) : [],
            archiving ? api.projects(h, profile.id, true) : [],
          ]);
          // A project deleted since it was listed has no tasks (and its project_deleted event follows).
          const tasksOf = (id: string, kind: Task["kind"]) =>
            api.projectTasks(h, id, kind).catch((e) => (e instanceof ApiError && e.status === 404 ? [] : Promise.reject(e)));
          const lists = await Promise.all(ps.flatMap((p) => [tasksOf(p.id, "task"), ...(reviews ? [tasksOf(p.id, "review")] : [])]));
          return { projects: ps, archived: gone, tasks: [...projectless, ...lists.flat()] };
        }),
      );
      projects = tag(loaded.flatMap((l) => l.projects), h);
      archived = tag(loaded.flatMap((l) => l.archived), h);
      tasks = tag(loaded.flatMap((l) => l.tasks), h);
    } catch {
      load.done();
      return; // host dropped mid-load; hosts_changed will follow
    }
    const { changes } = load;
    load.done();
    // A newer refresh read all of it later.
    if (count.applied > gen) return;
    count.applied = gen;
    set((s) => {
      // The host's projects and tasks as loaded, but those that changed meanwhile as they are now.
      const kept = (x: { host_id: string; id: string }) => x.host_id !== h || changes.projects.has(x.id);
      const loaded = (x: Project) => !changes.projects.has(x.id);
      const nextProjects = [...s.projects.filter(kept), ...projects.filter(loaded)];
      const nextArchived = [...s.archived.filter(kept), ...archived.filter(loaded)];
      // Those of projects deleted or archived meanwhile are gone with them.
      const shown = new Set(nextProjects.filter((p) => p.host_id === h).map((p) => p.id));
      const offBoard = (t: Task) => !!t.project_id && changes.projects.has(t.project_id) && !shown.has(t.project_id);
      const next = Object.fromEntries(Object.entries(s.tasks).filter(([id, t]) => t.host_id !== h || (changes.tasks.has(id) && !offBoard(t))));
      for (const t of tasks) if (!offBoard(t) && takesLoaded(s.tasks, h, t, changes)) next[t.id] = t;
      // What this refresh set (or found gone) is a change to the loads under way that started before it, and read it
      // earlier (an unarchived project's tasks). Refreshes that started after it read it later, so they don't keep it.
      const ours = (x: { host_id: string }) => x.host_id === h;
      for (const id of new Set([...Object.values(s.tasks).filter(ours).map((t) => t.id), ...tasks.map((t) => t.id)])) changed(h, "tasks", id, gen);
      for (const p of [...s.projects, ...s.archived].filter(ours).concat(projects, archived)) changed(h, "projects", p.id, gen);
      return { projects: sortProjects(nextProjects, s.projectOrder), archived: nextArchived, tasks: next };
    });
  },

  loadHostSettings: async (h) => {
    try {
      const settings = await api.settings(h);
      set((s) => ({ hostSettings: { ...s.hostSettings, [h]: settings } }));
    } catch {
      /* host dropped; hosts_changed will follow */
    }
  },

  loadUsage: async (refresh = false) => {
    // Only hosts with a config that shows usage: older ones would fetch every config's.
    const shown = new Set(get().claudeConfigs.filter((c) => c.show_usage).map((c) => c.host_id));
    const hosts = usableHosts(get().hosts).filter((h) => hostSupports(h, 52) && shown.has(h.id));
    const lists = await Promise.all(
      hosts.map((h) =>
        api
          .usage(h.id, refresh)
          .then((us) => tag(us, h.id))
          .catch(() => [] as Usage[]),
      ),
    );
    set({ usage: Object.fromEntries(lists.flat().map((u) => [usageKey(u.host_id, usageId(u)), u])) });
  },

  loadApprovals: async (h) => {
    if (!hostSupports(get().hosts.find((x) => x.id === h), 44)) return;
    const load = approvalsLoading.start(h);
    try {
      const list = load.merge(tag(await api.projectApprovals(h), h));
      if (list) set((s) => ({ approvals: sortApprovals([...s.approvals.filter((a) => a.host_id !== h), ...list]) }));
    } catch {
      /* host dropped; hosts_changed will follow */
    } finally {
      load.done();
    }
  },

  loadMessages: async (taskId, again) => {
    const t = get().tasks[taskId];
    if (!t) return;
    if (!hostSupports(get().hosts.find((h) => h.id === t.host_id), 56)) {
      await whileLoading(
        taskId,
        () => api.messages(t.host_id, taskId),
        (msgs, events) => set((s) => ({ messages: { ...s.messages, [taskId]: mergeMessages(msgs, events) } })),
      );
      return;
    }
    // Events keep a loaded thread up to date while the host is connected.
    const list = get().messages[taskId];
    if (!list?.length) {
      await whileLoading(
        taskId,
        () => api.messagePage(t.host_id, taskId, { limit: PAGE }),
        (page: MessagePage, events) => set((s) => withPage(s, taskId, page.messages, { more: page.more, subagents: page.subagents }, events)),
      );
      return;
    }
    await whileLoading(
      taskId,
      () => api.messagePage(t.host_id, taskId, { after: again ? list[0].id - 1 : list[list.length - 1].id }),
      (page, events) => set((s) => withPage(s, taskId, page.messages, { more: s.threads[taskId]?.more ?? false }, events)),
    );
  },

  loadOlderMessages: async (taskId) => {
    const t = get().tasks[taskId];
    const first = get().messages[taskId]?.[0]?.id;
    const th = get().threads[taskId];
    if (!t || first == null || !th?.more || th.loading) return;
    const loading = (v: boolean) => set((s) => (s.threads[taskId] ? { threads: { ...s.threads, [taskId]: { ...s.threads[taskId], loading: v } } } : {}));
    loading(true);
    try {
      await whileLoading(
        taskId,
        () => api.messagePage(t.host_id, taskId, { before: first, limit: PAGE }),
        (page, events) => set((s) => withPage(s, taskId, page.messages, { more: page.more }, events)),
      );
    } finally {
      loading(false);
    }
  },

  upsertTask: (t) => {
    if (!profileOn(get(), t.host_id, t.profile_id)) return;
    if (get().archived.some((p) => p.host_id === t.host_id && p.id === t.project_id)) return;
    // Ids are only unique on their own host: another host's task with this one's stays.
    if (otherHosts(get().tasks, t.host_id, t.id)) return;
    changed(t.host_id, "tasks", t.id);
    set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
  },

  upsertProject: (p) => {
    if (!profileOn(get(), p.host_id, p.profile_id)) return;
    const same = (x: { host_id: string; id: string }) => x.host_id === p.host_id && x.id === p.id;
    changed(p.host_id, "projects", p.id);
    // An archived project goes off the board with its tasks.
    if (p.archived_at) {
      set((s) => ({
        archived: [...s.archived.filter((x) => !same(x)), p],
        projects: s.projects.filter((x) => !same(x)),
        tasks: Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => !(t.host_id === p.host_id && t.project_id === p.id))),
      }));
      return;
    }
    const unarchived = get().archived.some(same);
    set((s) => {
      const others = s.projects.filter((x) => !same(x));
      return { archived: s.archived.filter((x) => !same(x)), projects: sortProjects([...others, p], s.projectOrder) };
    });
    // One that's back has its tasks loaded again.
    if (unarchived) {
      const kinds: Task["kind"][] = ["task", ...(hostSupports(get().hosts.find((x) => x.id === p.host_id), 12) ? (["review"] as const) : [])];
      const load = startHostLoad(p.host_id);
      Promise.all(kinds.map((k) => api.projectTasks(p.host_id, p.id, k)))
        .then((lists) => {
          if (!get().projects.some(same)) return;
          set((s) => {
            const tasks = { ...s.tasks };
            for (const t of tag(lists.flat(), p.host_id)) if (takesLoaded(s.tasks, p.host_id, t, load.changes)) tasks[t.id] = t;
            load.done();
            // Refreshes that started after this read them later.
            for (const t of lists.flat()) changed(p.host_id, "tasks", t.id, load.changes.gen + 1);
            return { tasks };
          });
        })
        .catch(() => {})
        .finally(load.done);
    }
  },

  moveProjects: (ids, targetIds, position) => {
    const s = get();
    const projectOrder = moveProjects(s.projects, s.projectOrder, ids, targetIds, position);
    if (projectOrder === s.projectOrder) return;
    saveProjectOrder(projectOrder);
    set({ projectOrder, projects: sortProjects(s.projects, projectOrder) });
  },

  removeProject: (h, id) => {
    changed(h, "projects", id);
    set((s) => ({
      projects: s.projects.filter((p) => !(p.host_id === h && p.id === id)),
      archived: s.archived.filter((p) => !(p.host_id === h && p.id === id)),
      tasks: Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => !(t.host_id === h && t.project_id === id))),
    }));
  },
}));

/** How many views show each thread (see useThreadMessages). */
const threadViews = new Map<string, number>();

/** How long a thread nobody shows keeps its messages, so going back to it soon shows it straight away. */
const THREAD_KEEP_MS = 10_000;

/**
 * Keeps a thread's messages, and applies its new ones, until the returned function is called. Then,
 * once nothing else shows it, its messages are dropped (opening it loads them again): every open
 * thread is fetched again on a reconnect (from its oldest loaded message), and kept up to date.
 */
export function retainThread(taskId: string): () => void {
  threadViews.set(taskId, (threadViews.get(taskId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (threadViews.get(taskId) ?? 1) - 1;
    if (n > 0) return void threadViews.set(taskId, n);
    threadViews.delete(taskId);
    setTimeout(() => {
      if (threadViews.has(taskId) || !useStore.getState().messages[taskId]) return;
      useStore.setState((s) => {
        const messages = { ...s.messages };
        const threads = { ...s.threads };
        delete messages[taskId];
        delete threads[taskId];
        return { messages, threads };
      });
      forgetThreadModels((id) => id in useStore.getState().messages);
    }, THREAD_KEEP_MS);
  };
}

/**
 * A task's messages, kept up to date while the component is mounted, and loaded when it mounts
 * (unless `load` is false: then they're only there while something else shows the thread).
 */
export function useThreadMessages(taskId: string, load = true): Message[] | undefined {
  const messages = useStore((s) => s.messages[taskId]);
  useEffect(() => {
    const release = retainThread(taskId);
    if (load) useStore.getState().loadMessages(taskId).catch(() => {});
    return release;
  }, [taskId, load]);
  return messages;
}

/** Keeps loading lists of approvals from undoing changes that arrive meanwhile. */
const approvalsLoading = approvalLoads();

/** Usage is by Claude config id, or by profile id on hosts before API 20. */
export const usageKey = (h: string, id: string) => `${h}:${id}`;
const usageId = (u: Pick<Usage, "config_id" | "profile_id">) => u.config_id ?? u.profile_id ?? "";

/**
 * The Claude configs a new thread can pick from: the project's override, else the profile's,
 * the default first. Empty on hosts before API 20 (and for a profile with none), which means
 * the profile's own config directory.
 */
export function availableConfigs(s: Pick<State, "profiles" | "claudeConfigs">, hostId: string, profileId: string, project?: Project | null): ClaudeConfig[] {
  const own = project?.claude_config_ids?.length ? project.claude_config_ids : null;
  const ids = own ?? s.profiles.find((p) => p.host_id === hostId && p.id === profileId)?.claude_config_ids ?? [];
  return ids.map((id) => s.claudeConfigs.find((c) => c.host_id === hostId && c.id === id)).filter((c): c is ClaudeConfig => !!c);
}

/**
 * The config a task's agent runs with: its own, or else the first its project (or profile) offers. A config deleted
 * since falls back to that too. None for one that started with none (its profile had no configs then), which stays in
 * Claude's default config.
 */
export function taskConfig(s: Pick<State, "profiles" | "claudeConfigs" | "projects">, task: Task): ClaudeConfig | undefined {
  const own = s.claudeConfigs.find((c) => c.host_id === task.host_id && c.id === task.claude_config_id);
  if (own) return own;
  if (!task.claude_config_id && task.session_id) return undefined;
  return availableConfigs(s, task.host_id, task.profile_id, s.projects.find((p) => p.host_id === task.host_id && p.id === task.project_id))[0];
}

export function useAvailableConfigs(hostId: string, profileId: string, project?: Project | null) {
  const profiles = useStore((s) => s.profiles);
  const claudeConfigs = useStore((s) => s.claudeConfigs);
  return useMemo(() => availableConfigs({ profiles, claudeConfigs }, hostId, profileId, project), [profiles, claudeConfigs, hostId, profileId, project]);
}

/** A profile's Claude configs, by name ("default" config dirs on older hosts). */
export function profileConfigLabel(s: Pick<State, "claudeConfigs">, p: Profile) {
  if (!p.claude_config_ids) return p.claude_config_dir || "~/.claude";
  const names = p.claude_config_ids.map((id) => s.claudeConfigs.find((c) => c.host_id === p.host_id && c.id === id)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "Claude's default config";
}

/** Distinct profile names across hosts, in first-seen order. */
export function profileNames(profiles: Profile[]) {
  return [...new Set(profiles.map((p) => p.name))];
}

/** Whether `profileId` on host `h` is on the board. */
function profileOn(s: State, h: string, profileId: string) {
  return s.profiles.some((p) => p.host_id === h && p.id === profileId);
}

/** The name of the profile a task or project is in (profiles are merged across hosts by name). */
export function profileNameOf(s: Pick<State, "profiles">, x: { host_id: string; profile_id: string }) {
  return s.profiles.find((p) => p.host_id === x.host_id && p.id === x.profile_id)?.name;
}

export function useProfileName(x: { host_id: string; profile_id: string } | undefined) {
  return useStore((s) => (x ? profileNameOf(s, x) : undefined));
}

// ---------- live updates ----------

let socket: WebSocket | null = null;
let retry = 0;
/** The reconnect waiting out its backoff. */
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let wakeListening = false;

/**
 * Reconnects now rather than at the end of the backoff (up to 32 s), when the network comes back or the page is shown
 * again, as after a laptop wakes.
 */
function reconnectNow() {
  if (socket || !retryTimer || document.visibilityState === "hidden") return;
  clearTimeout(retryTimer);
  retryTimer = null;
  retry = 0;
  connectEvents();
}

/**
 * Connects to the events, and loads everything once connected (again after a reconnect, for the events missed), so
 * nothing changes unseen between a load and the connection. A socket that can't connect at first loads it anyway, so a
 * wrong token shows the token screen.
 */
export function connectEvents() {
  if (socket) return;
  if (!wakeListening) {
    wakeListening = true;
    window.addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", reconnectNow);
  }
  const ws = new WebSocket(wsUrl());
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    retry = 0;
    useStore.setState({ connected: true });
    useStore.getState().loadAll().catch(() => {});
  };
  ws.onclose = () => {
    socket = null;
    if (!opened && retry === 0 && useStore.getState().authed === null) useStore.getState().loadAll().catch(() => {});
    useStore.setState({ connected: false });
    // Not with a wrong token: the token screen reloads the page with the new one.
    if (useStore.getState().authed === false) return;
    retry = Math.min(retry + 1, 6);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectEvents();
    }, 500 * 2 ** retry);
  };
  ws.onmessage = (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    handleEvent(ev);
  };
}

type AutomationListener = (hostId: string, projectId: string, automationId: string) => void;
/** Told when a task's checkpoints change (API 70): a turn's was taken, or it was rewound. */
type CheckpointListener = (hostId: string, taskId: string) => void;
const checkpointListeners = new Set<CheckpointListener>();
export function onCheckpoints(fn: CheckpointListener) {
  checkpointListeners.add(fn);
  return () => {
    checkpointListeners.delete(fn);
  };
}

const automationListeners = new Set<AutomationListener>();

/** Calls `fn` whenever an automation (or its runs) changes on a host. Returns the unsubscribe. */
export function onAutomationsChanged(fn: AutomationListener) {
  automationListeners.add(fn);
  return () => {
    automationListeners.delete(fn);
  };
}

/**
 * Called with a task as it was (undefined if it wasn't on the board) and as it is when an event changes it, for
 * notifications (notifier.ts). Not when lists of tasks load, at the start and after a reconnect, so a task that's
 * waiting already then doesn't notify.
 */
export const liveTaskChanges = new Set<(prev: Task | undefined, next: Task) => void>();

/** Applies a websocket event to the store (exported for tests). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleEvent(ev: any) {
  const s = useStore.getState();
  const h: string = ev.host_id ?? s.localHostId ?? "";
  // Ids are only unique on their host: an event about another host's task with the same id leaves it be.
  const otherHost = (taskId: string) => otherHosts(s.tasks, h, taskId);
  switch (ev.type) {
    case "task": {
      const prev = s.tasks[ev.task.id];
      s.upsertTask({ ...ev.task, host_id: h });
      const next = useStore.getState().tasks[ev.task.id];
      if (next && next !== prev && next.host_id === h) for (const l of liveTaskChanges) l(prev?.host_id === h ? prev : undefined, next);
      break;
    }
    case "task_deleted":
      if (otherHost(ev.id)) break;
      changed(h, "tasks", ev.id);
      useStore.setState((st) => {
        const tasks = { ...st.tasks };
        delete tasks[ev.id];
        return { tasks };
      });
      break;
    case "project":
      s.upsertProject({ ...ev.project, host_id: h });
      break;
    case "project_deleted":
      s.removeProject(h, ev.id);
      break;
    case "profiles_changed":
      s.loadProfiles().catch(() => {});
      break;
    case "hosts_changed":
      s.loadAll().catch(() => {});
      break;
    case "usage":
      useStore.setState((st) => ({ usage: { ...st.usage, [usageKey(h, usageId(ev.usage))]: { ...ev.usage, host_id: h } } }));
      break;
    case "settings_changed":
      s.loadHostSettings(h);
      break;
    case "automations_changed":
      for (const fn of automationListeners) fn(h, ev.project_id, ev.automation_id);
      break;
    case "checkpoints":
      for (const fn of checkpointListeners) fn(h, ev.task_id);
      break;
    case "message":
    case "message_updated": {
      // A project change, deletion or automation asked for (or answered) in any thread.
      if (ev.message?.kind === "permission" && ["project", "delete_task", "automation"].includes(ev.message.data?.kind)) {
        const a: HostApproval = { ...ev.message.data, task_id: ev.task_id, created_at: ev.message.created_at, host_id: h };
        approvalsLoading.changed(a);
        useStore.setState((st) => ({ approvals: withApproval(st.approvals, a) }));
      }
      if (otherHost(ev.task_id)) break;
      const m: Message = ev.message;
      // A persisted assistant text block supersedes the streamed preview (whether the thread is loaded or not).
      if (m.kind === "claude" && m.data?.type === "assistant" && !m.data.parent_tool_use_id) clearDelta(ev.task_id);
      // For loads of the thread under way, whose responses may be older.
      loadEvents.get(ev.task_id)?.events.push(m);
      const list = s.messages[ev.task_id];
      if (!list) break; // not shown; it'll load when it is
      if (list.length && m.id < list[0].id) break; // older than what's loaded; it comes with its page
      const next = withMessage(list, m);
      useStore.setState((st) => ({ messages: { ...st.messages, [ev.task_id]: next } }));
      break;
    }
    case "delta":
      if (otherHost(ev.task_id)) break;
      addDelta(ev.task_id, ev.text);
      break;
    case "delta_reset":
      if (otherHost(ev.task_id)) break;
      clearDelta(ev.task_id);
      break;
    case "resync":
      if (ev.host_id) {
        s.refreshHost(ev.host_id).catch(() => {});
        s.loadApprovals(ev.host_id);
        // The open threads' missed messages too (e.g. an approval's answer).
        for (const taskId of Object.keys(s.messages)) if (s.tasks[taskId]?.host_id === ev.host_id) s.loadMessages(taskId, true).catch(() => {});
      } else s.loadAll().catch(() => {}); // the hub's own events lagged: hosts and profiles may have changed too
      break;
    case "restart":
      if (h !== s.localHostId) break;
      useStore.setState((st) => ({
        restart: { phase: ev.phase, error: ev.error ?? null, log: ev.phase === "starting" ? [] : (st.restart?.log ?? []) },
      }));
      break;
    case "restart_log":
      if (h !== s.localHostId) break;
      useStore.setState((st) => ({
        restart: { phase: st.restart?.phase ?? "starting", error: null, log: [...(st.restart?.log ?? []), ev.line].slice(-2000) },
      }));
      break;
  }
}

/**
 * A thread's messages (in id order) with `m` added, or in place of the one with its id. New ones
 * come at the end, and updates are mostly of recent ones, so neither looks through the whole thread.
 */
export function withMessage(list: Message[], m: Message): Message[] {
  const next = list.slice();
  if (!list.length || m.id > list[list.length - 1].id) next.push(m);
  else {
    let i = list.length - 1;
    while (i >= 0 && list[i].id > m.id) i--;
    if (i >= 0 && list[i].id === m.id) next[i] = m;
    else next.splice(i + 1, 0, m);
  }
  return next;
}

export function useProject(id: string | null | undefined) {
  return useStore((s) => s.projects.find((p) => p.id === id));
}

export function useHost(id: string | null | undefined) {
  return useStore((s) => s.hosts.find((h) => h.id === id));
}

export function taskKey(t: Task, projects: Project[]) {
  return `${keyPrefix(t, projects.find((x) => x.id === t.project_id))}-${t.number}`;
}

/** What goes before a task's number: its project's key, `G` for a group task, or `S` for a scratch task. */
export const keyPrefix = (t: Task, project?: Project) => project?.key ?? (t.project_id ? "T" : t.group_name ? "G" : isScratch(t) ? "S" : "T");

/** A group task: in no project, it plans the work of its group's projects. */
export const isGroupTask = (t: Task) => t.kind === "task" && !t.project_id && !!t.group_name;
