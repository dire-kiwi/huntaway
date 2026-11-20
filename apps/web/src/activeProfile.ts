import { parseJson, toJson } from "./components/ui/json"
import { href } from "./router"

const KEY = "ia.activeProfile"

/** The profile picked last, whose projects the sidebar lists; kept in this browser. */
export function loadActiveProfile(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function saveActiveProfile(name: string) {
  try {
    localStorage.setItem(KEY, name)
  } catch {
    // The sidebar still follows it for this session when storage is unavailable.
  }
}

/**
 * The profile the sidebar lists the projects of: the one picked last (`saved`), or the first
 * one if that's gone. `needs` says which profile the open page needs instead, given that one:
 * a profile's board needs that profile, and a project (or a task in one) the sidebar wouldn't
 * list under it needs the project's own.
 */
export function activeProfile(names: string[], saved: string | null, needs?: (current: string) => string | undefined): string | undefined {
  const current = saved !== null && names.includes(saved) ? saved : names[0]
  if (current === undefined) return undefined
  const want = needs?.(current)
  return want !== undefined && names.includes(want) ? want : current
}

const PLACES = "ia.profilePlaces"

function loadPlaces(): Record<string, string> {
  try {
    const places = parseJson(localStorage.getItem(PLACES))
    return typeof places === "object" && places !== null
      ? Object.fromEntries(Object.entries(places).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {}
  } catch {
    return {}
  }
}

/** HE-64: keeps `url` (a path and query) as where `profile`'s sidebar was last, for `profilePlace`. */
export function saveProfilePlace(profile: string, url: string) {
  const places = loadPlaces()
  if (places[profile] === url) return
  try {
    localStorage.setItem(PLACES, toJson({ ...places, [profile]: url }))
  } catch {
    // Switching profiles opens its board when storage is unavailable.
  }
}

/**
 * HE-64: where switching to `profile` goes: the page it was last on (`saveProfilePlace`), or its board when that's
 * not kept or is the page open (`here`), as clicking the profile already on goes to its board.
 */
export function profilePlace(profile: string, here: string): string {
  const place = loadPlaces()[profile]
  return place !== undefined && place !== here ? place : href({ name: "profile", profile })
}
