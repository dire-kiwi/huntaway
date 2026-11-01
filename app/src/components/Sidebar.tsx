import clsx from "clsx";
import { Bell, BellRing, ChartColumn, ChevronRight, EyeOff, Folder, Pin, Plus, Settings, Star, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { activeProfile, loadActiveProfile, saveActiveProfile } from "../activeProfile";
import { api, hostCompat, hostSupports, readyToCheck, type Project, type Status, type Task } from "../api";
import {
  groupKey,
  groupNames,
  groupProjects,
  groupTasks,
  groupsWithTasks,
  hiddenKey,
  loadCollapsedGroups,
  loadFavoriteProjects,
  loadHiddenProjects,
  loadPinnedProjects,
  orphanGroupNames,
  profileProjects,
  saveCollapsedGroups,
  saveFavoriteProjects,
  saveHiddenProjects,
  savePinnedProjects,
  sidebarEntries,
  visibleEntries,
} from "../projectGroups";
import { isDue, reminderLabel, reminderTasks, starredTasks } from "../reminders";
import { useDrawer } from "../narrow";
import { navigate, openTask, usePanel, type Route } from "../router";
import { profileNames, taskKey, useStore } from "../store";
import { ProfileAvatar } from "./Board";
import { ReminderModal, reminderItems, starItem, useReminderClock } from "./Reminders";
import { ReloadButton, UpdateButton } from "./Server";
import { UsagePanel } from "./Usage";
import { ArchiveProjectModal, NewProjectModal } from "./Settings";
import { Button, ContextMenu, IconButton, Input, Modal, ModalFooter, RunningDot, StatusBar, type MenuItem } from "./ui";

function NavItem({ active, current, onClick, onContextMenu, icon, children, right, className, title, expanded }: {
  active: boolean;
  /** Marks the row with a bar at its left edge: the profile whose projects the sidebar lists. */
  current?: boolean;
  title?: string;
  /** For a row that shows or leaves out the rows under it. */
  expanded?: boolean;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  icon: ReactNode;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      aria-expanded={expanded}
      aria-current={current || undefined}
      className={clsx(
        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] narrow:h-10",
        active || current ? "text-fg" : "text-muted hover:text-fg",
        active ? "bg-raised" : "hover:bg-white/[0.04]",
        current && "relative before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent",
        className,
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {right}
    </button>
  );
}

const BADGE_TONE = { attention: "bg-st-attention/20 text-amber-300", review: "bg-st-review/20 text-violet-300", muted: "bg-white/10 text-muted" };

function Badge({ n, tone = "attention", title }: { n: number; tone?: keyof typeof BADGE_TONE; title?: string }) {
  if (!n) return null;
  return (
    <span title={title} className={clsx("min-w-[18px] rounded-full px-1.5 text-center text-[10.5px] leading-[18px] font-semibold", BADGE_TONE[tone])}>
      {n}
    </span>
  );
}

type Stats = { attention: number; running: number; ready: number };

/** What a project (or group) has waiting: tasks that need attention, in amber, and tasks in
 * review that are ready to check, in purple (see `readyToCheck`). */
function Counts({ attention, ready }: Pick<Stats, "attention" | "ready">) {
  return (
    <>
      <Badge n={ready} tone="review" title={`${ready} in review and ready to check`} />
      <Badge n={attention} title={`${attention} need${attention === 1 ? "s" : ""} attention`} />
    </>
  );
}

const COLLAPSED_SECTIONS_KEY = "ia.sidebar.collapsedSections";

function loadCollapsedSections(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** A heading over a list in the sidebar, which shows or leaves out the list. */
function SectionHeading({ label, open, onToggle, right }: { label: string; open: boolean; onToggle: () => void; right?: ReactNode }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-7 w-full items-center gap-1 px-2 text-left text-[11px] font-semibold tracking-wide text-faint uppercase hover:text-muted"
    >
      <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
      <span className="flex-1">{label}</span>
      {right}
    </button>
  );
}

/**
 * The starred tasks, and those with a reminder (soonest first, the due ones in amber). Each
 * section is only there while it has tasks; which are collapsed is saved in this browser.
 */
function MarkedTasks({ route }: { route: Route }) {
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const panelTask = usePanel()?.taskId;
  const list = useMemo(() => Object.values(tasks), [tasks]);
  const starred = useMemo(() => starredTasks(list, projects.map((p) => p.id)), [list, projects]);
  const reminders = useMemo(() => reminderTasks(list), [list]);
  const now = useReminderClock(reminders);
  const [collapsed, setCollapsed] = useState(loadCollapsedSections);
  const [menu, setMenu] = useState<{ x: number; y: number; task: Task } | null>(null);
  const [picking, setPicking] = useState<Task | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Its error, menu and dialog stay when the last task leaves the sections (a failed clear, say).
  if (!starred.length && !reminders.length && !err && !menu && !picking) return null;

  const openId = route.name === "task" || route.name === "subproject" ? route.taskId : panelTask;
  const due = reminders.filter((t) => isDue(t, now)).length;
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  const row = (t: Task, right: ReactNode, title: string) => (
    <NavItem
      key={t.id}
      active={openId === t.id}
      title={title}
      onClick={() => openTask(t.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setErr(null);
        setMenu({ x: e.clientX, y: e.clientY, task: t });
      }}
      icon={<span className="font-mono text-[10.5px] text-faint">{taskKey(t, projects)}</span>}
      right={right}
    >
      {t.title}
    </NavItem>
  );
  const section = (key: string, label: string, items: Task[], render: (t: Task) => ReactNode, right?: ReactNode) =>
    items.length > 0 && (
      <div role="group" aria-label={label}>
        <SectionHeading label={label} open={!collapsed.has(key)} onToggle={() => toggle(key)} right={right} />
        {!collapsed.has(key) && <div className="space-y-0.5">{items.map(render)}</div>}
      </div>
    );

  return (
    <div className="space-y-1 pb-2">
      {section("starred", "Starred", starred, (t) => row(t, <Star size={11} className="shrink-0 text-amber-300" fill="currentColor" />, t.title))}
      {section(
        "reminders",
        "Reminders",
        reminders,
        (t) => {
          const on = isDue(t, now);
          return row(
            t,
            <span className={clsx("flex shrink-0 items-center gap-1 text-[11px]", on ? "text-amber-300" : "text-faint")}>
              {on ? <BellRing size={11} /> : <Bell size={11} />}
              {reminderLabel(t.remind_at!, now)}
            </span>,
            `${t.title}\nReminder: ${new Date(t.remind_at!).toLocaleString()}${t.reminder ? `\n${t.reminder}` : ""}`,
          );
        },
        <Badge n={due} title={`${due} reminder${due === 1 ? "" : "s"} due`} />,
      )}
      {err && (
        <div className="flex items-start gap-1 px-2.5 py-1 text-[11.5px] text-red-400">
          <span className="min-w-0 flex-1">{err}</span>
          <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setErr(null)}>
            <X size={12} />
          </IconButton>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={`${taskKey(menu.task, projects)}${menu.task.reminder ? ` · ${menu.task.reminder}` : ""}`}
          items={[starItem(menu.task, setErr), ...reminderItems(menu.task, () => setPicking(menu.task), setErr, true)]}
          onClose={() => setMenu(null)}
        />
      )}
      {picking && <ReminderModal task={picking} onClose={() => setPicking(null)} />}
    </div>
  );
}

/** Names a new group, or renames one. */
function GroupNameModal({ title, initial, onSave, onClose }: { title: string; initial: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave(name.trim());
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} onSubmit={submit} width="max-w-sm">
      <form onSubmit={submit} className="space-y-4">
        <Input autoFocus value={name} placeholder="Group name" maxLength={100} onChange={(e) => setName(e.target.value)} />
        <ModalFooter className="space-y-4">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** `drawer`: in the narrow layout's drawer, which it fills. */
export function Sidebar({ route, drawer }: { route: Route; drawer?: boolean }) {
  const profiles = useStore((s) => s.profiles);
  const hosts = useStore((s) => s.hosts);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const connected = useStore((s) => s.connected);
  const upsertProject = useStore((s) => s.upsertProject);
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsedGroups);
  const [hidden, setHidden] = useState(loadHiddenProjects);
  const [pinned, setPinned] = useState(loadPinnedProjects);
  const [favorites, setFavorites] = useState(loadFavoriteProjects);
  const [savedProfile, setSavedProfile] = useState(loadActiveProfile);
  /** Hosts whose hidden projects are shown, under their other projects (for this session). */
  const [showHidden, setShowHidden] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);
  const [naming, setNaming] = useState<{ title: string; initial: string; projects: Project[] } | null>(null);
  const [groupErr, setGroupErr] = useState<string | null>(null);

  /** The name of the profile a project or task is in (profiles are merged across hosts by name). */
  const profileOf = useMemo(() => {
    const names = new Map(profiles.map((p) => [`${p.host_id}:${p.id}`, p.name]));
    return (x: { host_id: string; profile_id: string }) => names.get(`${x.host_id}:${x.profile_id}`);
  }, [profiles]);

  const stats = useMemo(() => {
    const by: Record<string, Stats> = {};
    // Each profile's tasks by column, by profile name.
    const byProfile: Record<string, Partial<Record<Status, number>>> = {};
    for (const t of Object.values(tasks)) {
      if (t.kind !== "task") continue;
      const name = profileOf(t);
      if (name) {
        const counts = (byProfile[name] ??= {});
        counts[t.status] = (counts[t.status] ?? 0) + 1;
      }
      // A group task counts towards its group, by `g:<groupKey>`.
      const id = t.project_id ?? (t.group_name ? `g:${groupKey(t.host_id, t.group_name)}` : null);
      if (!id) continue;
      const s = (by[id] ??= { attention: 0, running: 0, ready: 0 });
      if (t.status === "needs_attention") s.attention++;
      if (readyToCheck(t)) s.ready++;
      if (t.running) s.running++;
    }
    return { by, byProfile };
  }, [tasks, profileOf]);

  const routeTask = route.name === "task" || route.name === "subproject" ? tasks[route.taskId] : undefined;
  const activeProject = "projectId" in route ? route.projectId : routeTask?.project_id;
  const names = profileNames(profiles);
  const taskList = useMemo(() => Object.values(tasks), [tasks]);
  const isPinned = (p: Project) => pinned.has(hiddenKey(p));

  // The sidebar lists the projects of one profile (and the pinned ones): the profile whose board
  // is open, else the one picked last. Opening a project it doesn't list moves to its profile.
  const openProjects =
    route.name === "board" || route.name === "projectSettings"
      ? projects.filter((p) => p.id === route.projectId)
      : routeTask?.project_id
        ? projects.filter((p) => p.host_id === routeTask.host_id && p.id === routeTask.project_id)
        : route.name === "group"
          ? groupProjects(projects, route.hostId, route.group)
          : [];
  const active = activeProfile(names, savedProfile, (current) => {
    if (route.name === "profile") return route.profile;
    const listed = openProjects.some((p) => profileOf(p) === current || isPinned(p));
    if (route.name === "group") {
      // A profile lists a group for its projects in it, and for its group tasks in it (which can
      // stay after its own projects leave the group), so either keeps it.
      const owners = groupTasks(taskList, route.hostId, route.group).map(profileOf);
      if (listed || owners.includes(current)) return undefined;
      return openProjects.length ? profileOf(openProjects[0]) : owners[0];
    }
    if (openProjects.length && !listed) return profileOf(openProjects[0]);
  });
  useEffect(() => {
    if (active === undefined || active === savedProfile) return;
    setSavedProfile(active);
    saveActiveProfile(active);
  }, [active, savedProfile]);

  const shown = profileProjects(projects, active, profileOf, pinned);
  // Favorites are listed above the others, in a section of their own, unless they're hidden.
  const isFavorite = (p: Project) => favorites.has(hiddenKey(p)) && !hidden.has(hiddenKey(p));
  const favoriteList = shown.filter(isFavorite);
  const profileTasks = useMemo(() => taskList.filter((t) => profileOf(t) === active), [taskList, profileOf, active]);
  const withTasks = useMemo(() => groupsWithTasks(profileTasks), [profileTasks]);
  // Group projects by host once more than one host is involved.
  const groups = hosts
    .map((h) => ({
      host: h,
      projects: shown.filter((p) => p.host_id === h.id),
      // Every profile's projects on the host, for what a group does as a whole (moving, renaming).
      all: projects.filter((p) => p.host_id === h.id),
      entries: visibleEntries(sidebarEntries(shown.filter((p) => p.host_id === h.id)), hidden, favorites, withTasks),
      orphans: orphanGroupNames(profileTasks, shown, h.id),
    }))
    .filter(
      (g) => g.entries.length > 0 || g.projects.some((p) => hidden.has(hiddenKey(p))) || g.orphans.length > 0 || !g.host.connected || ["incompatible", "board_outdated"].includes(hostCompat(g.host)),
    );
  const grouped = hosts.length > 1;

  const setCollapsedGroup = (key: string, on: boolean) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (on) next.add(key);
      else next.delete(key);
      saveCollapsedGroups(next);
      return next;
    });

  /** Hides `list` from the sidebar, or shows them again. */
  const setProjectsHidden = (list: Project[], on: boolean) =>
    setHidden((old) => {
      const next = new Set(old);
      for (const p of list) {
        if (on) next.add(hiddenKey(p));
        else next.delete(hiddenKey(p));
      }
      saveHiddenProjects(next);
      return next;
    });

  /** Pins `list` to the sidebar of every profile, or unpins them. */
  const setProjectsPinned = (list: Project[], on: boolean) =>
    setPinned((old) => {
      const next = new Set(old);
      for (const p of list) {
        if (on) next.add(hiddenKey(p));
        else next.delete(hiddenKey(p));
      }
      savePinnedProjects(next);
      return next;
    });

  /** Lists `list` under *Favorites*, above the other projects, or takes them out. A hidden project made a favorite is shown again. */
  const setProjectsFavorite = (list: Project[], on: boolean) => {
    setFavorites((old) => {
      const next = new Set(old);
      for (const p of list) {
        if (on) next.add(hiddenKey(p));
        else next.delete(hiddenKey(p));
      }
      saveFavoriteProjects(next);
      return next;
    });
    if (on) setProjectsHidden(list, false);
  };

  /** Puts `list` in group `name` (null takes them out of their group). */
  const setGroup = async (list: Project[], name: string | null) => {
    setGroupErr(null);
    const saved = await Promise.all(list.map((p) => api.updateProject(p.host_id, p.id, { group_name: name }).then((x) => ({ ...x, host_id: p.host_id }))));
    saved.forEach(upsertProject);
  };
  /** Moves off the board of a group that's gone (renamed or ungrouped). */
  const leaveGroup = (hostId: string, name: string, to: Route) => {
    if (route.name === "group" && route.hostId === hostId && route.group === name) navigate(to, true);
  };
  /** Resolves to whether it worked; the sidebar shows why it didn't. */
  const trySetGroup = (list: Project[], name: string | null) =>
    setGroup(list, name).then(
      () => true,
      (e) => (setGroupErr((e as Error).message), false),
    );

  const projectMenu = (e: MouseEvent, p: Project) => {
    e.preventDefault();
    const grouping = hostSupports(hosts.find((h) => h.id === p.host_id), 32);
    const isHidden = hidden.has(hiddenKey(p));
    const favorite = favorites.has(hiddenKey(p));
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: grouping ? `Group ${p.name} in` : p.name,
      items: [
        ...(grouping
          ? [
              ...groupNames(projects, p.host_id).map((name) => ({ label: name, checked: p.group_name === name, onSelect: () => trySetGroup([p], name) })),
              { label: "New group…", onSelect: () => setNaming({ title: `New group for ${p.name}`, initial: "", projects: [p] }) },
              { label: "No group", checked: !p.group_name, onSelect: () => trySetGroup([p], null) },
            ]
          : []),
        { label: favorite ? "Remove from favorites" : "Add to favorites", divider: true, onSelect: () => setProjectsFavorite([p], !favorite) },
        ...(names.length > 1 || isPinned(p) ? [{ label: isPinned(p) ? "Unpin" : "Pin to every profile", onSelect: () => setProjectsPinned([p], !isPinned(p)) }] : []),
        { label: isHidden ? "Show in sidebar" : "Hide from sidebar", onSelect: () => setProjectsHidden([p], !isHidden) },
        ...(hostSupports(hosts.find((h) => h.id === p.host_id), 46) ? [{ label: "Archive…", onSelect: () => setArchiving(p) }] : []),
      ],
    });
  };

  /** `list` is the group's projects of every profile, `listed` those the sidebar lists. */
  const groupMenu = (e: MouseEvent, name: string, list: Project[], listed: Project[]) => {
    e.preventDefault();
    const allPinned = listed.every(isPinned);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: name,
      items: [
        {
          label: "Rename group…",
          onSelect: () => setNaming({ title: `Rename ${name}`, initial: name, projects: list }),
        },
        { label: "Ungroup", onSelect: () => trySetGroup(list, null).then((ok) => ok && leaveGroup(list[0].host_id, name, { name: "board", projectId: list[0].id })) },
        ...(names.length > 1 || listed.some(isPinned)
          ? [{ label: allPinned ? "Unpin" : "Pin to every profile", divider: true, onSelect: () => setProjectsPinned(listed, !allPinned) }]
          : []),
        { label: "Hide from sidebar", divider: names.length < 2 && !listed.some(isPinned), onSelect: () => setProjectsHidden(listed, true) },
      ],
    });
  };

  const projectRow = (p: Project, dim = false) => {
    const s = stats.by[p.id];
    const owner = profileOf(p);
    const pin = isPinned(p);
    const notes = [
      grouped && isFavorite(p) && `On ${hosts.find((h) => h.id === p.host_id)?.name ?? p.host_id}`,
      dim && `${p.name} is hidden from the sidebar; right-click it to show it again`,
      pin && (owner !== active ? `In ${owner}, pinned to every profile's sidebar` : "Pinned to every profile's sidebar"),
    ].filter(Boolean);
    return (
      <NavItem
        className={clsx("min-w-0 flex-1", dim && "opacity-60")}
        title={notes.length ? notes.join("\n") : undefined}
        active={activeProject === p.id}
        onClick={() => navigate({ name: "board", projectId: p.id })}
        onContextMenu={(e) => projectMenu(e, p)}
        icon={
          <span className="flex h-4.5 w-7 items-center justify-center rounded bg-white/[0.06] font-mono text-[9.5px] font-semibold text-muted">
            {p.key.slice(0, 3)}
          </span>
        }
        right={
          <span className="flex items-center gap-1.5">
            {s?.running ? <RunningDot /> : null}
            <Counts attention={s?.attention ?? 0} ready={s?.ready ?? 0} />
            {pin && <Pin size={11} className="shrink-0 text-faint" aria-label="Pinned" />}
            {pin && owner && owner !== active && <ProfileAvatar name={owner} muted className="h-4 w-4 text-[9px]" />}
          </span>
        }
      >
        {p.name}
      </NavItem>
    );
  };

  return (
    <aside className={clsx("flex h-full shrink-0 flex-col border-r border-line bg-panel", drawer ? "w-full" : "w-60")}>
      <div className="drag flex h-12 items-center gap-2 px-4">
        <img src="/icon.svg" className="h-5 w-5" alt="" />
        <span className="text-[13.5px] font-semibold tracking-tight">Huntaway</span>
        <span
          title={connected ? "Connected" : "Reconnecting…"}
          className={clsx("ml-auto h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-400" : "bg-red-400 animate-pulse-dot")}
        />
        {drawer && (
          <IconButton className="-mr-2" title="Close the menu" onClick={() => useDrawer.getState().setOpen(false)}>
            <X size={18} />
          </IconButton>
        )}
      </div>

      <nav className="space-y-0.5 px-2" aria-label="Profiles">
        {names.map((name) => (
          <NavItem
            key={name}
            active={route.name === "profile" && route.profile === name}
            current={names.length > 1 && name === active}
            onClick={() => navigate({ name: "profile", profile: name })}
            title={names.length > 1 && name === active ? `All of ${name}'s tasks. The sidebar lists ${name}'s projects` : `All of ${name}'s tasks`}
            icon={<ProfileAvatar name={name} muted={names.length > 1 && name !== active} />}
            right={<StatusBar counts={stats.byProfile[name] ?? {}} />}
          >
            {name}
          </NavItem>
        ))}
        <NavItem active={route.name === "analytics"} onClick={() => navigate({ name: "analytics" })} icon={<ChartColumn size={15} />}>
          Analytics
        </NavItem>
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2">
        <MarkedTasks route={route} />
        {favoriteList.length > 0 && (
          <div className="pb-3">
            <div className="flex h-6 items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
              <Star size={11} className="shrink-0" />
              Favorites
            </div>
            <div role="group" aria-label="Favorites" className="space-y-0.5">
              {favoriteList.map((p) => (
                <div key={`${p.host_id}:${p.id}`} className="flex">
                  {projectRow(p)}
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center px-2 pb-1">
          <span className="min-w-0 truncate text-[11px] font-semibold tracking-wide text-faint uppercase">
            Projects
            {names.length > 1 && active && (
              <span className="font-normal tracking-normal normal-case" title={`${active}'s projects, and the pinned ones`}>
                {" · "}
                <span className="text-accent">{active}</span>
              </span>
            )}
          </span>
          <IconButton className="ml-auto h-6 w-6" title="Add project" onClick={() => setAdding(true)}>
            <Plus size={14} />
          </IconButton>
        </div>
        <div className="space-y-0.5">
          {groups.map(({ host, projects: list, all, entries, orphans }) => (
            <div key={host.id} className={clsx(grouped && "pb-2")}>
              {grouped && (
                <button
                  onClick={() => navigate({ name: "host", hostId: host.id })}
                  title={`Configure ${host.name}`}
                  className="flex w-full items-center gap-1.5 px-2.5 pt-1 pb-0.5 text-left text-[10.5px] text-faint hover:text-muted"
                >
                  <span className={clsx("h-1.5 w-1.5 rounded-full", host.connected ? "bg-emerald-400/70" : "bg-red-400")} />
                  {host.name}
                  {!host.connected && " · offline"}
                  {host.connected && ["incompatible", "board_outdated"].includes(hostCompat(host)) && " · needs update"}
                </button>
              )}
              {entries.map((entry) => {
                if (entry.kind === "project")
                  return (
                    <div key={entry.key} className="flex">
                      {projectRow(entry.project)}
                    </div>
                  );
                const key = groupKey(entry.hostId, entry.name);
                const open = !collapsed.has(key);
                // Its projects are all favorites: the row stays for its group tasks (see visibleEntries), with nothing to open.
                const empty = !entry.projects.length;
                const total = [...entry.projects.map((p) => p.id), `g:${key}`].reduce(
                  (t, id) => ({
                    attention: t.attention + (stats.by[id]?.attention ?? 0),
                    running: t.running + (stats.by[id]?.running ?? 0),
                    ready: t.ready + (stats.by[id]?.ready ?? 0),
                  }),
                  { attention: 0, running: 0, ready: 0 },
                );
                const onGroup = route.name === "group" && route.hostId === entry.hostId && route.group === entry.name;
                const hidesActive = !open && entry.projects.some((p) => p.id === activeProject);
                return (
                  <div key={entry.key} className="flex">
                    <div className="min-w-0 flex-1">
                      <div
                        className={clsx(
                          "flex h-8 items-center rounded-md text-[13px] narrow:h-10",
                          onGroup || hidesActive ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg",
                        )}
                        onContextMenu={(e) => groupMenu(e, entry.name, groupProjects(all, entry.hostId, entry.name), groupProjects(list, entry.hostId, entry.name))}
                      >
                        {empty ? (
                          <span className="w-6 shrink-0 narrow:w-8" />
                        ) : (
                          <button
                            aria-expanded={open}
                            aria-label={`${open ? "Collapse" : "Expand"} ${entry.name}`}
                            title={open ? "Collapse" : "Expand"}
                            onClick={() => setCollapsedGroup(key, open)}
                            className="flex h-8 w-6 shrink-0 items-center justify-center rounded-l-md text-faint hover:text-fg narrow:h-10 narrow:w-8"
                          >
                            <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} />
                          </button>
                        )}
                        <button
                          onClick={() => navigate({ name: "group", hostId: entry.hostId, group: entry.name })}
                          title={`All of ${entry.name}'s tasks`}
                          className="flex h-8 min-w-0 flex-1 items-center gap-2 pr-2.5 text-left narrow:h-10"
                        >
                          <Folder size={14} className="shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                          {(!open || empty) && (
                            <span className="flex items-center gap-1.5">
                              {total.running ? <RunningDot /> : null}
                              <Counts attention={total.attention} ready={total.ready} />
                            </span>
                          )}
                        </button>
                      </div>
                      {open && !empty && (
                        <div role="group" aria-label={entry.name} className="ml-3 space-y-0.5 border-l border-line pl-1">
                          {entry.projects.map((p) => (
                            <div key={p.id} className="flex">
                              {projectRow(p)}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {(() => {
                const off = list.filter((p) => hidden.has(hiddenKey(p)));
                if (!off.length) return null;
                const open = showHidden.has(host.id);
                const total = off.reduce(
                  (t, p) => ({
                    attention: t.attention + (stats.by[p.id]?.attention ?? 0),
                    running: t.running + (stats.by[p.id]?.running ?? 0),
                    ready: t.ready + (stats.by[p.id]?.ready ?? 0),
                  }),
                  { attention: 0, running: 0, ready: 0 },
                );
                const toggle = () =>
                  setShowHidden((old) => {
                    const next = new Set(old);
                    if (open) next.delete(host.id);
                    else next.add(host.id);
                    return next;
                  });
                return (
                  <>
                    <NavItem
                      className="min-w-0"
                      active={!open && off.some((p) => p.id === activeProject)}
                      onClick={toggle}
                      expanded={open}
                      title={open ? "Leave hidden projects out" : "Show hidden projects"}
                      icon={<EyeOff size={14} className="text-faint" />}
                      right={
                        <span className="flex items-center gap-1.5">
                          {!open && total.running ? <RunningDot /> : null}
                          {!open && <Counts attention={total.attention} ready={total.ready} />}
                          <ChevronRight size={13} className={clsx("text-faint transition-transform", open && "rotate-90")} />
                        </span>
                      }
                    >
                      {off.length} hidden
                    </NavItem>
                    {open && (
                      <div role="group" aria-label={`Hidden projects${grouped ? ` on ${host.name}` : ""}`} className="ml-3 space-y-0.5 border-l border-line pl-1">
                        {off.map((p) => (
                          <div key={p.id} className="flex">
                            {projectRow(p, true)}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
              {orphans.map((name) => {
                const s = stats.by[`g:${groupKey(host.id, name)}`];
                return (
                  <NavItem
                    key={name}
                    className="min-w-0"
                    active={route.name === "group" && route.hostId === host.id && route.group === name}
                    onClick={() => navigate({ name: "group", hostId: host.id, group: name })}
                    title={
                      groupProjects(all, host.id, name).length
                        ? `${name}'s projects are in other profiles; ${active}'s group tasks in it are here`
                        : `${name} has no projects any more; its group tasks are still here`
                    }
                    icon={<Folder size={14} className="text-faint" />}
                    right={
                      <span className="flex items-center gap-1.5">
                        {s?.running ? <RunningDot /> : null}
                        <Counts attention={s?.attention ?? 0} ready={s?.ready ?? 0} />
                      </span>
                    }
                  >
                    <span className="italic">{name}</span>
                  </NavItem>
                );
              })}
            </div>
          ))}
          {groupErr && (
            <div className="flex items-start gap-1 px-2.5 py-1 text-[11.5px] text-red-400">
              <span className="min-w-0 flex-1">{groupErr}</span>
              <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setGroupErr(null)}>
                <X size={12} />
              </IconButton>
            </div>
          )}
          {shown.length === 0 && (
            <button onClick={() => setAdding(true)} className="w-full rounded-md border border-dashed border-line px-3 py-3 text-[12px] text-faint hover:text-muted">
              {projects.length === 0 ? "Add your first project" : `Add a project to ${active}`}
            </button>
          )}
        </div>
      </div>

      <UsagePanel profile={active} />
      <div className="border-t border-line p-2">
        <ReloadButton />
        <UpdateButton />
        <NavItem active={route.name === "settings"} onClick={() => navigate({ name: "settings" })} icon={<Settings size={15} />}>
          Settings
        </NavItem>
      </div>
      {adding && <NewProjectModal profile={active} onClose={() => setAdding(false)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {archiving && <ArchiveProjectModal project={archiving} onClose={() => setArchiving(null)} />}
      {naming && (
        <GroupNameModal
          title={naming.title}
          initial={naming.initial}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            const hostId = naming.projects[0].host_id;
            const old = naming.initial && groupKey(hostId, naming.initial);
            await setGroup(naming.projects, name);
            if (naming.initial) leaveGroup(hostId, naming.initial, { name: "group", hostId, group: name });
            // A renamed group stays collapsed (or open).
            if (old && collapsed.has(old)) {
              setCollapsedGroup(old, false);
              setCollapsedGroup(groupKey(hostId, name), true);
            }
          }}
        />
      )}
    </aside>
  );
}
