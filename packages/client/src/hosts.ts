import { enc, type Http } from "./http";
import { STATUSES } from "./tasks";

/** The host API version this UI was built against (server: proto::API_VERSION). */
export const UI_API_VERSION = 24;

/** Oldest host API this UI can still drive. Hosts reporting no version are 0. */
export const UI_MIN_HOST_API = 0;

/**
 * How a host's version relates to this UI:
 * ok, outdated (older but usable; newer features are hidden for it),
 * incompatible (too old for this UI), or board_outdated (the host no longer serves a UI this old).
 */
export type Compat = "ok" | "outdated" | "incompatible" | "board_outdated";

export function hostCompat(h: Host): Compat {
  if (h.local) return "ok";
  const api = h.api_version ?? 0;
  if ((h.api_compat ?? 0) > UI_API_VERSION) return "board_outdated";
  if (api < UI_MIN_HOST_API) return "incompatible";
  if (api < UI_API_VERSION) return "outdated";
  return "ok";
}

/** Hosts that don't say are assumed to be able to run agents. */
export const canRunAgents = (h: Host | undefined) => !!h && h.connected && h.agents !== false;

/**
 * A connected host this UI can work with and that can run agents. A hub that can't run agents
 * (e.g. one deployed only to show other hosts) gets no new work; boardHosts says what it shows.
 */
export const usableHost = (h: Host) => canRunAgents(h) && ["ok", "outdated"].includes(hostCompat(h));

/**
 * Hosts whose profiles and projects are on the board: the usable ones, plus this host even if
 * it can't run agents (it usually has none, but a PR preview seeds a demo project).
 */
export const boardHosts = (hosts: Host[]) => hosts.filter((h) => (h.local && h.connected) || usableHost(h));

/** Statuses a host knows about ("Ready for merge" needs API 4). */
export const hostStatuses = (h: Host | undefined) =>
  STATUSES.filter((s) => (s.id !== "ready_for_merge" || hostSupports(h, 4)) && (s.id !== "backlog" || hostSupports(h, 5)));

/** Whether a host's API is at least `minApi`. */
export const hostSupports = (h: Host | undefined, minApi: number) => !!h && (h.local || (h.api_version ?? 0) >= minApi);

/** A machine running Huntaway. Every profile, project and task lives on exactly one. */
export interface Host {
  id: string;
  name: string;
  /** The host this UI is served from. */
  local: boolean;
  connected: boolean;
  /** local, outbound (we connect to it), inbound (it dials us) or ssh (we start it and tunnel to it). */
  mode: "local" | "outbound" | "inbound" | "ssh";
  /** Whether it can run agents (false for a hub that only shows other hosts). */
  agents?: boolean;
  url?: string | null;
  version?: string;
  api_version?: number;
  api_compat?: number;
  /** Commit the host runs, if it runs from a git checkout. */
  commit?: string | null;
  /** How an Update reaches it (API 89): its source checkout, or releases (installed from one, with --release-updates). */
  updates_from?: "checkout" | "releases" | null;
  last_seen?: string | null;
  /** When the hub last heard from a connected host (API 78); pings keep it within about 20s. */
  last_message_at?: string;
  /** A linked host whose agents may use this board's tools, up the link (API 112, Settings → Hosts). */
  uplink?: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  /** API 11+: false for a folder that doesn't exist yet (it's created with the project). */
  exists?: boolean;
  is_git: boolean;
  /** `hidden` (dot folders) is API 11+; older hosts leave them out. */
  entries: { name: string; path: string; is_git: boolean; hidden?: boolean }[];
}

export interface HostInfo {
  host_id: string;
  host_name: string;
  version: string;
  data_dir: string;
  hostname: string;
  home: string | null;
}

export const hostsApi = ({ del, get, on, patch, post }: Http) => ({
  // Hub: the hosts on this board.
  hosts: () => get<Host[]>("/hosts"),
  addHost: (url: string, token: string) => post<Host>("/hosts", { url, token }),
  renameHost: (id: string, name: string) => patch(`/hosts/${enc(id)}`, { name }),
  /** Let a linked host's agents use this board's tools, up the link (API 112), or stop them. */
  setHostUplink: (id: string, uplink: boolean) => patch(`/hosts/${enc(id)}`, { uplink }),
  removeHost: (id: string) => del(`/hosts/${enc(id)}`),
  /** Send this hub's code to a host, which updates its checkout and restarts. */
  updateHost: (id: string) => post<{ ok: boolean; up_to_date?: boolean }>(`/hosts/${enc(id)}/update`),
  sshKey: () => get<{ public_key: string }>("/hosts/ssh-key"),
  addSshHost: (b: { target: string; ssh_port?: number; remote_port?: number }) => post<{ id: string; name: string; started: boolean }>("/hosts/ssh", b),
  joinInfo: () => get<{ hub_token: string; host_token: string; command: string }>("/hosts/join"),
  /** Copy a Claude config (API 20 hosts) or a profile's config (older hosts) to another host. */
  copyClaudeConfig: (b: { config?: string; profile?: string; from_host: string; to_host: string; config_dir?: string; overwrite?: boolean }) =>
    post<{ ok: boolean; files: string[] }>("/hosts/copy-claude-config", b),

  /** Whether a URL answers 200, checked by the server this UI is served from. */
  previewStatus: (url: string) => get<{ up: boolean; status: number | null }>(`/preview-status?url=${encodeURIComponent(url)}`),

  // Per host.
  info: (h: string) => on(h).get<HostInfo>("/info"),
  dirs: (h: string, path?: string) => on(h).get<DirListing>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
});
