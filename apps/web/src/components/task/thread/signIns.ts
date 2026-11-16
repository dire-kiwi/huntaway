// HE-49: what an agent's `space_request_sign_ins` prompt asks, read from its input (the server's `teleport/request.ts`
// `askInput`): the Space, the host browser profile, the sites offered with their cookie counts, which are ticked, and
// the ones the profile doesn't hold. The card sends back the input with `sites` as the user left them. Pure, so it's
// tested without a page.

import { fieldsOf, listOf, numberOf, stringOf } from "./fields"

export const SIGN_INS_TOOL = "mcp__spaces__space_request_sign_ins"

export interface OfferedSite {
  readonly site: string
  readonly cookies: number
  readonly storage: number
  readonly identity: boolean
}

export interface SignInsAsk {
  readonly space: string
  readonly browser: string
  readonly profile: string
  readonly offered: ReadonlyArray<OfferedSite>
  readonly ticked: ReadonlyArray<string>
  readonly notFound: ReadonlyArray<string>
}

const strings = (x: unknown): Array<string> => listOf(x).flatMap((s) => (typeof s === "string" ? [s] : []))

/** The prompt's input as the card shows it, or null when it isn't one. */
export const signInsAsk = (tool: string, input: unknown): SignInsAsk | null => {
  if (tool !== SIGN_INS_TOOL) return null
  const f = fieldsOf(input)
  const offered = listOf(f["offered"]).flatMap((o): Array<OfferedSite> => {
    const g = fieldsOf(o)
    const site = stringOf(g["site"])
    return site === undefined
      ? []
      : [{ site, cookies: numberOf(g["cookie_count"]) ?? 0, storage: numberOf(g["storage_count"]) ?? 0, identity: g["identity_provider"] === true }]
  })
  return {
    space: stringOf(f["space_name"]) ?? stringOf(f["space"]) ?? "",
    browser: stringOf(f["browser_label"]) ?? stringOf(f["browser"]) ?? "",
    profile: stringOf(f["profile_label"]) ?? stringOf(f["profile"]) ?? "",
    offered,
    ticked: strings(f["sites"]).filter((s) => offered.some((o) => o.site === s)),
    notFound: strings(f["not_found"]),
  }
}

/** The input to allow the prompt with: as asked, with `sites` the ones the user left ticked. */
export const signInsAnswer = (input: unknown, ticked: ReadonlyArray<string>): Record<string, unknown> => ({ ...fieldsOf(input), sites: [...ticked] })
