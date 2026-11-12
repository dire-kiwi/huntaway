import { Status, type DiskReport as DiskUsageReport, type DiskSize } from "@huntaway/contracts"
import { Schema } from "effect"
import { Atom } from "effect/reactivity"
import { query } from "@huntaway/client"
import { NEUTRAL, PALETTE } from "./analytics/analytics"
import { type Answered, gather, type Target } from "./analytics/gather"
import { nowMillis } from "../../state/clock"

/**
 * Disk usage analytics: what each host reports its projects' repositories, worktrees, scratch
 * folders and agent runs take up (see server disk.rs), merged across hosts.
 */

export interface DWorktree {
  /** Null for a worktree of the project's repository, in its worktrees folder, that no task on the host has. */
  taskId: string | null
  /** e.g. "IA-35". */
  key: string | null
  title: string | null
  status: Status | null
  path: string
  size: DiskSize
}

export interface DProject {
  id: string
  hostId: string
  hostName: string
  name: string
  color: string
  repoPath: string
  repo: DiskSize | null
  git: DiskSize | null
  worktrees: DWorktree[]
  /** All the worktrees together. */
  worktreeTotal: number
  other: DiskSize
  /** Its agent runs' folders (output and logs). */
  runs: DiskSize
  total: number
}

export interface Disk {
  /** Biggest first. */
  projects: DProject[]
  /** The profiles' own scratch folders. */
  scratch: number
  /** The agent runs' folders of tasks in no project. */
  runs: number
  /** Each host's data dir disk, with its database's size and how long it keeps runs if it says. */
  filesystems: { hostName: string; total: number; free: number; database: number | null; backups: DiskSize | null; runsKeptDays: number | null }[]
  /** Hosts that couldn't be asked, and why. */
  errors: string[]
  /** The slowest host's time to measure. */
  elapsedMs: number
}

/** A worktree whose task is done, or that no task has: it can likely go. */
export const reclaimable = (w: DWorktree) => w.taskId === null || w.status === "done"

/** What "Reclaim space" removes: the worktrees of done tasks, and only those the host finds merged and clean (API 39).
 * Worktrees no task has can't be removed this way: they're listed as reclaimable, but left to remove by hand. */
export const reclaimTargets = (data: Disk) => data.projects.filter((p) => p.worktrees.some((w) => w.taskId !== null && w.status === "done"))

/** What reclaiming did with one done task's worktree. */
export interface Reclaimed {
  taskId: string
  key: string
  title: string
  removed: boolean
  detail: string
  /** What the worktree took up before, which removing it frees. */
  bytes: number
}

/**
 * What `profile`'s projects take up (every profile's when it's null), from each host's report on each of its profiles.
 * A host's database holds every profile's data, so it's only counted for every profile.
 */
export function diskOf(profile: string | null, reports: ReadonlyArray<Answered<DiskUsageReport>>, errors: Array<string>): Disk {
  const out: Disk = {
    projects: [],
    scratch: 0,
    runs: 0,
    filesystems: [],
    errors,
    elapsedMs: 0,
  }
  let slot = 0
  const seenFs = new Set<string>()
  for (const { target, report } of reports) {
    // Colour follows the project in creation order, as on the activity tabs.
    for (const p of report.projects) out.projects.push(project(p, target.host, target.hostName, PALETTE[slot++] ?? NEUTRAL))
    out.scratch += report.scratch.bytes
    out.runs += report.runs?.bytes ?? 0
    out.elapsedMs = Math.max(out.elapsedMs, report.elapsed_ms)
    // Every profile on a host reports the same disk.
    if (report.filesystem && !seenFs.has(target.host)) {
      seenFs.add(target.host)
      out.filesystems.push({
        hostName: target.hostName,
        ...report.filesystem,
        database: profile === null ? (report.database ?? null) : null,
        backups: profile === null ? (report.backups ?? null) : null,
        runsKeptDays: report.runs_kept_days ?? null,
      })
    }
  }
  out.projects.sort((a, b) => b.total - a.total)
  return out
}

/** A measurement, and when it came back. */
export interface Measured {
  readonly disk: Disk
  readonly at: number
}

/**
 * What `profile`'s projects take up on `targets`. Kept for as long as the page is open (measuring walks every folder,
 * so coming back to the tab shows the last measurement), and read again when asked to or when worktrees are removed.
 */
export const diskAtom = Atom.family((key: { readonly profile: string | null; readonly targets: ReadonlyArray<Target> }) =>
  gather(
    key.targets,
    (t) => query("analytics.diskUsage", t.host, { profile_id: t.profileId }),
    (answered, errors): Measured => ({ disk: diskOf(key.profile, answered, errors), at: nowMillis() }),
  ).pipe(Atom.keepAlive),
)

const isStatus = Schema.is(Status)

function project(p: DiskUsageReport["projects"][number], hostId: string, hostName: string, color: string): DProject {
  const worktrees = p.worktrees.map((w) => ({
    taskId: w.task_id,
    key: w.number === null ? null : `${p.key}-${w.number}`,
    title: w.title,
    status: isStatus(w.status) ? w.status : null,
    path: w.path,
    size: w.size,
  }))
  const worktreeTotal = worktrees.reduce((n, w) => n + w.size.bytes, 0)
  const runs = p.runs ?? { bytes: 0, files: 0 }
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
  }
}

/** Binary units, as `du -h` counts them: "512 B", "4.2 MB", "18 GB". */
export function bytes(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/** The last part of a path. */
export const baseName = (p: string) =>
  p
    .replace(/[/\\]+$/, "")
    .split(/[/\\]/)
    .pop() ?? p
