// Port of server/src/db/links.rs: links to other hosts (see hosts/hub.rs).
import { all, hidden, one, run, type Conn } from "../db.ts";
import { now } from "../util.ts";

/**
 * Another host this node shows on its board. `outbound`: we connect to its URL with its token. `inbound`: it dials us
 * (we only remember it). `ssh`: we start it and tunnel to it over SSH.
 */
export interface Link {
  id: string;
  name: string;
  mode: string;
  url: string | null;
  /** Never serialized (a non-enumerable property, see `hidden`). */
  token: string | null;
  /** For `ssh` links: the target, as JSON. */
  ssh: string | null;
  last_seen: string | null;
  /** Its agents may use this board's tools, up the link (API 112, see hosts/uplink.ts). Off by default. */
  uplink: boolean;
  created_at: string;
}

export function Link_from_row(r: any): Link {
  const l: any = { id: r.id, name: r.name, mode: r.mode, url: r.url, ssh: r.ssh, last_seen: r.last_seen, uplink: !!r.uplink, created_at: r.created_at };
  hidden(l, "token", r.token);
  return l;
}

export function list_links(c: Conn): Link[] {
  return all(c, "SELECT * FROM links ORDER BY name COLLATE NOCASE").map(Link_from_row);
}

export function get_link(c: Conn, id: string): Link | null {
  const r = one(c, "SELECT * FROM links WHERE id=?1", id);
  return r ? Link_from_row(r) : null;
}

export function upsert_link(c: Conn, id: string, name: string, mode: string, url: string | null, token: string | null): Link {
  run(
    c,
    `INSERT INTO links (id,name,mode,url,token,last_seen,created_at) VALUES (?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(id) DO UPDATE SET name=?2, mode=?3, url=COALESCE(?4,url), token=COALESCE(?5,token), last_seen=?6`,
    id,
    name,
    mode,
    url,
    token,
    now(),
  );
  return get_link(c, id)!;
}

/**
 * Note a host that dialled in, keeping how a link we already have to it is made: a host we dial (or reach over SSH)
 * that also dials us is still dialled after a restart.
 */
export function note_inbound_link(c: Conn, id: string, name: string): void {
  run(
    c,
    `INSERT INTO links (id,name,mode,last_seen,created_at) VALUES (?1,?2,'inbound',?3,?3)
         ON CONFLICT(id) DO UPDATE SET name=?2, last_seen=?3`,
    id,
    name,
    now(),
  );
}
