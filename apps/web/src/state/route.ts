import { useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { hasPanel, href, type Panel, panelUrl, parse, parsePanel, parseModal, type Route, sameDoc, withoutModal } from "../router"
import { registry } from "./registry"

// The page's route as an atom over the History API (docs/plan/09-frontend.md, The web app's own state), with the
// router's parse and href (../router.ts). The 14 routes and their query parameters are the old router's.

/** What a history entry keeps: where the user was before it (a document's page shows a link back). */
interface HistoryState {
  readonly from?: string | undefined
}

const isHistoryState = (s: unknown): s is HistoryState => typeof s === "object" && s !== null

interface Location {
  readonly pathname: string
  readonly search: string
}

const here = (): Location => ({ pathname: window.location.pathname, search: window.location.search })

/** The page's URL: follows the back and forward buttons, and `navigate`. */
const locationAtom: Atom.Atom<Location> = Atom.make((get) => {
  const onPop = (): void => get.setSelf(here())
  window.addEventListener("popstate", onPop)
  get.addFinalizer(() => window.removeEventListener("popstate", onPop))
  return here()
}).pipe(Atom.keepAlive)

/** The path alone, so what reads the route does not draw again when only the query changes. */
const pathAtom: Atom.Atom<string> = Atom.make((get) => get(locationAtom).pathname)
const searchAtom: Atom.Atom<string> = Atom.make((get) => get(locationAtom).search)

const current = (): string => window.location.pathname + window.location.search

/**
 * Where the user was before the current history entry, if they got here by navigating in the board and it was a
 * different page (moving between a document's own pages keeps where they were before it).
 */
export function cameFrom(): string | null {
  const state: unknown = window.history.state
  const from = isHistoryState(state) ? state.from : undefined
  return typeof from === "string" && from !== current() ? from : null
}

/** Goes to `to` (a route or a URL), in a new history entry or, with `replace`, in place of this one. */
export function navigate(to: Route | string, options: boolean | { readonly replace?: boolean } = false): void {
  const replace = typeof options === "boolean" ? options : options.replace === true
  const url = typeof to === "string" ? to : href(to)
  const was = current()
  if (url === was) return
  const state: unknown = window.history.state
  const previous = isHistoryState(state) ? state : null
  if (replace) window.history.replaceState(previous, "", url)
  else window.history.pushState({ from: sameDoc(was, url) ? previous?.from : was } satisfies HistoryState, "", url)
  registry.refresh(locationAtom)
}

/** Calls `cb` when the page's URL changes (the route or the open task); returns a function that stops it. */
export function onNavigate(cb: () => void): () => void {
  return registry.subscribe(locationAtom, cb)
}

/** The route of the page: draws again when the path changes. */
export function useRoute(): Route {
  return useAtomValue(pathAtom, parse)
}

/** The task open beside the page (`?task=`), expanded into a dialog (`&expanded`), compared (`&compare`). */
export function usePanel(): Panel | null {
  return useAtomValue(searchAtom, parsePanel)
}

/** Whether task `taskId` is open in the side panel: draws again only when that changes (one card's, not every card's). */
export function usePanelOpen(taskId: string): boolean {
  return useAtomValue(searchAtom, (search) => parsePanel(search)?.taskId === taskId)
}

/** The task open in a dialog over whatever page is open (`modal=<id>`), beside the side panel's task if there is one. */
export function useTaskModal(): string | null {
  return useAtomValue(searchAtom, parseModal)
}

/**
 * Opens a task in the side panel of the current page, keeping it expanded if it was. Off the boards, goes to
 * `/t/<id>`, which moves on to the task's board once it is known.
 */
export function openTask(taskId: string, options: { readonly expanded?: boolean; readonly replace?: boolean } = {}): void {
  const path = window.location.pathname
  if (!hasPanel(parse(path))) return navigate({ name: "task", taskId }, options.replace === true)
  const expanded = options.expanded ?? parsePanel(window.location.search)?.expanded ?? false
  navigate(panelUrl(path, { taskId, expanded }), options.replace === true)
}

/** Opens task `taskId` in a dialog over the page, in place of any task open in one. */
export function openTaskModal(taskId: string): void {
  const url = withoutModal(current())
  navigate(`${url}${url.includes("?") ? "&" : "?"}modal=${encodeURIComponent(taskId)}`)
}

/** Closes the task dialog, leaving the page (and its side panel) as it was. */
export function closeTaskModal(replace = false): void {
  navigate(withoutModal(current()), replace)
}

/** Expands the open task into a dialog, or back into the side panel. */
export function setPanelExpanded(expanded: boolean): void {
  const panel = parsePanel(window.location.search)
  if (panel) navigate(panelUrl(window.location.pathname, { ...panel, expanded }), true)
}

/** Compares the tasks made from the same prompt as `taskId`, over the page with the task open beside it. */
export function openCompare(taskId: string): void {
  const path = window.location.pathname
  if (!hasPanel(parse(path))) return navigate({ name: "task", taskId })
  navigate(panelUrl(path, { taskId, expanded: parsePanel(window.location.search)?.expanded ?? false, compare: true }))
}

export function closeCompare(): void {
  const panel = parsePanel(window.location.search)
  if (panel) navigate(panelUrl(window.location.pathname, { ...panel, compare: false }))
}

/** Closes the side panel's task. */
export function closeTask(replace = false): void {
  navigate(window.location.pathname, replace)
}
