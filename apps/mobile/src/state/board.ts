import { useAtomValue } from "@effect/atom-react"
import { type Board, boardAtom, type HostProject } from "@huntaway/client"
import { Atom } from "effect/reactivity"
import { load, save } from "./storage"
import { registry } from "./registry"

// The board as the screens read it (the web app's state/board.ts), and the profile the app shows: profiles are merged
// by name across the board's hosts, as on the web, and the one picked is kept by name.

/** Reads the board; the component draws again only when what `selector` picks changes. */
export function useBoard<T>(selector: (b: Board) => T): T {
  return useAtomValue(boardAtom, selector)
}

const PROFILE_KEY = "huntaway.profile"

/** The profile picked, by name; null until one is. */
export const pickedProfileAtom: Atom.Writable<string | null> = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/** The names of the board's profiles, in the board's order, each once (pure). */
export const profileNames = (b: Pick<Board, "profiles">): ReadonlyArray<string> => [...new Set(b.profiles.map((p) => p.name))]

/** The profile shown: the one picked if the board has it, else its first (pure). */
export const shownProfile = (names: ReadonlyArray<string>, picked: string | null): string | null =>
  picked !== null && names.includes(picked) ? picked : (names[0] ?? null)

/** The profile shown, by name. */
export function useProfile(): string | null {
  const names = useBoard(profileNames)
  const picked = useAtomValue(pickedProfileAtom)
  return shownProfile(names, picked)
}

/** Picks the profile shown, and keeps it. */
export function pickProfile(name: string): void {
  registry.set(pickedProfileAtom, name)
  void save(PROFILE_KEY, name)
}

/** At start: the profile picked last time. */
export function startProfile(): void {
  void load(PROFILE_KEY).then((name) => {
    if (name !== null && registry.get(pickedProfileAtom) === null) registry.set(pickedProfileAtom, name)
  })
}

/** The projects of profile `name` on every host (pure). */
export const projectsOf = (b: Pick<Board, "profiles" | "projects">, name: string | null): ReadonlyArray<HostProject> => {
  const ids = new Set(b.profiles.filter((p) => p.name === name).map((p) => `${p.host_id}/${p.id}`))
  return b.projects.filter((p) => ids.has(`${p.host_id}/${p.profile_id}`))
}

/** A project across hosts: its host's id and its own. */
export const projectKey = (p: Pick<HostProject, "host_id" | "id">): string => `${p.host_id}/${p.id}`

/** The project the Tasks tab shows (its `projectKey`); null for every project of the profile. Kept while the app runs. */
export const shownProjectAtom: Atom.Writable<string | null> = Atom.make<string | null>(null).pipe(Atom.keepAlive)
