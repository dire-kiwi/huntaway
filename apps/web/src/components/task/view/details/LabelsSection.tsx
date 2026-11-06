import clsx from "clsx";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { api, documentsOnly, hostSupports, LABELS, LABELS_API, taskLabels, type DocumentType, type Task } from "../../../../api";
import { isGroupTask, useHost } from "../../../../store";
import { documentInfo, LABEL_INFO } from "../../Document";
import { Row, Section } from "./Section";

/** A task's labels, each a document its agent writes besides its other work, shown in a tab of the task: to add and
 *  take off (API 71), and where the agent writes them. */
export function LabelsSection({ task }: { task: Task }) {
  const host = useHost(task.host_id);
  const labels = taskLabels(task);
  // On an older host they're the task's type, which stays.
  const editable = hostSupports(host, LABELS_API);
  const docsOnly = documentsOnly(task);
  const [err, setErr] = useState<string | null>(null);
  const [files, setFiles] = useState<Partial<Record<DocumentType, string>>>({});
  const shown = labels.join(",");
  useEffect(() => {
    let live = true;
    for (const l of shown ? (shown.split(",") as DocumentType[]) : [])
      api
        .document(task.host_id, task.id, l)
        .then((d) => live && d.file && setFiles((f) => ({ ...f, [l]: d.file! })))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.host_id, task.id, shown]);
  const toggle = (l: DocumentType) => {
    setErr(null);
    const next = labels.includes(l) ? labels.filter((x) => x !== l) : LABELS.filter((x) => x === l || labels.includes(x));
    api.updateTask(task.host_id, task.id, { labels: next }).catch((e) => setErr(`Couldn't change the labels: ${(e as Error).message}`));
  };
  const where = isGroupTask(task) ? "group's repositories" : "project's repository";
  return (
    <Section title="Labels">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {(editable ? LABEL_INFO : LABEL_INFO.filter((i) => labels.includes(i.id))).map((i) => {
            const on = labels.includes(i.id);
            return (
              <button
                key={i.id}
                disabled={!editable}
                onClick={() => toggle(i.id)}
                aria-pressed={on}
                title={editable ? `${on ? "Take off" : "Add"} the ${i.label.toLowerCase()} label: ${i.hint}` : i.hint}
                className={clsx(
                  "flex h-6 items-center gap-1 rounded-md border px-2 text-[12px]",
                  on ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg",
                  !editable && "cursor-default",
                )}
              >
                {i.icon} {i.label}
              </button>
            );
          })}
        </div>
        <div className="text-[12.5px] text-muted">
          {docsOnly
            ? `Rather than changing code, its agent writes ${labels.length ? "a document for each label" : "a document for each label it's given"} in the task's own folder, reading the ${where}.`
            : labels.length
              ? "Besides its other work, its agent writes a document for each label in the task's own folder, shown in a tab here."
              : "A label has its agent write a document besides its other work: a plan to agree on first, an artifact or a diagram, each shown in a tab here."}{" "}
          {labels.length > 0 && "The board keeps a version from each turn."}
          {editable && task.running && " A label changed while its agent works reaches it the next time it starts."}
        </div>
        {labels.map(
          (l) =>
            files[l] && (
              <Row key={l} label={documentInfo(l).label}>
                <span className="group flex items-start gap-1 font-mono text-[11px]">
                  <span className="break-all">{files[l]}</span>
                  <button className="shrink-0 text-faint hover:text-fg" onClick={() => navigator.clipboard?.writeText(files[l]!)} title="Copy path">
                    <Copy size={11} />
                  </button>
                </span>
              </Row>
            ),
        )}
        {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      </div>
    </Section>
  );
}
