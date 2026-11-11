import { useMemo, useState } from "react"
import { parseDiff, type FileRow } from "../diffs"
import { loadFileDiffs, NO_DIFFS, type FileDiffs } from "./model"
import { useLoaded } from "./useLoaded"
import { sameJson } from "./useGitStatus"

export type FileDiffsView = ReturnType<typeof useFileDiffs>

/**
 * The selected file's (or folder's) diffs, `target`, fetched again on every check (`tick`), as its content can change
 * while its state doesn't. `diffs` is null until the target's have come.
 */
export function useFileDiffs(h: string, id: string, target: FileRow | undefined, tick: number) {
  const targetSig = target && `${target.key}\n${target.files.map((f) => `${f.x}${f.y}${f.path}`).join("\n")}`
  const loaded = useLoaded(target ? `${h}\n${id}\n${tick}\n${targetSig}` : null, () => (target ? loadFileDiffs(h, id, target) : Promise.resolve(NO_DIFFS)))
  // What `reload` read since, kept while it's the latest for its file.
  const [reloaded, setReloaded] = useState<{ from: FileDiffs | undefined; diffs: FileDiffs } | null>(null)
  const read: FileDiffs | null = loaded ? (loaded.value ?? { ...NO_DIFFS, key: target?.key ?? "", error: loaded.error ?? "" }) : null
  const fileDiffs = reloaded && reloaded.from === loaded?.value ? reloaded.diffs : read
  const diffs = fileDiffs && target && fileDiffs.key === target.key ? fileDiffs : null
  const unstagedFiles = useMemo(() => parseDiff(diffs?.unstaged ?? ""), [diffs?.unstaged])
  const stagedFiles = useMemo(() => parseDiff(diffs?.staged ?? ""), [diffs?.staged])
  const unstagedPreview = useMemo(() => parseDiff(diffs?.unstagedPreview ?? ""), [diffs?.unstagedPreview])
  const stagedPreview = useMemo(() => parseDiff(diffs?.stagedPreview ?? ""), [diffs?.stagedPreview])
  /** Fetches a row's diffs now (after a change to it), failing quietly: the next check tries again. */
  const reload = (row: FileRow) =>
    loadFileDiffs(h, id, row).then(
      (d) => setReloaded((p) => ({ from: loaded?.value, diffs: p && sameJson(p.diffs, d) ? p.diffs : d })),
      () => {},
    )
  return { diffs, unstagedFiles, stagedFiles, unstagedPreview, stagedPreview, reload }
}
