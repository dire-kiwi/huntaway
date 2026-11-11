import { ApprovalRulesRpcs } from "./approvalRules.ts"
import { LinkRpcs } from "./link.ts"
import { AttachmentRpcs } from "./attachments.ts"
import { BoardRpcs } from "./board.ts"
import { HostRpcGroup } from "./host.ts"
import { PenRpcs } from "./pens.ts"
import { PermissionRpcs } from "./permissions.ts"
import { ConfigRpcs, ProfileRpcs } from "./profiles.ts"
import { ProjectRpcs } from "./projects.ts"
import { TaskRpcs } from "./tasks.ts"
import { ThreadRpcs } from "./threads.ts"
import { ToolRpcs } from "./tools.ts"

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
  ToolRpcs,
)
export type HostRpcs = typeof HostRpcs

/** What a client of its own board can call: `HostRpcs` and `PublicRpcs` (`HubRpcs` joins with the hosts, M7). */
export { PublicRpcs } from "./public.ts"

/** What a hub calls on a host it links: the host's own groups and `link.*` (docs/plan/08-hosts.md). */
export const PeerRpcs = HostRpcs.merge(LinkRpcs)
export type PeerRpcs = typeof PeerRpcs
