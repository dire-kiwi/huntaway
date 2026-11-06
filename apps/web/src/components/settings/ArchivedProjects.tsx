import { Archive, ArchiveRestore } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, hostSupports, type Project } from "../../api";
import { navigate, parse } from "../../router";
import { profileNames, useStore } from "../../store";
import { Button, Modal, ModalFooter, timeAgo } from "../ui";

/**
 * Archives `project`: it goes off the board (the sidebar, its profile's and group's boards, agents'
 * project lists) until it's unarchived in Settings. Leaves a page about the project for the home page.
 */
export function ArchiveProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const archive = async () => {
    setErr(null);
    setBusy(true);
    try {
      const p = await api.updateProject(project.host_id, project.id, { archived: true });
      const s = useStore.getState();
      const route = parse(window.location.pathname);
      const panel = new URLSearchParams(window.location.search).get("task");
      const taskId = route.name === "task" || route.name === "subproject" ? route.taskId : panel;
      const here = ("projectId" in route && route.projectId === project.id) || (!!taskId && s.tasks[taskId]?.project_id === project.id);
      s.upsertProject({ ...p, host_id: project.host_id });
      onClose();
      if (here) navigate({ name: "home" }, true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Archive ${project.name}`} onClose={onClose}>
      <p className="mb-4 text-[13px] text-muted">
        The project goes off the board: out of the sidebar, the inbox and its group, and agents can&apos;t add tasks to it. Its tasks, worktrees and branches
        are kept. To bring it back, unarchive it in Settings → Archived projects.
      </p>
      <ModalFooter>
        {err && <div className="mb-3 text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={archive}>
            <Archive size={13} /> Archive project
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

/** The archived projects of every profile, on every host that has them, to unarchive. */
export function ArchivedProjectsPanel() {
  const hosts = useStore((s) => s.hosts);
  const profiles = useStore((s) => s.profiles);
  // Changes when a project on the board is archived or unarchived, so the list is fetched again.
  const onBoard = useStore((s) => s.archived);
  const [list, setList] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const from = useMemo(
    () =>
      profiles.filter((p) =>
        hostSupports(
          hosts.find((h) => h.id === p.host_id),
          46,
        ),
      ),
    [profiles, hosts],
  );
  useEffect(() => {
    let live = true;
    const lists = from.map((p) =>
      api
        .projects(p.host_id, p.id, true)
        .then((ps) => ps.map((x) => ({ ...x, host_id: p.host_id })))
        .catch(() => [] as Project[]),
    );
    Promise.all(lists).then((l) => live && setList(l.flat().sort((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? ""))));
    return () => {
      live = false;
    };
  }, [from, onBoard]);
  if (!from.length) return null;
  const key = (p: Project) => `${p.host_id}:${p.id}`;
  const manyProfiles = profileNames(profiles).length > 1;
  const manyHosts = new Set(from.map((p) => p.host_id)).size > 1;
  const unarchive = async (p: Project) => {
    setErr(null);
    setBusy(key(p));
    try {
      const saved = await api.updateProject(p.host_id, p.id, { archived: false });
      useStore.getState().upsertProject({ ...saved, host_id: p.host_id });
      setList((l) => l?.filter((x) => key(x) !== key(p)) ?? null);
    } catch (e) {
      setErr(`Unarchiving ${p.name}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Archived projects</h2>
      <div className="rounded-xl border border-line">
        {list === null ? (
          <div className="px-4 py-3 text-[12.5px] text-faint">Loading…</div>
        ) : !list.length ? (
          <div className="px-4 py-3 text-[12.5px] text-faint">
            No archived projects. Archive one from its menu in the sidebar (right-click it) or its settings.
          </div>
        ) : (
          list.map((p) => (
            <div key={key(p)} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {p.name} <span className="text-faint">{p.key}</span>
                </div>
                <div className="truncate text-[11.5px] text-faint">
                  {[
                    manyProfiles && profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name,
                    manyHosts && hosts.find((h) => h.id === p.host_id)?.name,
                    p.archived_at && `archived ${timeAgo(p.archived_at)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <Button size="sm" disabled={busy === key(p)} onClick={() => unarchive(p)}>
                <ArchiveRestore size={13} /> Unarchive
              </Button>
            </div>
          ))
        )}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </section>
  );
}
