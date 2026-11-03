// How agent-threads' components draw a task's thread in Huntaway: its Markdown, Huntaway's own user
// messages, and subagents that open full screen. Made once, as the package asks (new renderers redraw every row).
import type { ThreadConfig } from "@dire-kiwi/agent-threads-react";
import { renderItem, renderMarkdown, SubagentRow } from "./rows";

export const config: ThreadConfig = {
  renderMarkdown,
  renderItem,
  toolKinds: { subagent: { Row: SubagentRow } },
};
