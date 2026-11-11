import { clsx } from "clsx"
import { Plus, Trash2 } from "lucide-react"
import { useState, type ReactNode } from "react"
import type { ProjectAgentTools as AgentTools, Skill } from "@huntaway/contracts"
import { Button, errorText, Field, Modal, ModalFooter, SUBMIT_KEYS, Textarea, Toggle } from "../../ui"
import { Section, OtherList } from "./parts"

const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does, and when Claude should use it.
---

# My skill

Instructions for Claude to follow when it uses this skill.
`

export function SkillsSection({
  tools,
  shared,
  seenSkills,
  lastSeen,
  onToggleOther,
  onToggle,
  onDelete,
  onSave,
}: {
  tools: AgentTools
  /** The project's switches for global ones. */
  shared: ReactNode
  seenSkills: string[]
  lastSeen?: string | undefined
  onToggleOther: (name: string, on: boolean) => void
  onToggle: (s: Skill, enabled: boolean) => void
  onDelete: (s: Skill) => void
  onSave: (skill: Skill | null, content: string) => Promise<void>
}) {
  const [editing, setEditing] = useState<Skill | "new" | null>(null)
  const own = new Set(tools.skills.map((s) => s.name))
  return (
    <Section
      title="Skills"
      action={
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> New skill
        </Button>
      }
      hint="This project's own skills, kept on its host rather than in the repository. Global ones (Settings → Skills and MCP servers) follow the profile's default unless you switch them here. Changes apply from each thread's next message."
    >
      {tools.skills.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {tools.skills.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2">
              <Toggle checked={s.enabled} onChange={(v) => onToggle(s, v)} label="" />
              <div className="min-w-0 flex-1">
                <div className={clsx("font-mono text-[12.5px]", !s.enabled && "text-faint")}>{s.name}</div>
                <div className="truncate text-[11.5px] text-faint">{s.description}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(s)} title="Delete">
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {shared}
      <OtherList
        label="Skills"
        items={seenSkills.filter((n) => !own.has(n)).map((name) => ({ name }))}
        disabled={tools.disabled_skills}
        lastSeen={lastSeen}
        placeholder="pdf"
        onToggle={onToggleOther}
      />
      {editing && <SkillEditor skill={editing === "new" ? null : editing} onSave={onSave} onClose={() => setEditing(null)} />}
    </Section>
  )
}

export function SkillEditor({
  skill,
  onSave,
  onClose,
}: {
  skill: Skill | null
  onSave: (skill: Skill | null, content: string) => Promise<void>
  onClose: () => void
}) {
  const [content, setContent] = useState(skill?.content ?? SKILL_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      await onSave(skill, content)
      onClose()
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Modal title={skill ? `Edit ${skill.name}` : "New skill"} onClose={onClose} onSubmit={() => void save()} width="max-w-3xl">
      <div className="space-y-3">
        <Field
          label="SKILL.md"
          hint={
            <>
              The frontmatter's <code>name</code> (lowercase letters, numbers and hyphens) names the skill, and Claude reads its <code>description</code> to
              decide when to use it. Other frontmatter, such as <code>allowed-tools</code>, works as in any skill.
            </>
          }
        >
          <Textarea rows={20} className="font-mono text-[12px]" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} autoFocus />
        </Field>
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-faint">{SUBMIT_KEYS} to save</span>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {skill ? "Save skill" : "Add skill"}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
