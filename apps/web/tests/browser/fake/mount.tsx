// Puts components in the page for the component checks: `mount(board, <X/>)` connects the page's session to the fake
// host (host.ts) for `board` and renders `<X/>`; `cleanUp` (after each check) takes it all away again, every atom
// included, which the old fake could not do for the other stores and module caches.
import { RegistryContext } from "@effect/atom-react"
import { StrictMode, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { boardAtom, tokenAtom, transportAtom } from "@huntaway/client"
import { registry } from "../../../src/state/registry"
import type { Board } from "./builders"
import { current, fakeHost, uninstall } from "./host"

const roots: Array<{ readonly root: Root; readonly el: HTMLElement }> = []
const initialUrl = window.location.pathname + window.location.search

/**
 * Renders `node` into the page (in StrictMode, as main.tsx does) on the board `b`: through the fake host made for it
 * last, or a new one with the default answers. The board arrives as the session's first snapshot; `ready()` waits for it.
 */
export function mount(b: Board | null, node: ReactNode): HTMLElement {
  registry.reset()
  const host = b ? (current()?.board === b ? current() : fakeHost(b)) : current()
  if (host) registry.set(transportAtom, host.transport)
  registry.set(tokenAtom, "test-token")
  const el = document.body.appendChild(document.createElement("div"))
  const root = createRoot(el)
  root.render(
    <StrictMode>
      <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>
    </StrictMode>,
  )
  roots.push({ root, el })
  return el
}

/** Waits until the page has the fake host's board. */
export function ready(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const cancel = registry.subscribe(
    boardAtom,
    (b) => {
      if (!b.loaded) return
      resolve()
      queueMicrotask(() => cancel())
    },
    { immediate: true },
  )
  return promise
}

/**
 * After each check: unmounts what it rendered, resets every atom, puts storage and the URL back, and takes the fake
 * host away. Fails the check if the fake host was asked for something it had no handler for.
 */
export function cleanUp(): void {
  for (const { root, el } of roots.splice(0)) {
    root.unmount()
    el.remove()
  }
  registry.reset()
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, "", initialUrl)
  const host = current()
  uninstall()
  if (host?.missed.length) throw new Error(`the fake host had no handler for:\n${host.missed.join("\n")}`)
}
