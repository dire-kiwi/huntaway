import type { SkillId } from "@huntaway/contracts"
import type { SkillRow } from "./effective.ts"
import type { Found } from "./files.ts"

// What a fresh clone of a skill source does to its skills (huntaway's agent/agent_tools/sources.ts `apply_in`), worked
// out as a plan that `AgentToolsRepo.applySource` carries out in one transaction: new ones added (off everywhere), the
// ones that stay updated with their ids (and so their switches), the ones that went removed.

export interface SourcePlan {
  /** What was left out: the clone's own notes, then names another global skill has. */
  readonly notes: ReadonlyArray<string>
  /** Skills of the source that are gone, or left out. */
  readonly remove: ReadonlyArray<SkillId>
  /** Skills that change name: given a temporary name first, so that they can swap names or pass them along. */
  readonly rename: ReadonlyArray<SkillId>
  readonly update: ReadonlyArray<{ readonly id: SkillId; readonly found: Found }>
  readonly insert: ReadonlyArray<Found>
  /** The names runs may have reported that no skill of the source has now (`forget` them once all is settled). */
  readonly forget: ReadonlyArray<string>
}

/** The name a skill has between the two steps of a rename. */
export const renaming = (id: string): string => `\u0000renaming ${id}`

/**
 * The plan for `found` (from `discover`, each with a name of its own) over the source's skills as they are
 * (`existing`). `taken` says whether a skill that isn't from this source has a name: the found one is left out then.
 * Each found skill is the existing one at its path, else (the folder was moved) the one with its name that no found
 * skill is at the path of.
 */
export const planSource = (
  existing: ReadonlyArray<SkillRow>,
  found: ReadonlyArray<Found>,
  notesIn: ReadonlyArray<string>,
  taken: (name: string) => boolean,
): SourcePlan => {
  const notes = [...notesIn]
  const matched: Array<SkillRow | null> = found.map(
    (f) => existing.find((s) => s.source_path === f.path) ?? existing.find((s) => s.name === f.name && !found.some((o) => s.source_path === o.path)) ?? null,
  )
  const keep = found.map((f) => {
    if (!taken(f.name)) return true
    notes.push(`${f.path === "" ? "the repository's root" : f.path}: a skill named ${f.name} is already on this host`)
    return false
  })
  const used = (s: SkillRow) => found.some((_, i) => keep[i] === true && matched[i]?.id === s.id)
  const gone = existing.filter((s) => !used(s))
  const rename: Array<SkillRow> = []
  const update: Array<{ readonly id: SkillId; readonly found: Found }> = []
  const insert: Array<Found> = []
  found.forEach((f, i) => {
    if (keep[i] !== true) return
    const m = matched[i] ?? null
    if (m === null) insert.push(f)
    else {
      if (m.name !== f.name) rename.push(m)
      update.push({ id: m.id, found: f })
    }
  })
  return {
    notes,
    remove: gone.map((s) => s.id),
    rename: rename.map((s) => s.id),
    update,
    insert,
    forget: [...gone.map((s) => s.name), ...rename.map((s) => s.name)],
  }
}
