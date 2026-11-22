// What a run is told of interactive replies when the `a2ui` experiment is on (HE-77): that the board draws an A2UI
// Express block in a reply as UI, and that the rules are a tool call away (`a2ui_rules`, mcp/tools/a2ui.ts), since
// the whole of them is some 20 KB.

export const a2uiNote = (codex: boolean): string => {
  const t = (x: string) => (codex ? `\`huntaway.${x}\`` : `mcp__huntaway__${x}`)
  return (
    `\n\nThe board draws interactive replies: an A2UI Express block between \`<a2ui>\` and \`</a2ui>\` lines in your reply ` +
    `shows in the thread as UI in the board's look (cards, choices, forms, buttons), and what the user picks or fills in comes ` +
    `back to you as their message. Use one when the user has something to choose, fill in or confirm, or a card says it better ` +
    `than prose; not for ordinary answers, and not in place of request_user_input when you must stop for an answer. Before ` +
    `your first block in a thread, read the rules with ${t("a2ui_rules")}, and check a block with ${t("a2ui_check")} if you aren't sure of it.`
  )
}
