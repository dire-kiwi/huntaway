import { clsx } from "clsx"
import { Check } from "lucide-react"
import { Input } from "../../ui"
import { ALSO_IN_MAX, type Options } from "./useOptions"
import type { Where } from "./useWhere"

/**
 * The other projects it's made in too, as a set across repositories (HE-120): a task in each, on one branch, the one
 * made here the lead, whose agent works in all of them. Each is a button to pick or unpick, seven at most; the set's
 * title (which names its tasks, branch and pen) is asked for once one is picked.
 */
export function AlsoIn({ where: { inProject }, options, pen }: { where: Where; options: Options; pen?: string | undefined }) {
  const { alsoInOpen, setProjects, alsoIn, toggleAlsoIn, alsoInTitle, setAlsoInTitle } = options
  if (!alsoInOpen || !inProject) return null
  const full = alsoIn.length >= ALSO_IN_MAX
  const picked = setProjects.filter((p) => alsoIn.includes(p.id))
  return (
    <div className="space-y-2 rounded-md border border-line bg-panel px-2.5 py-2" role="group" aria-label="Also in">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] text-muted">Also in</span>
        {setProjects.map((p) => {
          const on = alsoIn.includes(p.id)
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              title={!on && full ? `A set takes ${ALSO_IN_MAX} other projects at most` : p.repo_path}
              onClick={() => toggleAlsoIn(p.id)}
              className={clsx(
                "inline-flex h-6 max-w-56 items-center gap-1 rounded-md border px-1.5 text-[12px] disabled:opacity-40",
                on ? "border-accent/50 bg-accent/15 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {on && <Check size={11} className="shrink-0 text-accent" />}
              <span className="shrink-0 font-mono text-[11px] text-faint">{p.key}</span>
              <span className="truncate">{p.name}</span>
            </button>
          )
        })}
      </div>
      {picked.length > 0 && (
        <>
          <Input
            value={alsoInTitle}
            onChange={(e) => setAlsoInTitle(e.target.value)}
            placeholder="The set's title"
            aria-label="Set title"
            className="h-7 text-[12.5px]"
          />
          <div className="text-[12px] text-muted">
            Makes a task in {inProject.name} and in {picked.map((p) => p.name).join(", ")}, with this title and description, all on one branch and in{" "}
            {pen ? `the ${pen} pen` : "a pen named after it"}. This one leads: only its agent starts, and it works in all of their worktrees.
          </div>
        </>
      )}
    </div>
  )
}
