import { useAtomValue } from "@effect/atom-react"
import { Duration } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { TaskId, type GitFileDiff } from "@huntaway/contracts"
import { query, type CallError, type QueryOptions, type QueryResult } from "@huntaway/client"
import { useMemo } from "react"
import { hasStaged, hasUnstaged, parseDiff, untracked, type FileRow } from "../diffs"
import { NO_DIFFS, rowPath, type FileDiffs } from "./model"
import { useKept } from "./useGitStatus"
import { resultError, resultValue } from "../../ui"

export type FileDiffsView = ReturnType<typeof useFileDiffs>

/** What a row's diffs are read with: its unstaged and staged diffs, and its untracked files' (a folder's first few). */
interface DiffsKey {
  readonly host: string
  readonly id: string
  readonly key: string
  readonly path: string
  readonly unstaged: boolean
  readonly staged: boolean
  readonly untracked: ReadonlyArray<string>
  /** The reads' `refresh` in milliseconds (0: none) and `focus`, as `QueryOptions`. */
  readonly refresh: number
  readonly focus: boolean
}

/** The key of a row's diffs: what of the row they're read from (so a row that's the same reads the same queries). */
export const diffsKey = (host: string, id: string, r: FileRow, reads?: QueryOptions): DiffsKey => ({
  host,
  id,
  key: r.key,
  path: rowPath(r),
  unstaged: r.files.some((f) => hasUnstaged(f) && !untracked(f)),
  staged: r.files.some(hasStaged),
  untracked: r.files
    .filter(untracked)
    .slice(0, 20)
    .map((f) => f.path),
  refresh: reads?.refresh === undefined ? 0 : Duration.toMillis(Duration.fromInputUnsafe(reads.refresh)),
  focus: reads?.focus === true,
})

const NO_DIFF: GitFileDiff = { patch: "" }
/** What isn't read (a file with no staged changes, say): no changes. */
const NONE: AsyncResult.AsyncResult<GitFileDiff> = AsyncResult.success(NO_DIFF)

/**
 * A row's diffs, unstaged and staged (`git.diff` queries, one a file or folder and one an untracked file), as one
 * answer: waiting while any of them is read again, failed if one failed.
 */
export const fileDiffsAtom = Atom.family((k: DiffsKey) =>
  Atom.make((get): AsyncResult.AsyncResult<FileDiffs, CallError<"git.diff">> => {
    const reads: QueryOptions = { refresh: k.refresh > 0 ? k.refresh : undefined, focus: k.focus }
    const id = TaskId.make(k.id)
    const read = (path: string, q: { staged?: boolean; untracked?: boolean }): QueryResult<"git.diff"> =>
      get(query("git.diff", k.host, { id, path, ...q }, reads))
    const parts: ReadonlyArray<QueryResult<"git.diff">> = [
      k.unstaged ? read(k.path, {}) : NONE,
      k.staged ? read(k.path, { staged: true }) : NONE,
      ...k.untracked.map((path) => read(path, { untracked: true })),
    ]
    return AsyncResult.map(AsyncResult.all(parts), ([ud = NO_DIFF, sd = NO_DIFF, ...ad]): FileDiffs => {
      const all = [ud, sd, ...ad]
      return {
        key: k.key,
        unstaged: [ud, ...ad].map((d) => d.patch).join(""),
        staged: sd.patch,
        tooLarge: all.some((d) => !!d.too_large),
        unstagedPreview: [ud, ...ad].map((d) => d.preview ?? "").join(""),
        stagedPreview: sd.preview ?? "",
        notUtf8: all.some((d) => !!d.not_utf8),
      }
    })
  }),
)

const nothing: Atom.Atom<AsyncResult.AsyncResult<FileDiffs>> = Atom.make(AsyncResult.initial())

/**
 * The selected file's (or folder's) diffs, `target`, read as the status is (`reads`), as its content can change while
 * its state doesn't. `diffs` is null until the target's have come.
 */
export function useFileDiffs(h: string, id: string, target: FileRow | undefined, reads: QueryOptions) {
  const result = useAtomValue(target ? fileDiffsAtom(diffsKey(h, id, target, reads)) : nothing)
  const error = resultError(result)
  const read = resultValue(result)
  const fileDiffs = useKept(error !== null ? { ...NO_DIFFS, key: target?.key ?? "", error } : (read ?? null))
  const diffs = fileDiffs && target && fileDiffs.key === target.key ? fileDiffs : null
  const unstagedFiles = useMemo(() => parseDiff(diffs?.unstaged ?? ""), [diffs?.unstaged])
  const stagedFiles = useMemo(() => parseDiff(diffs?.staged ?? ""), [diffs?.staged])
  const unstagedPreview = useMemo(() => parseDiff(diffs?.unstagedPreview ?? ""), [diffs?.unstagedPreview])
  const stagedPreview = useMemo(() => parseDiff(diffs?.stagedPreview ?? ""), [diffs?.stagedPreview])
  return { diffs, unstagedFiles, stagedFiles, unstagedPreview, stagedPreview }
}
