import { Clock, Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import { NotFound } from "@huntaway/contracts"
import type { DiskProject, DiskReport, DiskSize, DiskWorktree, ProfileId } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { AnalyticsRepo } from "./AnalyticsRepo.ts"
import type { DiskProjectRow, WorktreeRow } from "./AnalyticsRepo.ts"

// What a profile's projects take up on this host (the old disk.ts, HA-183, HA-184): each project's repository and its
// `.git`, its tasks' worktrees and the stray ones (worktrees of its repository in its worktrees folder that no task or
// project on the host has), its scratch and data folders, its runs' folders; the profile's scratch folder and runs in no
// project; the database, its backups and the disk the data folder is on.
//
// Sizes are what files take on disk (allocated blocks, as `du`), each hard-linked file counted once per folder. Nothing
// is cached: the folders are walked when the report is asked for. The old server walked them in a worker thread, as the
// walk took seconds on a big board and held up every other request; here the walk is asynchronous file system calls,
// which leave the thread free between them.

/** How many days a finished run's folder is kept (the old `runs.KEEP_DAYS`). */
export const RUNS_KEPT_DAYS = 14

/** A folder to measure, leaving out the folders under it that are measured on their own. */
interface Walk {
  readonly root: string
  readonly skip: ReadonlyArray<string>
}

const allocated = (info: FileSystem.File.Info) => Number(Option.getOrElse(info.blocks, () => 0n)) * 512

const ZERO: DiskSize = { bytes: 0, files: 0 }
const add = (a: DiskSize, b: DiskSize): DiskSize => ({ bytes: a.bytes + b.bytes, files: a.files + b.files })

export interface DiskShape {
  readonly report: (profile: ProfileId) => Effect.Effect<DiskReport, NotFound>
  /** What `root` takes up on disk, leaving out `skip` (and what's under it); null when it isn't a folder. Symbolic links aren't followed. */
  readonly dirSize: (root: string, skip: ReadonlyArray<string>) => Effect.Effect<DiskSize | null>
}

export class Disk extends Context.Service<Disk, DiskShape>()("huntaway-server/analytics/Disk") {
  static readonly layer = Layer.effect(
    Disk,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* AnalyticsRepo
      const dataDir = yield* DataDir
      const proc = yield* Proc

      /** A path as compared: `.` parts, doubled and trailing slashes don't count. */
      const clean = (p: string) => {
        const n = path.normalize(p)
        return n.length > 1 ? n.replace(/\/+$/, "") : n
      }
      /** `inner` is `outer` or inside it. */
      const within = (inner: string, outer: string) => {
        const i = clean(inner)
        const o = clean(outer)
        return i === o || i.startsWith(o === "/" ? "/" : `${o}/`)
      }
      /** The folders under `root` (not `root` itself) among `others`. */
      const nested = (root: string, others: ReadonlyArray<string>) =>
        [...new Set(others.filter((o) => within(o, root) && clean(o) !== clean(root)).map(clean))].toSorted()
      const canonical = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => clean(p)))
      const isDir = (p: string) =>
        fs.stat(p).pipe(
          Effect.map((i) => i.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )

      const dirSize = Effect.fnUntraced(function* (root: string, skip: ReadonlyArray<string>) {
        const top = yield* Effect.option(fs.lstat(root))
        if (Option.isNone(top) || top.value.type !== "Directory") return null
        const skipped = new Set(skip.map(clean))
        const seen = new Set<string>()
        let bytes = 0
        let files = 0
        const stack = [root]
        for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
          const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
          const here = dir
          const infos = yield* Effect.forEach(
            names,
            (name) => Effect.option(Effect.map(fs.lstat(path.join(here, name)), (info) => [path.join(here, name), info] as const)),
            {
              concurrency: 16,
            },
          )
          for (const found of infos) {
            if (Option.isNone(found)) continue
            const [p, info] = found.value
            if (info.type === "Directory") {
              if (!skipped.has(clean(p))) stack.push(p)
              bytes += allocated(info)
              continue
            }
            // A hard link to a file already counted isn't counted again.
            if (Option.getOrElse(info.nlink, () => 1n) > 1n) {
              const id = `${info.dev}:${Option.getOrElse(info.ino, () => 0n)}`
              if (seen.has(id)) continue
              seen.add(id)
            }
            bytes += allocated(info)
            files += 1
          }
        }
        return { bytes, files }
      })

      /** The git dir of the checkout at `dir`: its `.git` folder, or where its `.git` file points. */
      const gitDir = Effect.fnUntraced(function* (dir: string) {
        const dotGit = path.join(dir, ".git")
        const info = yield* Effect.option(fs.lstat(dotGit))
        if (Option.isNone(info)) return null
        if (info.value.type === "Directory") return yield* fs.realPath(dotGit).pipe(Effect.orElseSucceed(() => null))
        const text = yield* fs.readFileString(dotGit).pipe(Effect.orElseSucceed(() => ""))
        const line = text.split("\n").find((l) => l.replace(/\r$/, "").startsWith("gitdir:"))
        if (line === undefined) return null
        const target = line.replace(/\r$/, "").slice(7).trim()
        return yield* fs.realPath(target.startsWith("/") ? target : path.join(dir, target)).pipe(Effect.orElseSucceed(() => null))
      })
      /** The repository's own git dir (the one its linked worktrees share), from a checkout's git dir. */
      const commonDir = Effect.fnUntraced(function* (git: string) {
        const c = yield* fs.readFileString(path.join(git, "commondir")).pipe(Effect.option)
        if (Option.isNone(c)) return git
        const t = c.value.trim()
        return yield* canonical(t.startsWith("/") ? t : path.join(git, t))
      })
      /** `dir` is a linked worktree (not a main checkout) of the repository whose git dir is `common`. */
      const linkedWorktreeOf = Effect.fnUntraced(function* (dir: string, common: string) {
        const g = yield* gitDir(dir)
        return g !== null && within(g, path.join(common, "worktrees")) && (yield* commonDir(g)) === common
      })

      /** The disk the data folder is on (`df -Pk`): its size and what's free, in bytes. */
      const filesystem = proc.run("df", ["-Pk", dataDir.root], { timeout: "10 seconds" }).pipe(
        Effect.map((r) => {
          const fields = r.code === 0 ? (r.stdout.trim().split("\n").at(-1) ?? "").split(/\s+/) : []
          const total = Number(fields[1])
          const free = Number(fields[3])
          return Number.isFinite(total) && Number.isFinite(free) && fields.length >= 4 ? { total: total * 1024, free: free * 1024 } : null
        }),
        Effect.orElseSucceed(() => null),
      )

      const projectUsage = Effect.fnUntraced(function* (
        p: DiskProjectRow,
        allTasks: ReadonlyArray<WorktreeRow>,
        owned: ReadonlySet<string>,
        runs: ReadonlyArray<string>,
        size: (w: Walk) => Effect.Effect<DiskSize | null>,
      ) {
        const tasks: Array<WorktreeRow> = []
        for (const t of allTasks) if (yield* isDir(t.path)) tasks.push(t)
        const repoGit = yield* gitDir(p.repo_path)
        const common = repoGit === null ? null : yield* commonDir(repoGit)
        const stray: Array<string> = []
        if (common !== null) {
          const names = yield* fs.readDirectory(p.worktrees_root).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
          for (const name of names) {
            const d = path.join(p.worktrees_root, name)
            if (!(yield* isDir(d)) || owned.has(yield* canonical(d))) continue
            if (yield* linkedWorktreeOf(d, common)) stray.push(d)
          }
        }
        stray.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        const projectDir = dataDir.projectDir(p.id)
        const wtPaths = [...tasks.map((t) => t.path), ...stray]
        // Everything measured on its own, so the folders that hold them leave them out.
        const separate = [...wtPaths, p.worktrees_root, dataDir.root, projectDir, p.scratch_path]
        const git = path.join(p.repo_path, ".git")
        const repoSkip = [...nested(p.repo_path, separate), clean(git)]
        const other: Array<Walk> = [{ root: projectDir, skip: nested(projectDir, [...wtPaths, p.worktrees_root]) }]
        if (!within(p.scratch_path, projectDir)) other.push({ root: p.scratch_path, skip: nested(p.scratch_path, wtPaths) })
        const gitSize = yield* size({ root: git, skip: nested(git, separate) })
        const worktrees: Array<DiskWorktree> = []
        for (const t of tasks) {
          worktrees.push({
            task_id: t.id,
            kind: t.kind,
            number: t.number,
            title: t.title,
            status: t.status,
            path: t.path,
            size: (yield* size({ root: t.path, skip: [] })) ?? ZERO,
          })
        }
        for (const s of stray) {
          worktrees.push({ task_id: null, kind: null, number: null, title: null, status: null, path: s, size: (yield* size({ root: s, skip: [] })) ?? ZERO })
        }
        worktrees.sort((a, b) => b.size.bytes - a.size.bytes)
        const repoSize = yield* size({ root: p.repo_path, skip: repoSkip })
        let otherSize = ZERO
        for (const w of other) otherSize = add(otherSize, (yield* size(w)) ?? ZERO)
        let runsSize = ZERO
        for (const r of runs) runsSize = add(runsSize, (yield* size({ root: r, skip: [] })) ?? ZERO)
        const usage: DiskProject = {
          id: p.id,
          name: p.name,
          key: p.key,
          repo_path: p.repo_path,
          repo: repoSize === null ? null : add(repoSize, gitSize ?? ZERO),
          git: gitSize,
          worktrees,
          other: otherSize,
          runs: runsSize,
        }
        return usage
      })

      const report = Effect.fn("Disk.report")(function* (profile: ProfileId) {
        if (!(yield* repo.profileExists(profile))) return yield* new NotFound({ what: "profile", id: profile })
        const started = yield* Clock.currentTimeMillis
        // Each distinct walk once.
        const sizes = new Map<string, DiskSize | null>()
        const size = (w: Walk) =>
          Effect.gen(function* () {
            const key = `${w.root}\u0000${w.skip.join("\u0000")}`
            const known = sizes.get(key)
            if (known !== undefined) return known
            const s = yield* dirSize(w.root, w.skip)
            sizes.set(key, s)
            return s
          })
        const owned = new Set<string>()
        for (const p of yield* repo.ownedPaths) owned.add(yield* canonical(p))
        // Each run's folder, by its task's project.
        const byProject = new Map<string | null, Array<string>>()
        for (const r of yield* repo.profileRuns(profile)) {
          const dir = dataDir.runDir(r.id)
          if (!(yield* isDir(dir))) continue
          byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), dir])
        }
        const projects: Array<DiskProject> = []
        for (const p of yield* repo.diskProjects(profile)) {
          projects.push(yield* projectUsage(p, yield* repo.worktrees(p.id), owned, byProject.get(p.id) ?? [], size))
        }
        let runs = ZERO
        for (const r of byProject.get(null) ?? []) runs = add(runs, (yield* size({ root: r, skip: [] })) ?? ZERO)
        let database: number | null = 0
        for (const f of [dataDir.database, `${dataDir.database}-wal`]) {
          const info = yield* Effect.option(fs.stat(f))
          if (Option.isSome(info)) database += allocated(info.value)
        }
        const out: DiskReport = {
          projects,
          scratch: (yield* size({ root: path.join(dataDir.profileDir(profile), "scratch"), skip: [] })) ?? ZERO,
          runs,
          runs_kept_days: RUNS_KEPT_DAYS,
          database,
          backups: yield* dirSize(dataDir.backups, []),
          filesystem: yield* filesystem,
          elapsed_ms: (yield* Clock.currentTimeMillis) - started,
        }
        return out
      })

      return Disk.of({ report, dirSize })
    }),
  )
}
