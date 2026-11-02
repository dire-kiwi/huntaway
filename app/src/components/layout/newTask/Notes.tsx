import clsx from "clsx";
import type { Blocks } from "./blocks";
import type { Tokens } from "./useTokens";
import type { Opened, Origin, Where } from "./useWhere";
import { labelList } from "./words";

/** What the task's agent does where it goes, how many tasks it makes, and what stops it being created. */
export function Notes({
  opened: { projects, subproject, scratch },
  origin: { hosts },
  where: { asGroup, noProject, inProject, host },
  tok: { docType, taskType, labelling, labels, asSubproject, fanout, many, runs, pending, noun },
  worktree,
  blocks: { labelBlock, fanoutBlock, modelsBlock, modelsLoading },
  whenLoaded,
}: {
  opened: Opened;
  origin: Origin;
  where: Where;
  tok: Tokens;
  worktree: boolean;
  blocks: Blocks;
  whenLoaded: boolean;
}) {
  const hostCount = hosts.length;
  return (
    <>
      {asGroup && !docType && (
        <div className="text-[12px] text-muted">
          In no project: it shows on this group's board, and its agent breaks the work into tasks in{" "}
          {projects?.map((p) => p.name).join(", ")} and follows them. It doesn't change the repositories itself.
        </div>
      )}
      {noProject && (
        <div className="text-[12px] text-muted">
          In no project: it shows on the {scratch!.name} board{hostCount > 1 ? ` and runs on ${host?.name}` : ""}. Its agent works in the task's own folder, with
          no repository, and can look across the board and create and start tasks.
        </div>
      )}
      {taskType === "scratch" && inProject && (
        <div className="text-[12px] text-muted">
          Its agent works in the task's own folder and reads{" "}
          {subproject ? "the repository and the subproject's worktree without changing them" : "the repository without changing it"}, and can look across the
          board and create and start tasks{subproject ? " (in the subproject)" : ""}. There's no worktree, review or merge.
        </div>
      )}
      {labelling && labels.length > 0 && (
        <div className="text-[12px] text-muted">
          Besides its other work, its agent writes {labelList(labels)} in the task's own folder, each shown in a tab of the task.
          {labels.includes("plan") && " It writes the plan first, for you to agree on before it starts the work."}
        </div>
      )}
      {docType && (
        <div className="text-[12px] text-muted">
          {asGroup
            ? `In no project: it shows on this group's board, and its agent reads ${projects?.map((p) => p.name).join(", ")} as it writes the ${docType}.`
            : `Its agent reads the repository and writes the ${docType} in the task's own folder, without changing the code.`}{" "}
          The task shows it as it's written; reply in the task to iterate on it.
        </div>
      )}
      {(asSubproject || (subproject && taskType === null)) && (
        <div className="text-[12px] text-muted">
          {subproject
            ? `Branches from ${subproject.branch ?? "the subproject's branch"} and merges back into it.`
            : "It gets its own worktree and thread, and a board of tasks: each branches from the subproject's branch and merges back into it, and the subproject is merged as a whole through its own pull request."}
        </div>
      )}
      {labelBlock && <div className="text-[12px] text-amber-300">{labelBlock}</div>}
      {fanout && (
        <div className={clsx("text-[12px]", fanoutBlock ? "text-amber-300" : "text-muted")}>
          {fanoutBlock ??
            (many
              ? `Makes ${runs.length} ${noun}s from this prompt, one with each model${worktree ? ", each in its own worktree" : ""}${pending ? `, with ${pending.made.join(", ")}` : ", so you can compare what they do"}. Their cards say which is which.`
              : `Makes the ${noun} left from this prompt, with ${pending!.made.join(", ")}${worktree ? ", in its own worktree" : ""}. Their cards say which is which.`)}
        </div>
      )}
      {modelsBlock && (
        <div className={clsx("text-[12px]", modelsLoading ? "text-muted" : "text-amber-300")}>
          {modelsBlock}
          {whenLoaded && " It's created once they're in."}
        </div>
      )}
    </>
  );
}
