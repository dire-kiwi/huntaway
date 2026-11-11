import { AdminRpcs } from "./admin.ts"
import { ApprovalRulesRpcs } from "./approvalRules.ts"
import { LinkRpcs } from "./link.ts"
import { AttachmentRpcs } from "./attachments.ts"
import { BoardRpcs } from "./board.ts"
import { HostRpcGroup } from "./host.ts"
import { HubHostRpcs } from "./hub.ts"
import { PenRpcs } from "./pens.ts"
import { PermissionRpcs } from "./permissions.ts"
import { ConfigRpcs, ProfileRpcs } from "./profiles.ts"
import { ProjectRpcs } from "./projects.ts"
import { SettingsSyncRpcs } from "./settingsSync.ts"
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
  SettingsSyncRpcs,
  AdminRpcs,
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
