import clsx from "clsx";
import type { ReactNode } from "react";
import type { GitStatus } from "../../../api";
import { hasUnstaged } from "../diffs";
import { turnLabel, turnStat, type useTurns } from "../../task/turns";
import type { MenuItem } from "../../ui";
import { FilesList, List, Panel } from "./Panels";
import type { GitActions } from "./useGitActions";
import type { GitSelection } from "./useGitSelection";
import { ago, rowPath, short, SIDE_TITLES, toggled, type Side } from "./model";

/** The panels down the left of the Changes tab: the branch (Status), the changed files, the commits, the stashes and the agent's turns. */
export function SidePanels({
  status,
  sides,
  sel,
  actions,
  turns,
  focused,
  narrow,
  focusSide,
  setMenu,
}: {
  status: GitStatus;
  sides: Side[];
  sel: GitSelection;
  actions: GitActions;
  turns: ReturnType<typeof useTurns>;
  focused: boolean;
  /** The narrow layout: the panels above the main one rather than beside it. */
  narrow: boolean;
  focusSide: (s: Side) => void;
  setMenu: (m: { x: number; y: number; title: string; items: MenuItem[] }) => void;
}) {
  const {
    side,
    inMain,
    setInMain,
    rows,
    fileIdx,
    setFileKey,
    collapsed,
    setCollapsed,
    files,
    commits,
    commitIdx,
    setCommitSha,
    stashes,
    stashIdx,
    setStashSha,
    turnList,
    turnIdx,
    setTurnN,
  } = sel;
  const { toggleRow, discardRow, copy, resetMenu, reword, stashDo, rewindTo } = actions;
  const repoName = status.dir?.split("/").filter(Boolean).at(-1) ?? "";
  const branchCommits = commits.filter((c) => c.on_branch).length;
  const sidePanel = (s: Side, n: number, body: ReactNode, extra?: { grow?: string; right?: ReactNode }) => (
    <Panel
      title={`[${n}] ${SIDE_TITLES[s]}`}
      active={side === s && !inMain}
      focused={focused}
      className={extra?.grow}
      right={extra?.right}
      onMouseDown={() => {
        if (side !== s || inMain) focusSide(s);
      }}
    >
      {body}
    </Panel>
  );
  const grow = (s: Side, on: string, off: string) => (side === s ? on : off);

  return (
    <div className={clsx("flex min-h-0 flex-col gap-3", narrow ? "h-[46%] shrink-0" : "w-[34%] max-w-[440px] min-w-[230px] shrink-0")}>
      {sidePanel(
        "status",
        1,
        <div className="px-1.5" title={status.dir}>
          <div className="truncate">
            <span className="text-emerald-400">{repoName}</span>
            <span className="text-faint"> → </span>
            <span className="text-fg">{status.branch ?? (status.head ? `(detached ${short(status.head)})` : "(no commits)")}</span>
          </div>
          <div className="truncate text-faint">
            {status.base ? `${branchCommits} commit${branchCommits === 1 ? "" : "s"} since ${status.base}` : "No base branch"}
            {status.upstream ? ` · ↑${status.ahead}↓${status.behind} ${status.upstream}` : " · no upstream"}
          </div>
        </div>,
        { grow: "shrink-0" },
      )}
      {sidePanel(
        "files",
        2,
        <FilesList
          rows={rows}
          selected={fileIdx}
          active={side === "files"}
          collapsed={collapsed}
          onSelect={(r) => {
            setFileKey(r.key);
            if (side !== "files" || inMain) focusSide("files");
          }}
          onOpen={(r) => {
            setFileKey(r.key);
            if (!r.file) setCollapsed((c) => toggled(c, r.key));
            else setInMain(true);
          }}
          onToggle={toggleRow}
          onMenu={(r, x, y) => {
            setFileKey(r.key);
            setMenu({
              x,
              y,
              title: rowPath(r),
              items: [
                { label: r.files.some(hasUnstaged) ? "Stage" : "Unstage", onSelect: () => toggleRow(r) },
                { label: "Discard…", onSelect: () => discardRow(r) },
                { label: "Copy path", divider: true, onSelect: () => copy(rowPath(r)) },
              ],
            });
          }}
          empty={status.truncated ? "" : "No changes"}
        />,
        {
          grow: grow("files", "flex-[3]", "flex-[2]"),
          right: status.truncated ? <span className="text-amber-300">first {files.length}</span> : files.length ? <span>{files.length}</span> : null,
        },
      )}
      {sidePanel(
        "commits",
        3,
        <List
          items={commits}
          selected={commitIdx}
          active={side === "commits"}
          empty="No commits"
          onSelect={(c) => {
            setCommitSha(c.sha);
            if (side !== "commits" || inMain) focusSide("commits");
          }}
          onOpen={() => setInMain(true)}
          onMenu={(c, x, y) => {
            setCommitSha(c.sha);
            setMenu({
              x,
              y,
              title: `${short(c.sha)} ${c.subject}`,
              items: [
                { label: "Reset to here…", onSelect: () => resetMenu(c) },
                ...(c.sha === status.head ? [{ label: "Reword…", onSelect: () => reword(c) }] : []),
                { label: "Copy hash", divider: true, onSelect: () => copy(c.sha) },
              ],
            });
          }}
          render={(c, i) => (
            <div
              className={clsx("flex gap-2 px-1.5", status.merge_base && !c.on_branch && i > 0 && commits[i - 1].on_branch && "border-t border-line")}
              title={`${c.subject}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}`}
            >
              <span className={clsx("shrink-0", c.unpushed ? "text-red-400" : status.merge_base && !c.on_branch ? "text-emerald-500" : "text-amber-300")}>
                {short(c.sha)}
              </span>
              <span className={clsx("min-w-0 flex-1 truncate", status.merge_base && !c.on_branch ? "text-faint" : "text-fg")}>{c.subject}</span>
              <span className="shrink-0 text-faint">{ago(c.time)}</span>
            </div>
          )}
        />,
        { grow: grow("commits", "flex-[3]", "flex-[1.4]") },
      )}
      {sidePanel(
        "stash",
        4,
        <List
          items={stashes}
          selected={stashIdx}
          active={side === "stash"}
          empty="No stashes"
          onSelect={(s) => {
            setStashSha(s.sha);
            if (side !== "stash" || inMain) focusSide("stash");
          }}
          onOpen={() => setInMain(true)}
          onMenu={(s, x, y) => {
            setStashSha(s.sha);
            setMenu({
              x,
              y,
              title: `stash@{${s.index}}`,
              items: [
                { label: "Apply", onSelect: () => stashDo("apply", s) },
                { label: "Pop…", onSelect: () => stashDo("pop", s) },
                { label: "Drop…", onSelect: () => stashDo("drop", s) },
              ],
            });
          }}
          render={(s) => (
            <div className="flex gap-2 px-1.5" title={s.subject}>
              <span className="shrink-0 text-faint">{s.index}</span>
              <span className="min-w-0 flex-1 truncate">{s.subject}</span>
              <span className="shrink-0 text-faint">{ago(s.time)}</span>
            </div>
          )}
        />,
        { grow: grow("stash", "flex-[1.6] min-h-[60px]", "flex-[0.6] min-h-[44px]") },
      )}
      {sides.includes("turns") &&
        sidePanel(
          "turns",
          5,
          <List
            items={turnList}
            selected={turnIdx}
            active={side === "turns"}
            empty={
              turns.error ? `Couldn't load: ${turns.error}` : turns.data && !turns.data.available ? `No checkpoints: ${turns.data.reason}` : "No turns yet"
            }
            onSelect={(t) => {
              setTurnN(t.n);
              if (side !== "turns" || inMain) focusSide("turns");
            }}
            onOpen={() => setInMain(true)}
            onMenu={(t, x, y) => {
              setTurnN(t.n);
              setMenu({
                x,
                y,
                title: `Turn ${t.turn}`,
                items: [
                  { label: "Rewind to before it…", onSelect: () => rewindTo(t) },
                  { label: "Copy the message", divider: true, onSelect: () => copy(t.text) },
                ],
              });
            }}
            render={(t, i) => (
              <div
                className={clsx("flex gap-2 px-1.5", t.stale && "opacity-50")}
                title={`Turn ${t.turn}: ${t.text}\n${turnStat(t)}${t.stale ? "\nRewound: a rewind went back to before it" : ""}`}
              >
                <span className={clsx("shrink-0", t.review_round ? "text-st-review" : "text-amber-300")}>#{t.turn}</span>
                <span className={clsx("min-w-0 flex-1 truncate", t.auto ? "text-muted" : "text-fg", t.stale && "line-through")}>
                  {i === 0 && !t.stale && <span className="text-accent">latest · </span>}
                  {turnLabel(t)}
                </span>
                {t.stats && t.stats.files > 0 && (
                  <span className="shrink-0">
                    <span className="text-emerald-400">+{t.stats.additions}</span> <span className="text-red-400">−{t.stats.deletions}</span>
                  </span>
                )}
                <span className="shrink-0 text-faint">{ago(Date.parse(t.at) / 1000)}</span>
              </div>
            )}
          />,
          { grow: grow("turns", "flex-[3] min-h-[60px]", "flex-[1.2] min-h-[44px]"), right: turnList.length ? <span>{turnList.length}</span> : null },
        )}
    </div>
  );
}
