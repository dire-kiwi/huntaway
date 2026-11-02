import { Pin } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Task } from "../../../api";
import { Button, errorText, Input } from "../../ui";
import { Section } from "./details/Section";

export function TitleEditor({ task, onError }: { task: Task; onError: (err: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(task.title);
  // Kept while it's being edited, so a title that changes meanwhile (re-titled from a message, say) doesn't
  // overwrite what's typed.
  useEffect(() => {
    if (!editing) setV(task.title);
  }, [task.title, editing]);
  if (!editing)
    return (
      <>
        <h1 onDoubleClick={() => setEditing(true)} className="no-drag min-w-0 truncate text-[13.5px] font-medium" title="Double-click to rename">
          {task.title}
        </h1>
        {task.title_pinned && (
          <button
            className="no-drag -ml-1 shrink-0 rounded p-0.5 text-faint hover:bg-raised hover:text-fg"
            title="Renamed by hand, so it keeps this title. Click to let the title follow your messages again."
            aria-label="Unpin title"
            onClick={() => {
              onError(null);
              api.updateTask(task.host_id, task.id, { title_pinned: false }).catch((e) => onError(`Couldn't unpin the title: ${errorText(e)}`));
            }}
          >
            <Pin size={12} />
          </button>
        )}
      </>
    );
  const save = () => {
    setEditing(false);
    const typed = v;
    if (!typed.trim() || typed === task.title) return;
    onError(null);
    api.updateTask(task.host_id, task.id, { title: typed.trim() }).catch((e) => {
      // Back to editing what was typed, to try again.
      setV(typed);
      setEditing(true);
      onError(`Couldn't rename the task: ${errorText(e)}`);
    });
  };
  return (
    <Input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") setEditing(false);
      }}
      className="no-drag h-7 max-w-md"
    />
  );
}

/** The task's title in its details, to rename by hand, and whether it follows the task's messages. */
export function TitleSection({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Kept while it's being edited, as in the header's editor.
  useEffect(() => {
    if (!editing) setV(task.title);
  }, [task.title, editing]);
  const save = () => {
    const typed = v.trim();
    if (!typed || busy) return;
    if (typed === task.title) return setEditing(false);
    setBusy(true);
    setErr(null);
    api
      .updateTask(task.host_id, task.id, { title: typed })
      .then(() => setEditing(false))
      .catch((e) => setErr(`Couldn't rename the task: ${errorText(e)}`))
      .finally(() => setBusy(false));
  };
  const unpin = () => {
    setErr(null);
    api.updateTask(task.host_id, task.id, { title_pinned: false }).catch((e) => setErr(`Couldn't unpin the title: ${errorText(e)}`));
  };
  return (
    <Section
      title="Title"
      right={
        !editing && (
          <button className="text-[11.5px] text-faint hover:text-fg" aria-label="Edit title" onClick={() => (setV(task.title), setErr(null), setEditing(true))}>
            Edit
          </button>
        )
      }
    >
      {editing ? (
        <div className="space-y-2" data-draft={v !== task.title || undefined}>
          <Input
            autoFocus
            aria-label="Title"
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), save());
              if (e.key === "Escape") (e.stopPropagation(), setEditing(false));
            }}
          />
          {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => (setErr(null), setEditing(false))}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !v.trim()} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-[13px] break-words text-fg">{task.title}</div>
          {task.title_pinned && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-faint">
              <Pin size={11} className="shrink-0" />
              <span className="min-w-0 flex-1">Set by hand, so it doesn't follow your messages.</span>
              <button className="shrink-0 hover:text-fg" onClick={unpin}>
                Unpin
              </button>
            </div>
          )}
          {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
        </>
      )}
    </Section>
  );
}
