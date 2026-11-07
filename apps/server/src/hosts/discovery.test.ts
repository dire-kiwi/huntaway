import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as testing from "../testing.ts";
import * as hub from "./hub.ts";
import * as db from "../db.ts";
import { discover, hosts_in, is_private, lan_addresses, parse, parse_tailscale_status, query, respond, response, SERVICE, type Ad } from "./discovery.ts";

const ad = (host_id: string, port: number): Ad => ({ host_id, host_name: `name-${host_id}`, port, version: "1.2.3", api_version: 128 });

/** A host advertising `a` to direct queries on loopback (tests can't count on multicast). */
async function responder(a: Ad) {
  const sock = await respond(() => a, 0, "127.0.0.1");
  assert.ok(sock);
  return { sock, port: sock.address().port };
}

const just = (port: number) => ({ port, targets: ["127.0.0.1"], peers: async () => null, wait_ms: 300 });

test("an advertisement reads back as the host, at the address it came from", () => {
  const msg = response(ad("0123456789abcdef", 7999), ["192.168.1.20"]);
  const p = parse(msg);
  assert.ok(p.response);
  assert.deepEqual(
    p.records.map((r) => r.type),
    [12, 33, 16, 1],
  );
  assert.equal(p.records[3].a, "192.168.1.20");
  assert.deepEqual(hosts_in(msg, "10.0.0.5"), [
    { host_id: "0123456789abcdef", name: "name-0123456789abcdef", url: "http://10.0.0.5:7999", version: "1.2.3", api_version: 128 },
  ]);
  // A query isn't a response, and nonsense is nothing.
  assert.deepEqual(hosts_in(query(), "10.0.0.5"), []);
  assert.deepEqual(hosts_in(Buffer.from("hello there, this is not DNS"), "10.0.0.5"), []);
  assert.deepEqual(parse(query()).questions, [[SERVICE, 12]]);
});

test("a host that listens on one address gives that address", () => {
  assert.equal(hosts_in(response({ ...ad("h2", 7878), address: "192.168.1.9" }, []), "10.0.0.5")[0].url, "http://192.168.1.9:7878");
});

test("a query on localhost finds the host answering there, once however often it answers", async () => {
  const { sock, port } = await responder(ad("h1", 7999));
  try {
    const r = await discover({ ...just(port), targets: ["127.0.0.1", "127.0.0.1"] });
    assert.equal(r.tailscale, false);
    assert.deepEqual(r.hosts, [{ host_id: "h1", name: "name-h1", url: "http://127.0.0.1:7999", via: "lan", version: "1.2.3", api_version: 128 }]);
  } finally {
    sock.close();
  }
});

test("queries for other services, responses and nonsense get no answer", async () => {
  const { sock, port } = await responder(ad("h1", 7999));
  const q = dgram.createSocket("udp4");
  try {
    await new Promise<void>((r) => q.bind(0, "127.0.0.1", r));
    let got = 0;
    q.on("message", () => got++);
    // The same length of name, for another service.
    const other = Buffer.from(query().toString("latin1").replace("_huntaway", "_otherone"), "latin1");
    for (const m of [other, response(ad("x", 1), []), Buffer.from("x".repeat(600))]) q.send(m, port, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got, 0);
    q.send(query(7), port, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got, 1);
  } finally {
    q.close();
    sock.close();
  }
});

test("only direct queries from private, loopback and Tailscale addresses are answered", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.5", "169.254.1.1", "100.101.102.103", "::ffff:192.168.1.2"])
    assert.ok(is_private(ip), ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "::1", "fe80::1"]) assert.ok(!is_private(ip), ip);
});

test("multicast goes out on each IPv4 network but loopback and Tailscale", () => {
  const iface = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, internal, mac: "", cidr: null });
  const got = lan_addresses({
    lo: [iface("127.0.0.1", true)],
    eth0: [iface("192.168.1.20"), { address: "fe80::1", netmask: "ffff::", family: "IPv6", internal: false, mac: "", cidr: null, scopeid: 0 }],
    wlan0: [iface("10.0.5.7")],
    tailscale0: [iface("100.100.1.2")],
    docker0: [iface("172.17.0.1")],
    "br-1d1ed880e0f0": [iface("172.27.0.1")],
  });
  assert.deepEqual(got, ["192.168.1.20", "10.0.5.7"]);
});

test("tailscale status: online peers, by their MagicDNS name, with their IPv4 address", () => {
  const peers = parse_tailscale_status(
    JSON.stringify({
      Self: { HostName: "me", TailscaleIPs: ["100.64.0.1"], Online: true },
      Peer: {
        a: { HostName: "Desk Top", DNSName: "desktop.tail1234.ts.net.", TailscaleIPs: ["100.64.0.2", "fd7a:115c::2"], Online: true },
        b: { HostName: "phone", DNSName: "phone.tail1234.ts.net.", TailscaleIPs: ["100.64.0.3"], Online: false },
        c: { HostName: "nas", TailscaleIPs: ["fd7a:115c::4", "100.64.0.4"], Online: true },
      },
    }),
  );
  assert.deepEqual(peers, [
    { name: "desktop", ip: "100.64.0.2" },
    { name: "nas", ip: "100.64.0.4" },
  ]);
});

test("a Tailscale peer that doesn't answer mDNS is found on its HTTP port's /api/health", async () => {
  const http = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/api/health" ? JSON.stringify({ ok: true, commit: null, api_version: 120 }) : "{}");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const http_port = (http.address() as AddressInfo).port;
  // A UDP port nothing answers on.
  const quiet = dgram.createSocket("udp4");
  await new Promise<void>((r) => quiet.bind(0, "127.0.0.1", r));
  try {
    const r = await discover({ port: quiet.address().port, http_port, targets: [], peers: async () => [{ name: "old-box", ip: "127.0.0.1" }], wait_ms: 300 });
    assert.equal(r.tailscale, true);
    assert.deepEqual(r.hosts, [{ host_id: null, name: "old-box", url: `http://127.0.0.1:${http_port}`, via: "tailscale", version: null, api_version: 120 }]);
  } finally {
    quiet.close();
    http.close();
  }
});

test("a Tailscale peer that answers mDNS isn't listed again from its HTTP port", async () => {
  const http = createServer((_req, res) => res.end(JSON.stringify({ ok: true, api_version: 128 })));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const http_port = (http.address() as AddressInfo).port;
  const { sock, port } = await responder(ad("h3", 7000));
  try {
    const r = await discover({ port, http_port, targets: [], peers: async () => [{ name: "box", ip: "127.0.0.1" }], wait_ms: 300 });
    assert.deepEqual(
      r.hosts.map((h) => [h.host_id, h.url, h.via]),
      [["h3", "http://127.0.0.1:7000", "tailscale"]],
    );
  } finally {
    sock.close();
    http.close();
  }
});

test("GET /hosts/discover leaves out this host, marks linked ones, and is refused to paired devices", async () => {
  const s = testing.state();
  db.upsert_link(s.db(), "linked-id", "Linked", "outbound", "http://10.0.0.9:7878", "tok");
  const found = [
    { host_id: s.host_id, name: "me", url: "http://10.0.0.1:7878", via: "lan" as const, version: null, api_version: 128 },
    { host_id: "linked-id", name: "a", url: "http://10.0.0.2:7878", via: "lan" as const, version: null, api_version: 128 },
    { host_id: null, name: "old", url: "http://10.0.0.9:7878", via: "tailscale" as const, version: null, api_version: 100 },
    { host_id: "new-id", name: "b", url: "http://10.0.0.3:7878", via: "lan" as const, version: null, api_version: 128 },
  ];
  assert.deepEqual(
    hub.mark_discovered(s, found).map((h) => [h.host_id, h.linked]),
    [
      ["linked-id", true],
      [null, true],
      ["new-id", false],
    ],
  );
  await assert.rejects(hub.discover_hosts(s, { device: { id: "d" } } as any), /paired device/);
});
