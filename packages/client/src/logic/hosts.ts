import { type Host, PROTOCOL } from "@huntaway/contracts"

// What a client knows about hosts without asking them (the old packages/client's hosts.ts). The API version gates
// (`hostSupports`, `hostCompat`, the `*_API` numbers) are gone: a host either speaks this protocol or needs an update,
// and a feature only some hosts have is a named capability (docs/plan/05-protocol.md, Versions).

type HostLike = Pick<Host, "local" | "connected" | "agents" | "protocol" | "capabilities">

/** A connected host that can run agents. Hosts that don't say are taken to be able to. */
export const canRunAgents = (h: Pick<HostLike, "connected" | "agents"> | undefined): boolean => !!h && h.connected && h.agents !== false

/**
 * A host new projects may go on (HE-46): one that can run agents and isn't for access only. `role` is its own setting as
 * its board has it, when the board has it; else what it said when it connected.
 */
export const holdsProjects = (h: Pick<Host, "connected" | "agents" | "role"> | undefined, role?: Host["role"]): boolean =>
  canRunAgents(h) && (role ?? h?.role) !== "access"

/**
 * A connected host this UI can work with and that can run agents: it speaks this protocol (the board's own host always
 * does). A hub that cannot run agents (one deployed only to show other hosts) gets no new work; `boardHosts` says what it
 * shows.
 */
export const usableHost = (h: HostLike): boolean => canRunAgents(h) && (h.local || h.protocol === PROTOCOL)

/**
 * Hosts whose profiles and projects are on the board: the usable ones, and this host even if it cannot run agents (it
 * usually has none, but a PR preview seeds a demo project).
 */
export const boardHosts = <H extends HostLike>(hosts: ReadonlyArray<H>): Array<H> => hosts.filter((h) => (h.local && h.connected) || usableHost(h))

/**
 * Whether a host has the named capability (`packages/contracts/src/capabilities.ts`). The host this UI is served from
 * has them all.
 */
export const hostHas = (h: Pick<HostLike, "local" | "capabilities"> | undefined, name: string): boolean => !!h && (h.local || h.capabilities.includes(name))
