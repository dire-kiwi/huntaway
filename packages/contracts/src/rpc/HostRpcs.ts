// 6.4
import { AgentToolsRpcs } from "./agentTools.ts"
import { AdminRpcs } from "./admin.ts"
import { ApprovalRulesRpcs } from "./approvalRules.ts"
import { LinkRpcs } from "./link.ts"
// 6.7
import { AssistantRpcs } from "./assistant.ts"
import { AttachmentRpcs } from "./attachments.ts"
// 6.5
import { AutomationRpcs } from "./automations.ts"
import { BoardRpcs } from "./board.ts"
import { CheckpointRpcs } from "./checkpoints.ts"
// 6.10: computer use.
import { DesktopRpcs } from "./desktop.ts"
import { DocRpcs } from "./docs.ts"
import { GitRpcs } from "./git.ts"
import { HostRpcGroup } from "./host.ts"
import { HubHostRpcs } from "./hub.ts"
import { PenRpcs } from "./pens.ts"
import { PermissionRpcs } from "./permissions.ts"
import { ConfigRpcs, ProfileRpcs } from "./profiles.ts"
import { ProjectRpcs } from "./projects.ts"
// 6.8: the hub's, served by the host until hubs come (M7).
import { PushRpcs } from "./push.ts"
import { SettingsSyncRpcs } from "./settingsSync.ts"
import { TaskRpcs } from "./tasks.ts"
// 6.1: terminals.
import { TerminalRpcs } from "./terminal.ts"
import { TaskDocumentRpcs } from "./taskDocuments.ts"
import { ThreadRpcs } from "./threads.ts"
// 6.11: Asana, config archives, fan-outs, adding a project from GitHub.
import { AsanaRpcs } from "./asana.ts"
import { ConfigArchiveRpcs } from "./configArchives.ts"
import { FanoutRpcs } from "./fanout.ts"
import { GithubRepoRpcs } from "./githubRepos.ts"
import { ToolRpcs } from "./tools.ts"
import { WorkflowRpcs } from "./workflows.ts"

/** Every group a host serves about itself (docs/plan/05-protocol.md, The contract package). */
export const HostRpcs = HostRpcGroup.merge(
  BoardRpcs,
  ProfileRpcs,
  ConfigRpcs,
  ProjectRpcs,
  TaskRpcs,
  PenRpcs,
  AttachmentRpcs,
  ApprovalRulesRpcs,
  ThreadRpcs,
  PermissionRpcs,
  SettingsSyncRpcs,
  AdminRpcs,
  ToolRpcs,
  CheckpointRpcs,
  GitRpcs,
  // 6.1
  TerminalRpcs,
  // 6.11
  AsanaRpcs,
  ConfigArchiveRpcs,
  FanoutRpcs,
  GithubRepoRpcs,
  // 6.10: computer use.
  DesktopRpcs,
  AgentToolsRpcs,
  PushRpcs,
  TaskDocumentRpcs,
  // 6.5
  AutomationRpcs,
  // 6.3
  DocRpcs,
  // 6.7
  AssistantRpcs,
  // 6.6
  WorkflowRpcs,
)
export type HostRpcs = typeof HostRpcs

/** What a client of its own board can call: `HostRpcs` and `PublicRpcs` (`HubRpcs` joins with the hosts, M7). */
export { PublicRpcs } from "./public.ts"

/**
 * What a hub calls on a host it links: the host's own groups, `link.*` (docs/plan/08-hosts.md), and the host's own
 * directory of hosts (`hub.hosts.list`), which discovery reads for the hosts a linked host links.
 */
export const PeerRpcs = HostRpcs.merge(LinkRpcs, HubHostRpcs)
export type PeerRpcs = typeof PeerRpcs
