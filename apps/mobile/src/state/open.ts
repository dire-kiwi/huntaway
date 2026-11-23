import { boardAtom } from "@huntaway/client"
import { Atom } from "effect/reactivity"
import { router } from "expo-router"
import { Linking } from "react-native"
import { messageLink, openable, type PageRef, pagePath, type Target } from "../logic/links"
import { pickProfile } from "./board"
import { connectionAtom } from "./connection"
import { registry } from "./registry"

// Opening things from anywhere in the app (HE-99): a task, a page of a plugin's (a document), and what a link leads to
// (logic/links.ts). A link out of the app that the user didn't tap themselves, as far as the app can tell (one a
// plugin's page asked for), is asked about first: the page could put what it shows into an address of its own.

export const openTask = (host: string, id: string): void => router.push({ pathname: "/task/[host]/[id]", params: { host, id } })

export const openPage = (page: PageRef): void => router.push({ pathname: "/page", params: { plugin: page.plugin, path: page.path, search: page.search } })

/** The address the app asks about before the browser gets it; null when it asks about none. */
export const askedLinkAtom: Atom.Writable<string | null> = Atom.make<string | null>(null).pipe(Atom.keepAlive)

/** Hands `url` to the phone's browser (or mail app), if it is a web or mail address: nothing else leaves the app. */
export const openInBrowser = (url: string): void => {
  if (openable(url)) void Linking.openURL(url).catch(() => undefined)
}

const outside = (url: string, ask: boolean): void => (ask ? registry.set(askedLinkAtom, url) : openInBrowser(url))

/**
 * Opens what a link leads to. `ask`: it isn't known to be the user's own tap, so a link out of the app is asked about.
 * `host` is where a task the board doesn't show is looked for (the page's own).
 */
export function openTarget(target: Target, options: { readonly ask: boolean; readonly host?: string }): void {
  const board = registry.get(boardAtom)
  switch (target.kind) {
    case "task": {
      const host = board.tasks[target.id]?.host_id ?? options.host ?? board.localHostId
      if (host !== null) openTask(host, target.id)
      return
    }
    case "page": {
      // A profile's documents are the Docs tab: going there shows them, rather than a copy of the tab over it.
      const home = target.plugin === "docs" && target.search === "" ? board.profiles.find((p) => p.id === pagePath(target.path)) : undefined
      if (home === undefined) return openPage(target)
      pickProfile(home.name)
      if (router.canDismiss()) router.dismissAll()
      return router.navigate("/docs")
    }
    case "web": {
      const connection = registry.get(connectionAtom)
      if (connection._tag === "board") outside(`${connection.link.url}${target.path}`, options.ask)
      return
    }
    case "external":
      return outside(target.url, options.ask)
  }
}

/** A route's parameter as text (expo-router gives a repeated one as a list). */
export const param = (v: string | ReadonlyArray<string> | undefined): string => (typeof v === "string" ? v : (v?.[0] ?? ""))

/** Opens a link the user tapped in a message: a document or a task of this board in the app, anything else in the browser. */
export function openMessageLink(link: string): void {
  const connection = registry.get(connectionAtom)
  const target = messageLink(link, connection._tag === "board" ? connection.link.url : "")
  if (target !== null) openTarget(target, { ask: false })
}
