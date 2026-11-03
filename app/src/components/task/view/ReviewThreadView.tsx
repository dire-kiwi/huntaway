import clsx from "clsx";
import { ChevronLeft, ChevronRight, GitBranch, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, isSummaryThread, type Task } from "../../../api";
import { navigate, openTask } from "../../../router";
import { useProject, useStore } from "../../../store";
import { AgentsPill } from "../../layout/AgentsPill";
import { ContextPill } from "../Context";
import { ChangeSummaryView, reviewParts, ReviewSummary } from "../Review";
import { Thread } from "../Thread";
import { Button, cost, IconButton } from "../../ui";
import { PanelButtons, useWide, type Mode } from "./layout";
import { Row, Section } from "./details/Section";

const NO_REVIEW = <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">No review has run yet.</div>;
const NO_SUMMARY = <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">No summary has been written yet.</div>;

/** A review thread: the reviewer's conversation, beside the review it's working on. */
export function ReviewThreadView({ thread, mode }: { thread: Task; mode: Mode }) {
  const parent = useStore((s) => (thread.parent_id ? s.tasks[thread.parent_id] : undefined));
  const project = useProject(thread.project_id);
  const [rootRef, wide] = useWide();
  const key = parent && `${project?.key ?? "T"}-${parent.number}`;
  // Which of the task's reviewers this is, when it has several. A summary thread summarises its changes instead (API 84).
  const reviewer = parent?.review && reviewParts(parent.review).find((p) => p.thread_id === thread.id)?.label;
  const summary = isSummaryThread(thread);
  const back = () => (parent ? openTask(parent.id) : project ? navigate({ name: "board", projectId: project.id }) : history.back());
  const [stopErr, setStopErr] = useState<string | null>(null);
  useEffect(() => setStopErr(null), [thread.id]);
  const stop = () => {
    setStopErr(null);
    api.stop(thread.host_id, thread.id).catch((e) => setStopErr(`Couldn't stop the reviewer: ${(e as Error).message}`));
  };
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className={clsx("flex h-12 shrink-0 items-center gap-2 border-b border-line px-3", mode === "page" && "drag")}>
        <IconButton className="no-drag narrow:-ml-1.5" title="Back" onClick={back}>
          <ChevronLeft size={16} />
        </IconButton>
        <button className="no-drag shrink-0 text-[12.5px] text-muted hover:text-fg narrow:hidden" onClick={() => project && navigate({ name: "board", projectId: project.id })}>
          {project?.name}
        </button>
        <ChevronRight size={12} className="shrink-0 text-faint narrow:hidden" />
        {parent && (
          <>
            <button className="no-drag shrink-0 font-mono text-[12px] text-faint hover:text-fg" onClick={back}>
              {key}
            </button>
            <ChevronRight size={12} className="shrink-0 text-faint" />
          </>
        )}
        <h1 className="min-w-0 truncate text-[13.5px] font-medium">
          {summary ? (
            "Summary"
          ) : (
            <>Review{reviewer && parent?.review?.reviewers && parent.review.reviewers.length > 1 && <span className="font-normal text-muted"> · {reviewer}</span>}</>
          )}
        </h1>
        <div className="no-drag ml-auto flex items-center gap-2">
          <AgentsPill task={thread} />
          <ContextPill task={thread} />
          {thread.running && (
            <Button size="sm" onClick={stop}>
              <Square size={11} fill="currentColor" /> Stop
            </Button>
          )}
          {mode !== "page" && <PanelButtons expanded={mode === "expanded"} />}
        </div>
      </header>
      {stopErr && (
        <div className="flex shrink-0 items-start gap-1 border-b border-line px-3 py-2 text-[11.5px] text-red-400">
          <span className="min-w-0 flex-1">{stopErr}</span>
          <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setStopErr(null)}>
            <X size={12} />
          </IconButton>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          <Thread
            key={`${thread.host_id}:${thread.id}`}
            task={thread}
            cwd={parent?.worktree_path ?? project?.repo_path}
            placeholder={summary ? "Ask about the changes…" : "Ask the reviewer about its findings…"}
            empty={summary ? NO_SUMMARY : NO_REVIEW}
          />
        </main>
        {parent && wide && (
          <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-panel/40">
            <Section title={summary ? "Summarising" : "Reviewing"}>
              <button className="text-left text-[13px] text-fg hover:underline" onClick={back}>
                <span className="mr-1.5 font-mono text-[12px] text-faint">{key}</span>
                {parent.title}
              </button>
              {parent.branch && (
                <div className="mt-1.5 flex items-center gap-1 font-mono text-[11.5px] text-muted">
                  <GitBranch size={11} className="shrink-0" />
                  <span className="truncate">{parent.branch}</span>
                </div>
              )}
            </Section>
            {summary ? (
              <Section title="Latest summary">
                <ChangeSummaryView task={parent} threadId={thread.id} />
              </Section>
            ) : (
              <Section title="Latest review">
                <ReviewSummary task={parent} threadId={thread.id} />
              </Section>
            )}
            <Section title={summary ? "Summarizer" : "Reviewer"}>
              <Row label="Cost">{cost(thread.cost_usd) ?? "—"}</Row>
              <Row label="Session">{thread.session_id ? <span className="font-mono text-[11px]">{thread.session_id}</span> : "—"}</Row>
            </Section>
          </aside>
        )}
      </div>
    </div>
  );
}
