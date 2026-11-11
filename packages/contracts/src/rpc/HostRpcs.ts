// 6.4
import { AgentToolsRpcs } from "./agentTools.ts"
import { ApprovalRulesRpcs } from "./approvalRules.ts"
import { AttachmentRpcs } from "./attachments.ts"
import { BoardRpcs } from "./board.ts"
import { CheckpointRpcs } from "./checkpoints.ts"
// 6.10: computer use.
import { DesktopRpcs } from "./desktop.ts"
import { GitRpcs } from "./git.ts"
import { HostRpcGroup } from "./host.ts"
import { PenRpcs } from "./pens.ts"
import { PermissionRpcs } from "./permissions.ts"
import { ConfigRpcs, ProfileRpcs } from "./profiles.ts"
import { ProjectRpcs } from "./projects.ts"
import { TaskRpcs } from "./tasks.ts"
// 6.1: terminals.
import { TerminalRpcs } from "./terminal.ts"
import { ThreadRpcs } from "./threads.ts"
// 6.11: Asana, config archives, fan-outs, adding a project from GitHub.
import { AsanaRpcs } from "./asana.ts"
import { ConfigArchiveRpcs } from "./configArchives.ts"
import { FanoutRpcs } from "./fanout.ts"
import { GithubRepoRpcs } from "./githubRepos.ts"

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
)
export type HostRpcs = typeof HostRpcs

/** What a client of its own board can call: `HostRpcs` and `PublicRpcs` (`HubRpcs` joins with the hosts, M7). */
export { PublicRpcs } from "./public.ts"
