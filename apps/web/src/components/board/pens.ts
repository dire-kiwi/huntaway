// Pens (HA-285, API 127): a profile's named sets of tasks, which its board shows as tabs. Each host keeps its own, and a
// profile's board spans hosts, so its tabs are the pens merged by name: a tab is every host's pen of that name, and a
// task is in it if it's in its host's one. Marking a tab active or inactive (HA-291), renaming, moving or deleting it
// does it to each of them.
import type { CSSProperties } from "react"
import { isPenColor, PEN_COLOR_NAMES, PEN_COLORS, type HostPen as Pen, type HostTask as Task } from "@huntaway/client"
import { type PenColor, ProfileId } from "@huntaway/contracts"
import { profileNameOf, type State } from "../boardHelpers"
import { parseJson, toJson } from "../ui/json"
import { rpc } from "../../state/rpc"
import { board } from "../../state/board"
import { openTask } from "../../state/route"

/** A pen as the store has it: with the host it's on. */
export type HostPen = Pen & { host_id: string }

/** A profile board's tab: its pens of one name (in any case) on each host. */
export interface PenTab {
  /** Its name in lower case, which names it on every host. */
  key: string
  name: string
  pens: HostPen[]
  /** Active (shown as a tab): one of its pens is. */
  active: boolean
  /** Its colour: its first pen's (the board's own host's, if it has one). */
  color: PenColor
}

export const penKey = (name: string) => name.trim().toLowerCase()

/** A pen's colour (HA-294): its own, or for a pen on a host from before pens had colours, one picked by its name. */
export function penColor(p: Pick<Pen, "name" | "color">): PenColor {
  if (isPenColor(p.color)) return p.color
  let h = 0
  for (const ch of penKey(p.name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PEN_COLOR_NAMES[h % PEN_COLOR_NAMES.length] ?? "blue"
}

/** How something in a pen's colour looks: text that reads on the theme's background, on a tint of it. */
export function penStyle(color: PenColor, strength = 16): CSSProperties {
  const c = PEN_COLORS[color]
  return {
    color: `light-dark(${c.light}, ${c.dark})`,
    backgroundColor: `color-mix(in srgb, ${c.base} ${strength}%, transparent)`,
    borderColor: `color-mix(in srgb, ${c.base} ${strength * 2.5}%, transparent)`,
  }
}

/** What the label on a task's card says of its pen: the pen's tab (its key, name and colour) on its profile's board. */
export type PenLabel = { key: string; name: string; color: PenColor; profile: string }

/**
 * The label for a task's card: the tab its pen is in, as the profile's board shows it (named and coloured as the pen of
 * that name on the board's own host, if it has one); null if it's in no pen.
 */
export function penLabel(s: Pick<State, "pens" | "profiles" | "localHostId">, t: Task): PenLabel | null {
  if (!t.pen_id) return null
  const pen = s.pens.find((p) => p.host_id === t.host_id && p.id === t.pen_id)
  if (!pen) return null
  const profile = profileNameOf(s, pen)
  if (!profile) return null
  const key = penKey(pen.name)
  const local =
    pen.host_id === s.localHostId ? pen : s.pens.find((p) => p.host_id === s.localHostId && penKey(p.name) === key && profileNameOf(s, p) === profile)
  const tab = local ?? pen
  return { key, name: tab.name, color: penColor(tab), profile }
}

/**
 * The tabs of a profile's pens (`profiles`: the profile on each host, as `<host>:<profile id>`), in their order: by the
 * place of each among its host's pens, the board's own host's first.
 */
export function penTabs(pens: ReadonlyArray<HostPen>, profiles: Set<string>, localHostId: string | null): PenTab[] {
  const tabs = new Map<string, PenTab & { order: number[] }>()
  // Each pen's place among its host's, from 0.
  const place = new Map<HostPen, number>()
  const byHost = new Map<string, HostPen[]>()
  for (const p of pens) {
    if (!profiles.has(`${p.host_id}:${p.profile_id}`)) continue
    byHost.set(p.host_id, [...(byHost.get(p.host_id) ?? []), p])
  }
  for (const list of byHost.values()) list.toSorted((a, b) => a.position - b.position).forEach((p, i) => place.set(p, i))
  const hosts = [...byHost.entries()].toSorted(([a], [b]) => Number(b === localHostId) - Number(a === localHostId))
  for (const [, list] of hosts) {
    for (const p of list) {
      const key = penKey(p.name)
      const tab = tabs.get(key) ?? { key, name: p.name, pens: [], active: false, color: penColor(p), order: [] }
      tab.pens.push(p)
      tab.active ||= p.active
      tab.order.push(place.get(p) ?? 0)
      tabs.set(key, tab)
    }
  }
  // A tie between hosts goes the board's own host's way.
  const local = (t: PenTab) => Number(!t.pens.some((p) => p.host_id === localHostId))
  return [...tabs.values()]
    .toSorted((a, b) => Math.min(...a.order) - Math.min(...b.order) || local(a) - local(b) || a.key.localeCompare(b.key))
    .map((t): PenTab => ({ key: t.key, name: t.name, pens: t.pens, active: t.active, color: t.color }))
}

/** Whether a task is in the tab's pens. */
export const inTab = (tab: PenTab, t: Task) => !!t.pen_id && tab.pens.some((p) => p.host_id === t.host_id && p.id === t.pen_id)

/** The tab a task's pen is in, if it's in one. */
export const tabOf = (tabs: PenTab[], t: Task) => tabs.find((tab) => inTab(tab, t))

/** Whether a task can go in a pen: one on the board. */
export function canPen(t: Task) {
  return !(t.kind !== "task" || t.task_type === "assistant" || t.task_type === "routine" || t.task_type === "pens" || t.task_type === "pen")
}

/**
 * Moves the tasks into pen `name` (made on a host that has none by it), or with null out of their pens. The saved tasks
 * come back as events, and the first error is thrown once all have tried. (The old board showed the move at once where
 * the pen was known; step 1 leaves it to the event.)
 */
export async function moveToPen(tasks: ReadonlyArray<Task>, name: string | null) {
  const errors: unknown[] = []
  await Promise.all(
    tasks.filter(canPen).map(async (t) => {
      const pen =
        name === null ? null : board.get().pens.find((p) => p.host_id === t.host_id && p.profile_id === t.profile_id && penKey(p.name) === penKey(name))
      if (pen !== undefined && (pen?.id ?? null) === (t.pen_id ?? null)) return
      try {
        await rpc(t.host_id, "tasks.update", { id: t.id, patch: { pen: name } })
      } catch (e) {
        errors.push(e)
      }
    }),
  )
  if (errors.length) throw errors[0]
}

/**
 * Makes a pen on the board's own host if it can, else on the first host with the profile that has pens: `profiles` is
 * the profile on each host, by host id.
 */
export async function createPen(profiles: Map<string, string>, name: string) {
  const hosts = board.get().hosts.filter((h) => h.connected && profiles.has(h.id))
  const host = hosts.find((h) => h.local) ?? hosts[0]
  const profile = host && profiles.get(host.id)
  if (!host || !profile) throw new Error("No host with this profile is connected")
  await rpc(host.id, "pens.create", { pen: { profile_id: ProfileId.make(profile), name } })
}

/** Does `change` to each of the tab's pens. */
export async function changeTab(tab: PenTab, change: { name?: string | undefined; active?: boolean | undefined; color?: PenColor | undefined }) {
  await Promise.all(tab.pens.map((p) => rpc(p.host_id, "pens.update", { id: p.id, patch: change })))
}

/**
 * Opens the profile's pens thread (made the first time) on the board's own host if it has the profile, else on the
 * first connected host that has it: `profiles` is the profile on each host, by host id.
 */
export async function openPensThread(profiles: Map<string, string>) {
  const hosts = board.get().hosts.filter((h) => h.connected && profiles.has(h.id))
  const host = hosts.find((h) => h.local) ?? hosts[0]
  const profile = host && profiles.get(host.id)
  if (!host || !profile) throw new Error("No host with this profile is connected")
  openTask((await rpc(host.id, "pens.thread", { profile_id: ProfileId.make(profile) })).id)
}

/** Opens the tab's pen's own thread (made the first time): its pen on the board's own host if it has one, else its first. */
export async function openPenThread(tab: PenTab) {
  const local = board.get().localHostId
  const pen = tab.pens.find((p) => p.host_id === local) ?? tab.pens[0]
  if (!pen) return
  openTask((await rpc(pen.host_id, "pens.penThread", { id: pen.id })).id)
}

export async function deleteTab(tab: PenTab) {
  await Promise.all(tab.pens.map((p) => rpc(p.host_id, "pens.delete", { id: p.id })))
}

/** Moves a tab to place `to` among `tabs` (inactive ones too), on each host its pens are on. */
export async function moveTab(tabs: PenTab[], tab: PenTab, to: number) {
  const order = tabs.filter((t) => t !== tab)
  order.splice(Math.max(0, Math.min(order.length, to)), 0, tab)
  await Promise.all(
    tab.pens.map((p) => {
      // Its place among its own host's pens, in the new order. The others' places come back in the `pens` event.
      const index = order.flatMap((t) => t.pens.filter((x) => x.host_id === p.host_id)).findIndex((x) => x.id === p.id)
      return rpc(p.host_id, "pens.update", { id: p.id, patch: { index } })
    }),
  )
}

// The tab each profile's board shows (a pen's key, or "" for All), on this client.
const tabKey = (profile: string) => `ia.pen.${profile}`

export const loadTab = (profile: string) => localStorage.getItem(tabKey(profile)) ?? ""

export function saveTab(profile: string, key: string) {
  if (key) localStorage.setItem(tabKey(profile), key)
  else localStorage.removeItem(tabKey(profile))
}

/**
 * The views under All (HA-292): every task in an active pen, or every task in an inactive one, in a row for each pen.
 * They're picked as tabs are, by key: a pen's key is trimmed, so it never starts with a space as these do.
 */
export const ACTIVE_VIEW = " active"
export const INACTIVE_VIEW = " inactive"
export type PenView = typeof ACTIVE_VIEW | typeof INACTIVE_VIEW
export const isPenView = (key: string): key is PenView => key === ACTIVE_VIEW || key === INACTIVE_VIEW

/** The tabs a view has a row for, in their order. */
export const viewTabs = (tabs: PenTab[], view: PenView) => tabs.filter((t) => t.active === (view === ACTIVE_VIEW))

/** A board's rows of pens: a row for each tab, which `collapsed` (by key) shows only the header of; `empty` says there are none. */
export type PenLanes = { tabs: PenTab[]; collapsed: Set<string>; onToggle: (key: string) => void; empty: string }

// The pens whose rows are collapsed on each profile's board (their keys), on this client.
const collapsedKey = (profile: string) => `ia.pen.collapsed.${profile}`

export function loadCollapsed(profile: string): Set<string> {
  try {
    const keys = parseJson(localStorage.getItem(collapsedKey(profile)) ?? "[]")
    return new Set(Array.isArray(keys) ? keys.filter((k) => typeof k === "string") : [])
  } catch {
    return new Set()
  }
}

export function saveCollapsed(profile: string, keys: Set<string>) {
  if (keys.size) localStorage.setItem(collapsedKey(profile), toJson([...keys]))
  else localStorage.removeItem(collapsedKey(profile))
}
