// Finding other hosts on the LAN and on Tailscale (HA-289), for Settings → Hosts to offer linking them.
//
// Each host that listens beyond localhost advertises itself over mDNS (DNS-SD service `_huntaway._tcp.local`, RFC
// 6762/6763), with how to reach it (its id, name, HTTP port, version) and never its token. mDNS rather than a protocol
// of our own because firewalls let it through by default (ufw's and firewalld's default rules accept multicast to
// 224.0.0.251:5353, where a broadcast to a port of our own is dropped), and the hosts show up in other DNS-SD browsers
// (`avahi-browse _huntaway._tcp`) too. The port is shared with avahi, browsers and other hosts on the machine.
//
// A hub browses by asking for the service on each of its networks. Tailscale carries no multicast, so each Tailscale
// peer that's online (from `tailscale status --json`) is asked directly too, and tried on HTTP port 7878's
// `/api/health`, which finds a host from before this, or one whose firewall drops the unicast query.
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import os from "node:os";

const log = {
  info: (m: string) => console.error(new Date().toISOString(), " INFO huntaway::hosts::discovery:", m),
  warn: (m: string) => console.error(new Date().toISOString(), " WARN huntaway::hosts::discovery:", m),
};

export const MDNS_PORT = 5353;
export const MDNS_GROUP = "224.0.0.251";
export const SERVICE = "_huntaway._tcp.local";
/** The default HTTP port, which Tailscale peers are tried on. */
export const HTTP_PORT = 7878;
const TTL = 120;
const [A, PTR, TXT, SRV, ANY] = [1, 12, 16, 33, 255];

/** What a host says about itself: how to reach it, not how to get in. */
export interface Ad {
  host_id: string;
  host_name: string;
  port: number;
  /** The address it listens on, when it listens on one only (`--host 192.168.1.5`). */
  address?: string;
  version: string;
  api_version: number;
}

/** A host found, to offer linking. */
export interface Found {
  /** Null for a Tailscale peer that answered `/api/health` only: its id comes with its token. */
  host_id: string | null;
  name: string;
  url: string;
  via: "lan" | "tailscale";
  version: string | null;
  api_version: number | null;
}

function ipv4_num(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function in_net(ip: string, net: string, bits: number): boolean {
  const a = ipv4_num(ip.startsWith("::ffff:") ? ip.slice(7) : ip);
  if (a === null) return false;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (ipv4_num(net)! & mask);
}

/** Tailscale's addresses (the CGNAT range it hands out). */
export const is_tailscale = (ip: string) => in_net(ip, "100.64.0.0", 10);

/** Addresses a direct (unicast) query is answered from: loopback, private networks, link-local and Tailscale. */
export function is_private(ip: string): boolean {
  return (
    [
      ["127.0.0.0", 8],
      ["10.0.0.0", 8],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["169.254.0.0", 16],
    ].some(([net, bits]) => in_net(ip, net as string, bits as number)) || is_tailscale(ip)
  );
}

/** Bridges for containers and VMs on this machine, which no other machine is on. */
const BRIDGE = /^(docker|br-|veth|virbr|vnet|cni|flannel|podman|lxc|lxd|vmnet|vboxnet)/;

/** This machine's IPv4 addresses that multicast goes out on: not loopback, Tailscale or container bridges. */
export function lan_addresses(ifaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (BRIDGE.test(name)) continue;
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && !is_tailscale(i.address) && !out.includes(i.address)) out.push(i.address);
  }
  return out;
}

// ---------- DNS messages, as much of them as DNS-SD needs ----------

interface RR {
  name: string;
  type: number;
  data: Buffer;
  /** Filled in for the types read here. */
  ptr?: string;
  srv?: { port: number; target: string };
  txt?: Record<string, string>;
  a?: string;
}

function encode_name(name: string): Buffer {
  const parts = name.split(".").filter(Boolean);
  return Buffer.concat([...parts.map((p) => Buffer.from(p, "utf8").subarray(0, 63)).flatMap((b) => [Buffer.from([b.length]), b]), Buffer.from([0])]);
}

function read_name(msg: Buffer, at: number): [string, number] {
  const labels: string[] = [];
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = msg[at];
    if (len === undefined) throw new Error("name runs off the end");
    if (len === 0) return [labels.join("."), end < 0 ? at + 1 : end];
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = at + 2;
      at = ((len & 0x3f) << 8) | msg[at + 1];
      continue;
    }
    labels.push(msg.toString("utf8", at + 1, at + 1 + len));
    at += 1 + len;
  }
  throw new Error("name loops");
}

function rr(name: string, type: number, data: Buffer, flush: boolean): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? 0x8001 : 1, 2);
  head.writeUInt32BE(TTL, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encode_name(name), head, data]);
}

function message(id: number, flags: number, questions: Buffer[], answers: Buffer[]): Buffer {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(flags, 2);
  h.writeUInt16BE(questions.length, 4);
  h.writeUInt16BE(answers.length, 6);
  return Buffer.concat([h, ...questions, ...answers]);
}

/** A query for the service's instances. */
export function query(id = 0): Buffer {
  return message(id, 0, [Buffer.concat([encode_name(SERVICE), Buffer.from([0, PTR, 0, 1])])], []);
}

/** The DNS-SD label for a host: its name and the start of its id, so two hosts called the same still differ. */
function instance(ad: Ad): string {
  const name = ad.host_name.replace(/\./g, " ").slice(0, 40).trim() || "huntaway";
  return `${name} ${ad.host_id.slice(0, 8)}.${SERVICE}`;
}

/** The answer advertising `ad`: PTR, SRV, TXT, and an A record for each of `addresses`. */
export function response(ad: Ad, addresses: string[], id = 0): Buffer {
  const inst = instance(ad);
  const target = `huntaway-${ad.host_id.slice(0, 8)}.local`;
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(ad.port, 4);
  const txt = Object.entries({ id: ad.host_id, name: ad.host_name, v: ad.version, api: String(ad.api_version), ...(ad.address ? { address: ad.address } : {}) })
    .map(([k, v]) => Buffer.from(`${k}=${v}`, "utf8").subarray(0, 255))
    .flatMap((b) => [Buffer.from([b.length]), b]);
  const a = (ad.address ? [ad.address] : addresses).flatMap((ip) => {
    const n = ipv4_num(ip);
    if (n === null) return [];
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return [rr(target, A, b, true)];
  });
  return message(
    id,
    0x8400,
    [],
    [rr(SERVICE, PTR, encode_name(inst), false), rr(inst, SRV, Buffer.concat([srv, encode_name(target)]), true), rr(inst, TXT, Buffer.concat(txt), true), ...a],
  );
}

/** A DNS message's id, whether it's a response, the questions' (name, type)s and its records. */
export function parse(msg: Buffer): { id: number; response: boolean; questions: Array<[string, number]>; records: RR[] } {
  if (msg.length < 12) throw new Error("too short");
  const id = msg.readUInt16BE(0);
  const flags = msg.readUInt16BE(2);
  const qd = msg.readUInt16BE(4);
  const rrs = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let at = 12;
  const questions: Array<[string, number]> = [];
  for (let i = 0; i < qd; i++) {
    const [name, next] = read_name(msg, at);
    questions.push([name, msg.readUInt16BE(next)]);
    at = next + 4;
  }
  const records: RR[] = [];
  for (let i = 0; i < rrs; i++) {
    const [name, next] = read_name(msg, at);
    const type = msg.readUInt16BE(next);
    const len = msg.readUInt16BE(next + 8);
    const start = next + 10;
    if (start + len > msg.length) throw new Error("record runs off the end");
    const r: RR = { name, type, data: msg.subarray(start, start + len) };
    if (type === PTR) r.ptr = read_name(msg, start)[0];
    else if (type === SRV) r.srv = { port: msg.readUInt16BE(start + 4), target: read_name(msg, start + 6)[0] };
    else if (type === A && len === 4) r.a = [...r.data].join(".");
    else if (type === TXT) {
      r.txt = {};
      for (let j = 0; j < len;) {
        const s = r.data.toString("utf8", j + 1, j + 1 + r.data[j]);
        j += 1 + r.data[j];
        const eq = s.indexOf("=");
        if (eq > 0) r.txt[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1);
      }
    }
    records.push(r);
    at = start + len;
  }
  return { id, response: (flags & 0x8000) !== 0, questions, records };
}

const lower = (s: string) => s.toLowerCase();

/** The hosts a response advertises, reached at `from` unless they say they listen on one address. */
export function hosts_in(msg: Buffer, from: string): Array<Omit<Found, "via">> {
  let p;
  try {
    p = parse(msg);
  } catch {
    return [];
  }
  if (!p.response) return [];
  const out: Array<Omit<Found, "via">> = [];
  for (const ptr of p.records.filter((r) => r.type === PTR && lower(r.name) === SERVICE && r.ptr)) {
    const inst = lower(ptr.ptr!);
    const srv = p.records.find((r) => r.srv && lower(r.name) === inst)?.srv;
    const txt = p.records.find((r) => r.txt && lower(r.name) === inst)?.txt;
    if (!srv || !txt?.id) continue;
    const ip = txt.address || from;
    const api = Number(txt.api);
    out.push({
      host_id: txt.id,
      name: txt.name || txt.id,
      url: `http://${ip}:${srv.port}`,
      version: txt.v || null,
      api_version: Number.isFinite(api) && txt.api ? api : null,
    });
  }
  return out;
}

/** Whether a message is a query for the service (or for anything, as `ANY`). */
function asks_for_us(p: ReturnType<typeof parse>): boolean {
  return !p.response && p.questions.some(([name, type]) => lower(name) === SERVICE && (type === PTR || type === ANY));
}

/** Join the mDNS group on each LAN address not joined yet (they come and go with networks). */
function join(sock: dgram.Socket, joined: Set<string>) {
  for (const ip of lan_addresses()) {
    if (joined.has(ip)) continue;
    try {
      sock.addMembership(MDNS_GROUP, ip);
      joined.add(ip);
    } catch {}
  }
}

/** A UDP socket on `port` (shared with others on it), or null if it can't have it. */
function listen(port: number, address?: string): Promise<dgram.Socket | null> {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return new Promise((ok) => {
    const fail = (e: Error) => {
      log.warn(`discovery on UDP ${port}: ${e.message}`);
      sock.close();
      ok(null);
    };
    sock.once("error", fail);
    sock.bind(port, address, () => {
      sock.off("error", fail);
      sock.on("error", (e) => log.warn(`discovery: ${e.message}`));
      ok(sock);
    });
  });
}

/**
 * Advertise `ad()` on mDNS until the returned socket is closed: answer queries for the service on the group, and
 * direct ones (from another port than 5353, such as a hub asking a Tailscale peer) to whoever asked, if that's on a
 * private network. `port` and `address` are for tests, which answer on loopback only.
 */
export async function respond(ad: () => Ad, port = MDNS_PORT, address?: string): Promise<dgram.Socket | null> {
  const sock = await listen(port, address);
  if (!sock) return null;
  const joined = new Set<string>();
  if (!address) {
    sock.setMulticastTTL(255);
    join(sock, joined);
    const t = setInterval(() => join(sock, joined), 60_000);
    t.unref();
    sock.on("close", () => clearInterval(t));
  }
  sock.on("message", (msg, from) => {
    let p;
    try {
      p = parse(msg);
    } catch {
      return;
    }
    if (!asks_for_us(p)) return;
    if (from.port !== MDNS_PORT) {
      // A "legacy unicast" query (RFC 6762 §6.7): answered to its sender, with its id.
      if (is_private(from.address)) sock.send(response(ad(), lan_addresses(), p.id), from.port, from.address);
      return;
    }
    // On the group, out of each network we're on, for the hubs listening there.
    const res = response(ad(), lan_addresses());
    for (const ip of joined) {
      try {
        sock.setMulticastInterface(ip);
        sock.send(res, MDNS_PORT, MDNS_GROUP);
      } catch {}
    }
  });
  return sock;
}

/** A Tailscale peer that's online. */
export interface Peer {
  name: string;
  ip: string;
}

/** The online peers in `tailscale status --json`'s output. */
export function parse_tailscale_status(text: string): Peer[] {
  const status = JSON.parse(text);
  const out: Peer[] = [];
  for (const p of Object.values<any>(status?.Peer ?? {})) {
    if (!p?.Online) continue;
    const ip = (p.TailscaleIPs ?? []).find((a: string) => ipv4_num(a) !== null);
    if (!ip) continue;
    const dns = typeof p.DNSName === "string" ? p.DNSName.split(".")[0] : "";
    out.push({ name: dns || p.HostName || ip, ip });
  }
  return out;
}

/** This machine's online Tailscale peers, or null without Tailscale (no CLI, or it isn't up). */
export function tailscale_peers(bin = process.env.IA_TAILSCALE_BIN || "tailscale"): Promise<Peer[] | null> {
  return new Promise((ok) => {
    execFile(bin, ["status", "--json"], { timeout: 3000, maxBuffer: 16 << 20 }, (e, stdout) => {
      if (e) return ok(null);
      try {
        ok(parse_tailscale_status(stdout));
      } catch {
        ok(null);
      }
    });
  });
}

/** `ip`:`port`'s API version if it answers `/api/health` as a Huntaway host does. */
async function health(ip: string, port: number, timeout_ms: number): Promise<number | null> {
  try {
    const res = await fetch(`http://${ip}:${port}/api/health`, { signal: AbortSignal.timeout(timeout_ms), redirect: "manual" });
    if (!res.ok) return null;
    const b: any = await res.json();
    return b?.ok === true ? (typeof b.api_version === "number" ? b.api_version : 0) : null;
  } catch {
    return null;
  }
}

export interface DiscoverOpts {
  /** Where peers' mDNS answers. */
  port?: number;
  http_port?: number;
  wait_ms?: number;
  /** For tests: ask these addresses directly instead of the group (from a port of our own, so the answers come to it). */
  targets?: string[];
  peers?: () => Promise<Peer[] | null>;
}

/** Ask for hosts on the LAN and Tailscale, and gather the answers for `wait_ms`. `tailscale` is whether it's up. */
export async function discover(o: DiscoverOpts = {}): Promise<{ hosts: Found[]; tailscale: boolean }> {
  const port = o.port ?? MDNS_PORT;
  const wait_ms = o.wait_ms ?? 1500;
  const peers = await (o.peers ?? tailscale_peers)();
  const peer_ips = new Set((peers ?? []).map((p) => p.ip));
  const found = new Map<string, Found>();
  const answered = new Set<string>();

  const heard = (msg: Buffer, from: dgram.RemoteInfo) => {
    for (const h of hosts_in(msg, from.address)) {
      answered.add(from.address);
      const ip = new URL(h.url).hostname;
      const via = peer_ips.has(ip) || is_tailscale(ip) ? "tailscale" : "lan";
      // Once on each: a host on several networks answers on each of them.
      const key = `${h.host_id} ${via}`;
      if (!found.has(key)) found.set(key, { ...h, via });
    }
  };
  // On the group, answers go to port 5353, so we listen there too (beside this host's own responder), on each network.
  const group = o.targets ? null : await listen(MDNS_PORT);
  if (group) {
    group.on("message", heard);
    const joined = new Set<string>();
    join(group, joined);
    group.setMulticastTTL(255);
    for (const ip of joined) {
      try {
        group.setMulticastInterface(ip);
        group.send(query(), MDNS_PORT, MDNS_GROUP);
      } catch {}
    }
  }
  // Direct queries go from a port of our own, not 5353, so they're answered to it (RFC 6762 §6.7's legacy unicast).
  const direct = await listen(0);
  direct?.on("message", heard);
  for (const t of [...(o.targets ?? []), ...(peers ?? []).map((p) => p.ip)]) direct?.send(query(1), port, t, () => {});
  const http_port = o.http_port ?? HTTP_PORT;
  const probed = Promise.all((peers ?? []).map(async (p) => [p, await health(p.ip, http_port, wait_ms)] as const));
  await new Promise((r) => setTimeout(r, wait_ms));
  group?.close();
  direct?.close();
  for (const [p, api_version] of await probed) {
    if (api_version === null || answered.has(p.ip)) continue;
    const url = `http://${p.ip}:${http_port}`;
    found.set(url, { host_id: null, name: p.name, url, via: "tailscale", version: null, api_version });
  }
  return { hosts: [...found.values()], tailscale: peers !== null };
}
