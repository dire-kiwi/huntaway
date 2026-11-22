// What an agent is told of interactive replies (HE-77), and the check of a reply's blocks it can run first. The rules
// are the board's own (where a block goes, how a click comes back, updating a surface) followed by the A2UI Express
// contract and the components, as `@a2ui/agent`'s prompt generator writes them for the board's catalogs. They are ~20 KB,
// so a run's system prompt says only that they exist (the server's `a2uiNote`), and the `a2ui_rules` board tool gives
// them when the agent wants to make one.
import { ExpressFormat } from "@a2ui/agent"
import type { CatalogApi } from "@a2ui/web_core"
import { ACTION_FENCE } from "./message.ts"

/** The surface a block that names none is drawn on: its own, so two such blocks never collide. */
export const FALLBACK_SURFACE = "reply"

/** What the board adds before the Express contract. */
export const BOARD_RULES = `# Interactive replies on the Huntaway board

The board draws an A2UI Express block in your reply as UI, right where the block is in your message, in the board's own look. Use one when the user has something to pick, fill in or confirm, or when a card shows it better than prose (a choice between approaches, a short form, a checklist, a summary card). Don't use one for an ordinary answer, and don't use one for a question that must stop your turn: request_user_input is for that.

- Write your reply as usual and put the block on lines of its own: a line \`<a2ui>\`, the Express, then a line \`</a2ui>\`. Never in a code fence (a block in a fence is shown as code).
- Name each surface with \`surface("<id>")\` as the block's first line: a short id, unique in this thread (\`"approach"\`, \`"release-form"\`).
- A button's action is \`Event("<name>", {<key>: <value or $/path>})\`. When the user clicks it, you get a message from them whose last part is the action as JSON in a \`\`\`${ACTION_FENCE} fence: \`{"surfaceId", "name", "sourceComponentId", "context"}\`, where \`context\` holds what the Event named, resolved (bind fields to data paths, e.g. \`TextField("Title", $/form/title)\`, and pass them: \`Event("save", {title: $/form/title})\`). Act on it as on any message of theirs.
- The surface stays drawn, and is locked while the user's click is on its way. To change it (say, to show what you did with the choice), reply with \`surface("<id>", update=true)\` and its new \`root\`: the board draws the new version where the old one was and greys out the earlier copy. \`surface("<id>")\` alone for an id already used fails.
- Data paths start at the surface's root (\`$/form/title\`); set starting values with \`$/form/title = "…"\`.
- If you aren't sure a block is right, check it with the a2ui_check board tool before you send it: it says what's wrong, as the board would.
`

/** The rules for `catalogs` (the board's), as `a2ui_rules` gives them. */
export const rules = (catalogs: ReadonlyArray<CatalogApi>): string =>
  `${BOARD_RULES}\n${new ExpressFormat([...catalogs], { surfaceId: FALLBACK_SURFACE }).promptGenerator.generate()}`

/** The surfaces a block's messages create, change or delete. */
export function surfaceIdsOf(messages: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const ids: Array<string> = []
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue
    for (const [key, body] of Object.entries(m)) {
      if (key === "version" || typeof body !== "object" || body === null || !("surfaceId" in body)) continue
      const id = body.surfaceId
      if (typeof id === "string" && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/** An error's message without the generic help line the parser appends. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split(" - Help:")[0] ?? ""
