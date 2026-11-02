import type { RefObject } from "react";
import type { GitStatus } from "../../../api";
import { hasStaged, hasUnstaged, linesStageable, untracked } from "../diffs";
import type { CommentSource } from "../lineComments";
import type { useTurns } from "../../task/turns";
import { DiffLines, type Layout } from "../DiffLines";
import { EmptyMain, Note, Panel, Section } from "./Panels";
import { BranchView, CommitHead, LayoutToggle, PatchView, RawDiff, TurnView } from "./Patches";
import type { GitActions } from "./useGitActions";
import type { FileDiffsView } from "./useFileDiffs";
import type { GitSelection } from "./useGitSelection";
import type { ShownDiffs } from "./useShownDiffs";
import type { Staging } from "./useStaging";
import { mainTitle, NOT_UTF8, STAGED, UNSTAGED, type Pane } from "./model";

/**
 * The main panel, on the right of the Changes tab: what's selected in the panel you're in. A file's diffs are two
 * panels, unstaged and staged, whose lines are staged from them (`staging`); the rest is one.
 */
export function MainPanel({
  status,
  sel,
  staging,
  d,
  shown,
  actions,
  turns,
  layout,
  toggleLayout,
  focused,
  mainScroll,
  stagingSource,
  commentStaging,
}: {
  status: GitStatus;
  sel: GitSelection;
  staging: Staging;
  d: FileDiffsView;
  shown: ShownDiffs;
  actions: GitActions;
  turns: ReturnType<typeof useTurns>;
  layout: Layout;
  toggleLayout: () => void;
  focused: boolean;
  mainScroll: RefObject<HTMLDivElement | null>;
  stagingSource: (p: Pane) => CommentSource;
  commentStaging: (p: Pane, at?: number) => void;
}) {
  const { side, inMain, fileRow, files, commit, stash, turn, turnIdx } = sel;
  const { single, paneFile, activePane, hunkMode, anchor, cur, chosenRows, pickLine } = staging;
  const { diffs, unstagedFiles, stagedFiles, unstagedPreview, stagedPreview } = d;
  const { branch, turnShown, shown: shownCommit, shownFiles, shownSource } = shown;
  const { hunkAction } = actions;
  const target = side === "files" ? fileRow : undefined;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {side === "files" && single ? (
        <>
          {diffs?.error && <Note error>{diffs.error}</Note>}
          {diffs?.tooLarge && <Note>The diff is too big to show: stage or discard the whole file from the files panel.</Note>}
          {diffs?.notUtf8 && <Note>{NOT_UTF8}: stage or discard it whole from the files panel.</Note>}
          {(["unstaged", "staged"] as Pane[])
            .filter((p) => (p === "unstaged" ? hasUnstaged : hasStaged)(target!.file!))
            .map((p, k) => {
              const f = paneFile(p);
              const on = p === activePane;
              return (
                <Panel
                  key={p}
                  title={p === "unstaged" ? (target?.file && untracked(target.file) ? "Untracked file" : "Unstaged changes") : "Staged changes"}
                  active={inMain && on}
                  focused={focused}
                  className="flex-1"
                  right={
                    <>
                      {inMain && on && (hunkMode || anchor !== null) && <span className="mr-2 text-accent">{hunkMode ? "hunk" : "range"}</span>}
                      {k === 0 && <LayoutToggle layout={layout} onToggle={toggleLayout} />}
                    </>
                  }
                >
                  {!f ? (
                    // Shown as it is, never as lines to stage.
                    (p === "unstaged" ? unstagedPreview : stagedPreview).length > 0 && <PatchView files={p === "unstaged" ? unstagedPreview : stagedPreview} empty="" layout={layout} />
                  ) : linesStageable(f) ? (
                    <DiffLines
                      file={f}
                      layout={layout}
                      source={stagingSource(p)}
                      cursor={inMain && on ? cur : -1}
                      chosen={inMain && on ? chosenRows : null}
                      pick="changed"
                      onLine={(i, how) => pickLine(p, i, how)}
                      onComment={(i) => commentStaging(p, i)}
                      hunkActions={p === "unstaged" ? ["stage", "discard"] : ["unstage"]}
                      onHunk={(hunk, what) => hunkAction(p, hunk, what)}
                    />
                  ) : (
                    <RawDiff file={f} />
                  )}
                </Panel>
              );
            })}
          {!hasUnstaged(target!.file!) && !hasStaged(target!.file!) && <EmptyMain text="No changes to show" />}
        </>
      ) : (
        <Panel
          title={mainTitle(side, status, fileRow, commit, stash, turn, turnIdx === 0)}
          active={inMain}
          focused={focused}
          className="flex-1"
          scrollRef={mainScroll}
          right={<LayoutToggle layout={layout} onToggle={toggleLayout} />}
        >
          {side === "turns" ? (
            turn ? (
              <TurnView turn={turn} shown={turnShown} layout={layout} />
            ) : (
              <EmptyMain text={turns.data?.available === false ? "" : "No turns with checkpoints yet: one is taken as each of the agent's turns ends"} />
            )
          ) : side === "files" ? (
            fileRow ? (
              diffs && (
                <>
                  {diffs.error && <Note error>{diffs.error}</Note>}
                  {diffs.tooLarge && <Note>Some of the diffs are too big to show.</Note>}
                  {unstagedFiles.length > 0 && <PatchView files={unstagedFiles} head={<Section>Unstaged</Section>} empty="" layout={layout} source={UNSTAGED} />}
                  {unstagedPreview.length > 0 && <PatchView files={unstagedPreview} head={!unstagedFiles.length && <Section>Unstaged</Section>} empty="" layout={layout} />}
                  {stagedFiles.length > 0 && <PatchView files={stagedFiles} head={<Section>Staged</Section>} empty="" layout={layout} source={STAGED} />}
                  {stagedPreview.length > 0 && <PatchView files={stagedPreview} head={!stagedFiles.length && <Section>Staged</Section>} empty="" layout={layout} />}
                </>
              )
            ) : (
              <EmptyMain text={files.length ? "" : "No changes in the working tree"} />
            )
          ) : side === "status" ? (
            <BranchView diff={branch} layout={layout} />
          ) : (side === "commits" ? commit : stash) ? (
            shownCommit ? (
              shownCommit.error ? (
                <Note error>{shownCommit.error}</Note>
              ) : (
                <PatchView
                  files={shownFiles}
                  head={shownCommit.commit && <CommitHead c={shownCommit.commit} />}
                  empty="No changes"
                  layout={layout}
                  source={shownSource}
                />
              )
            ) : null
          ) : (
            <EmptyMain text={side === "commits" ? "No commits" : "No stashes"} />
          )}
        </Panel>
      )}
    </div>
  );
}
