import { api, hostSupports, type DiskSize, type DiskUsageReport, type Status } from "./api";
import { NEUTRAL, PALETTE } from "./analytics";
import { boardHosts, useStore } from "./store";

/**
 * Disk usage analytics: what each host reports its projects' repositories, worktrees, scratch
 * folders and agent runs take up (see server disk.rs), merged across hosts.
 */

export interface DWorktree {
  /** Null for a worktree of the project's repository, in its worktrees folder, that no task on the host has. */
  taskId: string | null;
  /** e.g. "IA-35". */
  key: string | null;
  title: string | null;
  status: Status | null;
  path: string;
  size: DiskSize;
}

export interface DProject {
  id: string;
  hostId: string;
  hostName: string;
  name: string;
  color: string;
  repoPath: string;
  repo: DiskSize | null;
  git: DiskSize | null;
  worktrees: DWorktree[];
  /** All the worktrees together. */
  worktreeTotal: number;
  other: DiskSize;
  /** Its agent runs' folders (output and logs). */
  runs: DiskSize;
  total: number;
}

export interface Disk {
  /** Biggest first. */
  projects: DProject[];
  /** The profiles' own scratch folders. */
  scratch: number;
  /** The agent runs' folders of tasks in no project. */
  runs: number;
  /** Each host's data dir disk, with its database's size and how long it keeps runs if it says. */
  filesystems: { hostName: string; total: number; free: number; database: number | null; runsKeptDays: number | null }[];
  /** Hosts that couldn't be asked, and why. */
  errors: string[];
  /** The slowest host's time to measure. */
  elapsedMs: number;
}

/** A worktree whose task is done, or that no task has: it can likely go. */
export const reclaimable = (w: DWorktree) => w.taskId === null || w.status === "done";

export async function loadDisk(): Promise<Disk> {
  const s = useStore.getState();
  const out: Disk = {
    projects: [],
    scratch: 0,
    runs: 0,
    filesystems: [],
    errors: [],
    elapsedMs: 0,
  };
  const reports = await Promise.all(
    boardHosts(s.hosts).flatMap((h) => {
      const profiles = s.profiles.filter((p) => p.host_id === h.id);
      if (!profiles.length) return [];
      if (!hostSupports(h, 35)) {
        out.errors.push(`${h.name} needs an update to report disk usage`);
        return [];
      }
      return profiles.map(async (profile) => {
        try {
          return { host: h, report: await api.diskUsage(h.id, profile.id) };
        } catch (e) {
          out.errors.push(`${h.name}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      });
    }),
  );
  let slot = 0;
  const seenFs = new Set<string>();
  for (const r of reports) {
    if (!r) continue;
    // Colour follows the project in creation order, as on the activity tabs.
    for (const p of r.report.projects) out.projects.push(project(p, r.host.id, r.host.name, PALETTE[slot++] ?? NEUTRAL));
    out.scratch += r.report.scratch.bytes;
    out.runs += r.report.runs?.bytes ?? 0;
    out.elapsedMs = Math.max(out.elapsedMs, r.report.elapsed_ms);
    // Every profile on a host reports the same disk.
    if (r.report.filesystem && !seenFs.has(r.host.id)) {
      seenFs.add(r.host.id);
      out.filesystems.push({
        hostName: r.host.name,
        ...r.report.filesystem,
        database: r.report.database ?? null,
        runsKeptDays: r.report.runs_kept_days ?? null,
      });
    }
  }
  out.projects.sort((a, b) => b.total - a.total);
  return out;
}

function project(p: DiskUsageReport["projects"][number], hostId: string, hostName: string, color: string): DProject {
  const worktrees = p.worktrees.map((w) => ({
    taskId: w.task_id,
    key: w.number === null ? null : `${p.key}-${w.number}`,
    title: w.title,
    status: w.status,
    path: w.path,
    size: w.size,
  }));
  const worktreeTotal = worktrees.reduce((n, w) => n + w.size.bytes, 0);
  const runs = p.runs ?? { bytes: 0, files: 0 };
  return {
    id: p.id,
    hostId,
    hostName,
    name: p.name,
    color,
    repoPath: p.repo_path,
    repo: p.repo,
    git: p.git,
    worktrees,
    worktreeTotal,
    other: p.other,
    runs,
    total: (p.repo?.bytes ?? 0) + worktreeTotal + p.other.bytes + runs.bytes,
  };
}

/** Binary units, as `du -h` counts them: "512 B", "4.2 MB", "18 GB". */
export function bytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** The last part of a path. */
export const baseName = (p: string) =>
  p
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() ?? p;
