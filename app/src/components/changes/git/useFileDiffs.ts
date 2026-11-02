import { useEffect, useMemo, useState } from "react";
import { parseDiff, type FileRow } from "../changes";
import { errText, loadFileDiffs, NO_DIFFS, type FileDiffs } from "./model";

export type FileDiffsView = ReturnType<typeof useFileDiffs>;

/**
 * The selected file's (or folder's) diffs, `target`, fetched again on every check (`tick`), as its content can change
 * while its state doesn't. `diffs` is null until the target's have come.
 */
export function useFileDiffs(h: string, id: string, target: FileRow | undefined, tick: number) {
  const [fileDiffs, setFileDiffs] = useState<FileDiffs | null>(null);
  const targetSig = target && `${target.key}\n${target.files.map((f) => `${f.x}${f.y}${f.path}`).join("\n")}`;
  const keepDiffs = (d: FileDiffs) => setFileDiffs((p) => (p && JSON.stringify(p) === JSON.stringify(d) ? p : d));
  useEffect(() => {
    if (!target) return;
    let stale = false;
    const key = target.key;
    loadFileDiffs(h, id, target)
      .then((d) => !stale && keepDiffs(d))
      .catch((e) => !stale && setFileDiffs({ ...NO_DIFFS, key, error: errText(e) }));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSig, tick, h, id]);
  const diffs = fileDiffs && target && fileDiffs.key === target.key ? fileDiffs : null;
  const unstagedFiles = useMemo(() => parseDiff(diffs?.unstaged ?? ""), [diffs?.unstaged]);
  const stagedFiles = useMemo(() => parseDiff(diffs?.staged ?? ""), [diffs?.staged]);
  const unstagedPreview = useMemo(() => parseDiff(diffs?.unstagedPreview ?? ""), [diffs?.unstagedPreview]);
  const stagedPreview = useMemo(() => parseDiff(diffs?.stagedPreview ?? ""), [diffs?.stagedPreview]);
  /** Fetches a row's diffs now (after a change to it), failing quietly: the next check tries again. */
  const reload = (row: FileRow) => loadFileDiffs(h, id, row).then(keepDiffs, () => {});
  return { diffs, unstagedFiles, stagedFiles, unstagedPreview, stagedPreview, reload };
}
