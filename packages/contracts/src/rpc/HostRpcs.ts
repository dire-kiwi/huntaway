import { AdminRpcs } from "./admin.ts"
import { ApprovalRulesRpcs } from "./approvalRules.ts"
import { AttachmentRpcs } from "./attachments.ts"
import { BoardRpcs } from "./board.ts"
import { HostRpcGroup } from "./host.ts"
import { PenRpcs } from "./pens.ts"
import { PermissionRpcs } from "./permissions.ts"
import { ConfigRpcs, ProfileRpcs } from "./profiles.ts"
import { ProjectRpcs } from "./projects.ts"
import { TaskRpcs } from "./tasks.ts"
import { ThreadRpcs } from "./threads.ts"

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
  AdminRpcs,
)
export type HostRpcs = typeof HostRpcs

/** What a client of its own board can call: `HostRpcs` and `PublicRpcs` (`HubRpcs` joins with the hosts, M7). */
export { PublicRpcs } from "./public.ts"
