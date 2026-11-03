// @dire-kiwi/agent-threads-react: React hooks and components for agent-threads. The app brings a
// thread's events (a ThreadSource on its own transport) and carries its commands (onCommand); this
// draws the thread. Import "@dire-kiwi/agent-threads-react/styles.css" for the components' styles.
export { applyEvent, applyEvents, initialState, isGap, openRequests, withPage } from "@dire-kiwi/agent-threads-protocol";
// Headless
export { isLoaded, ThreadStore } from "./store.js";
export { buildView, groupRows, lineage, rowKey } from "./view.js";
export { ThreadProvider, useCommand, useHasEarlier, useInterrupt, useLoadEarlier, useRespond, useReveal, useSend, useSetOptions, useThread, useThreadConfig, useThreadState, useThreadStore, } from "./hooks.js";
export { brief, planTitle, relative, toolMeta } from "./toolMeta.js";
// Components
export { Thread, ThreadStatusLine } from "./components/Thread.js";
export { AssistantMessage, ItemView, MessageList, MessageRow, Reasoning, UserMessage } from "./components/MessageList.js";
export { StreamingText } from "./components/StreamingText.js";
export { builtinToolRenderers, EditDiff, PatchDiff, ToolCall, ToolGroup, ToolResultView, ToolStatus, toolRenderer } from "./components/ToolCall.js";
export { reportText, Subagent, SubagentStatusBadge, subagentKind, subagentTitle } from "./components/Subagent.js";
export { OpenRequests, PermissionCard, PlanCard, QuestionCard, RequestCard } from "./components/Requests.js";
export { LoadEarlier } from "./components/LoadEarlier.js";
export { CompactionLine, Notice, TurnResult, usageText } from "./components/Lines.js";
export { afterSent, Composer } from "./components/Composer.js";
export { AgentsPill } from "./components/AgentsPill.js";
export { Button, CodeBlock, Collapsible, cx, Markdown } from "./components/ui.js";
