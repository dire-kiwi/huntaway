import { clsx } from "clsx"
import { ChevronDown, ChevronRight, GitBranch, RefreshCw, Trash2 } from "lucide-react"
import { useState, type ReactNode } from "react"
import type { Skill, SkillSource } from "@huntaway/contracts"
import { Button, errorText, Field, Input, Modal, ModalFooter, SUBMIT_KEYS, timeAgo } from "../../ui"

/** A git repository whose skills are offered on the host, with its skills and who has them on by default. */
export function SourceCard({
  source,
  skills,
  profiles,
  isOn,
  updating,
  renderSkill,
  onSwitchAll,
  onUpdate,
  onRemove,
}: {
  source: SkillSource
  skills: ReadonlyArray<Skill>
  profiles: ReadonlyArray<{ id: string; name: string }>
  isOn: (profileId: string, id: string) => boolean
  updating: boolean
  renderSkill: (s: Skill) => ReactNode
  onSwitchAll: (profileId: string, on: boolean) => void
  onUpdate: () => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(skills.length <= 6)
  return (
    <div className="rounded-xl border border-line">
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
            {open ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[12.5px] font-medium">
                <GitBranch size={12} className="shrink-0 text-faint" />
                <span className="truncate">{source.name}</span>
                <span className="shrink-0 text-[11.5px] font-normal text-faint">
                  {skills.length} skill{skills.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="truncate font-mono text-[11.5px] text-faint">{source.url}</div>
              <div className="truncate text-[11.5px] text-faint">
                {[
                  source.ref && `branch ${source.ref}`,
                  source.subdir && `folder ${source.subdir}`,
                  source.commit && `commit ${source.commit.slice(0, 7)}`,
                  source.synced_at && `updated ${timeAgo(source.synced_at)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </button>
          <Button size="sm" variant="ghost" onClick={onUpdate} disabled={updating} title="Clone the repository again and bring its skills up to date">
            <RefreshCw size={13} className={clsx(updating && "animate-spin")} /> {updating ? "Updating…" : "Update"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove} title="Remove the source and its skills">
            <Trash2 size={13} />
          </Button>
        </div>
        {source.error && <div className="text-[11.5px] text-red-400">The last update failed, so these skills are as they were: {source.error}</div>}
        {source.notes.length > 0 && (
          <details className="text-[11.5px] text-faint">
            <summary className="cursor-pointer">
              {source.notes.length} thing{source.notes.length === 1 ? "" : "s"} in the repository left out
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {source.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
        {profiles.length > 0 && skills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
            All skills on by default in
            {profiles.map((p) => {
              const count = skills.filter((s) => isOn(p.id, s.id)).length
              const all = count === skills.length
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSwitchAll(p.id, !all)}
                  className={clsx(
                    "rounded-full border px-2 py-0.5 transition-colors",
                    all ? "border-accent/50 bg-accent/15 text-fg" : count ? "border-accent/30 text-muted" : "border-line text-faint hover:text-muted",
                  )}
                  title={
                    all
                      ? `All on by default in ${p.name}'s projects. Click to turn them all off.`
                      : `${count} of ${skills.length} on in ${p.name}. Click to turn them all on.`
                  }
                >
                  {p.name}
                  {count > 0 && !all ? ` (${count})` : ""}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {open && <div className="divide-y divide-line/70 border-t border-line/70">{skills.map(renderSkill)}</div>}
    </div>
  )
}

export function SourceAdder({ onAdd, onClose }: { onAdd: (url: string, ref: string, subdir: string) => Promise<void>; onClose: () => void }) {
  const [url, setUrl] = useState("")
  const [ref, setRef] = useState("")
  const [subdir, setSubdir] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const add = async () => {
    if (!url.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      await onAdd(url.trim(), ref.trim(), subdir.trim())
      onClose()
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Modal title="Add skills from a git repository" onClose={busy ? () => {} : onClose} onSubmit={() => void add()} width="max-w-xl">
      <div className="space-y-3">
        <Field
          label="Repository"
          hint={
            <>
              A git URL, or <code>owner/repo</code> for GitHub, as in <code>npx skills add</code>. It's cloned on this host with its git setup, so a private
              repository needs credentials there. Every folder with a <code>SKILL.md</code> in it becomes a skill, off until you switch it on. Skills are
              instructions (and scripts) your agents follow, so only add repositories you trust.
            </>
          }
        >
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="danyuchn/asd-ste100-skill" autoFocus spellCheck={false} disabled={busy} />
        </Field>
        <Field label="Branch or tag (optional)" hint="The repository's default branch if left empty.">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" spellCheck={false} disabled={busy} />
        </Field>
        <Field
          label="Subfolder (optional)"
          hint="Only the skills in this folder of the repository, for one that has several sets, such as a language each. The whole repository if left empty."
        >
          <Input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="skills/en" spellCheck={false} disabled={busy} />
        </Field>
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-faint">{busy ? "Cloning…" : `${SUBMIT_KEYS} to add`}</span>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !url.trim()} onClick={() => void add()}>
              {busy ? "Adding…" : "Add skills"}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
