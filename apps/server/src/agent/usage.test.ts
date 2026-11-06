// Port of the tests in server/src/agent/usage.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as db from "../db.ts";
import * as testing from "../testing.ts";
import type { Req } from "../http.ts";
import {
  Usage_new,
  list,
  merge,
  on_proxy_rate_limit_event,
  on_rate_limit_event,
  codex_refused,
  out_until,
  parse_limits,
  pool_limits,
  refresh,
  reset_due,
  rfc3339,
  set_limits,
  timestamp,
  type Account,
  type Limit,
} from "./usage.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function req(query: Record<string, string> = {}): Req {
  return { method: "GET", path: "/usage", params: {}, query, query_string: "", headers: {}, body: {}, raw: Buffer.alloc(0) };
}

test("parses_limits_list", () => {
  const v = {
    five_hour: { utilization: 14.0, resets_at: "2026-10-23T12:39:59Z" },
    limits: [
      { kind: "session", group: "session", percent: 14, resets_at: "2026-10-23T12:39:59Z", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 67, resets_at: "2026-10-24T02:59:59Z", scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 0, resets_at: null, scope: { model: { display_name: "Fable" } } },
    ],
  };
  const l = parse_limits(v);
  assert.deepEqual(l.map((l) => l.id), ["session", "weekly", "weekly:fable"]);
  assert.equal(l[1].percent, 67.0);
  assert.equal(l[2].label, "Weekly · Fable");
});

test("parses_window_fields", () => {
  const v = { five_hour: { utilization: 14.0, resets_at: "x" }, seven_day: { utilization: 67.0 }, seven_day_opus: null };
  const l = parse_limits(v);
  assert.equal(l.length, 2);
  assert.equal(l[0].id, "session");
  assert.equal(l[1].resets_at, null);
});

test("lists_only_configs_that_show_usage", async () => {
  const s = testing.state();
  // Neither has a login, so the one that's fetched fails without going to the network.
  const dir = join(testing.temp_dir(), "claude");
  const c = s.db();
  const off = db.insert_claude_config(c, "off", dir, "claude");
  const on = db.insert_claude_config(c, "on", dir, "claude");
  db.update_claude_config(c, on.id, [["show_usage", true]]);
  assert.ok(!off.show_usage);
  const v = JSON.parse(JSON.stringify(await list(s, req())));
  assert.equal(v.length, 1);
  assert.equal(v[0].config_id, on.id);
  assert.ok(v[0].error.startsWith("No Claude login"));
  assert.ok(!s.usage.has(off.id));
});

test("a_refused_run_marks_its_config_out_until_the_reset", () => {
  const s = testing.state();
  const soon = Math.floor(Date.now() / 1000) + 600;
  const event = (status: string) => ({
    type: "rate_limit_event",
    rate_limit_info: { status, resetsAt: soon, unifiedWindows: { five_hour: { utilization: 1, resetsAt: soon } } },
  });
  on_rate_limit_event(s, "c", event("allowed_warning"));
  assert.equal(out_until(s, "c"), null, "at 100% on extra usage, it isn't out");
  on_rate_limit_event(s, "c", event("rejected"));
  assert.equal(out_until(s, "c"), timestamp(soon));
  assert.equal(s.usage.get("c").limits[0].percent, 100.0);
  // Allowed again (extra usage bought, say).
  on_rate_limit_event(s, "c", event("allowed"));
  assert.equal(out_until(s, "c"), null);
  // Rejected, but carrying on with extra usage (as a plan with it enabled reports every turn).
  on_rate_limit_event(s, "c", event("rejected"));
  const overage = { rate_limit_info: { status: "rejected", resetsAt: soon, overageStatus: "allowed", isUsingOverage: true } };
  on_rate_limit_event(s, "c", overage);
  assert.equal(out_until(s, "c"), null, "extra usage clears it");
  on_rate_limit_event(s, "d", overage);
  assert.equal(out_until(s, "d"), null);
  on_rate_limit_event(s, "d", { rate_limit_info: { status: "rejected", resetsAt: soon, overageStatus: "allowed_warning" } });
  assert.equal(out_until(s, "d"), null);
  // A reset that's past isn't out.
  on_rate_limit_event(s, "c", { rate_limit_info: { status: "rejected", resetsAt: soon - 1200 } });
  assert.equal(out_until(s, "c"), null);

  // Codex doesn't say which limit: the latest reset of those used up.
  const lim = (id: string, p: number, t: number): Limit => ({ id, label: id, percent: p, resets_at: rfc3339(t) });
  set_limits(s, "x", [lim("session", 100.0, soon), lim("weekly", 100.0, soon + 60), lim("weekly:x", 50.0, soon + 999)], null);
  codex_refused(s, "x");
  assert.equal(out_until(s, "x"), timestamp(soon + 60));
  set_limits(s, "y", [lim("session", 50.0, soon)], null);
  codex_refused(s, "y");
  assert.equal(out_until(s, "y"), null, "no reset known");
});

test("a_proxied_run_s_rate_limits_only_mark_it_out", () => {
  const s = testing.state();
  const soon = Math.floor(Date.now() / 1000) + 600;
  set_limits(s, "p", [{ id: "session", label: "Session", percent: 20.0, resets_at: null }], null);
  const event = (status: string) => ({ rate_limit_info: { status, resetsAt: soon, unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: soon } } } });
  // One account's numbers aren't the pool's.
  on_proxy_rate_limit_event(s, "p", event("allowed"));
  assert.equal(s.usage.get("p").limits[0].percent, 20.0);
  // A refusal the proxy passed on: every account it could try refused.
  on_proxy_rate_limit_event(s, "p", event("rejected"));
  assert.equal(out_until(s, "p"), timestamp(soon));
  assert.equal(s.usage.get("p").limits[0].percent, 20.0);
  on_proxy_rate_limit_event(s, "p", event("allowed"));
  assert.equal(out_until(s, "p"), null);
});

test("a_pool_s_limits_are_its_accounts_averaged_resetting_with_the_first", () => {
  const lim = (id: string, p: number, at: string | null): Limit => ({ id, label: id, percent: p, resets_at: at });
  const acct = (limits: Limit[]): Account => ({ name: "a", limits, error: null });
  const accounts = [
    acct([lim("session", 100.0, "2026-11-04T10:00:00Z"), lim("weekly", 40.0, "2026-11-09T00:00:00Z")]),
    acct([lim("session", 30.0, "2026-11-04T08:30:00+00:00"), lim("weekly", 20.0, null), lim("weekly:opus", 5.0, null)]),
    // Its usage couldn't be read: it counts for nothing.
    { name: "b", limits: [], error: "no" },
  ];
  assert.deepEqual(pool_limits(accounts), [
    lim("session", 65.0, "2026-11-04T08:30:00+00:00"),
    lim("weekly", 30.0, "2026-11-09T00:00:00Z"),
    lim("weekly:opus", 5.0, null),
  ]);
  assert.deepEqual(pool_limits([]), []);
});

function body(r: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    r.on("data", (c) => (b += c));
    r.on("end", () => resolve(b));
  });
}

/**
 * A CLIProxyAPI's management API with two Claude accounts (one whose usage fails), a Codex one
 * and a disabled one, answering only `key`. Its address, the requests it got, and how to stop it.
 */
async function fake_proxy(key: string): Promise<[string, any[], () => void]> {
  const seen: any[] = [];
  const server = createServer(async (r, res) => {
    const b = await body(r);
    const send = (status: number, v: any) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (r.headers.authorization !== `Bearer ${key}`) return send(401, { error: "invalid management key" });
    if (r.method === "GET" && r.url === "/v8/management/credentials") {
      return send(200, {
        files: [
          { auth_index: "a1", provider: "claude", email: "one@example.com", name: "claude-one.json", disabled: false },
          { auth_index: 2, provider: "claude", name: "claude-two.json", unavailable: true, status_message: "cooling down" },
          { auth_index: "c1", provider: "codex", email: "codex@example.com" },
          { auth_index: "d1", provider: "claude", email: "off@example.com", disabled: true },
        ],
      });
    }
    if (r.method === "POST" && r.url === "/v8/management/requests/api-call") {
      const v = JSON.parse(b);
      seen.push(v);
      const usage = { five_hour: { utilization: 40.0, resets_at: "2026-11-04T10:00:00Z" }, seven_day: { utilization: 10.0, resets_at: null } };
      if (v.auth_index === "a1") return send(200, { status_code: 200, header: {}, body: JSON.stringify(usage) });
      return send(200, { status_code: 401, header: {}, body: JSON.stringify({ error: { message: "token expired" } }) });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return [`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen, () => server.close()];
}

test("a_proxy_config_s_usage_is_its_claude_accounts", async () => {
  const s = testing.state();
  const [url, seen, close] = await fake_proxy("mk");
  try {
    const c = s.db();
    const made = db.insert_claude_config(c, "pool", "", "claude");
    let cfg = db.update_claude_config(c, made.id, [["show_usage", true], ["api_url", url], ["api_key", "k"]])!;
    // Without the management key, it says what's missing (and doesn't read ~/.claude's login).
    assert.ok(!(await refresh(s, cfg)));
    assert.ok(s.usage.get(cfg.id).error.includes("management key"), s.usage.get(cfg.id).error);
    const wrong = db.update_claude_config(s.db(), cfg.id, [["management_key", "nope"]])!;
    assert.ok(!(await refresh(s, wrong)));
    assert.ok(s.usage.get(cfg.id).error.includes("401"));

    cfg = db.update_claude_config(s.db(), cfg.id, [["management_key", "mk"]])!;
    assert.ok(await refresh(s, cfg));
    const u = s.usage.get(cfg.id);
    assert.equal(u.error, null);
    assert.equal(u.plan, "2 accounts");
    const accounts: Account[] = u.accounts;
    assert.deepEqual(accounts.map((a) => a.name), ["one@example.com", "claude-two.json"]);
    assert.deepEqual(accounts[0].limits.map((l) => [l.id, l.percent]), [["session", 40.0], ["weekly", 10.0]]);
    assert.deepEqual(accounts[1].limits, []);
    assert.equal(accounts[1].error, "Usage request failed (401): token expired");
    // The pool is the accounts that have numbers.
    assert.deepEqual(u.limits.map((l: Limit) => [l.id, l.percent]), [["session", 40.0], ["weekly", 10.0]]);
    // Each account's usage was asked for with its own token, by the proxy.
    assert.equal(seen.length, 2);
    assert.equal(seen[0].url, USAGE_URL);
    assert.equal(seen[0].header.Authorization, "Bearer $TOKEN$");
    // (Sent at once: they can arrive in either order.)
    assert.deepEqual(seen.map((b) => b.auth_index).sort(), ["2", "a1"]);
    // It's sent to the board with the accounts.
    const v = JSON.parse(JSON.stringify(s.usage.get(cfg.id)));
    assert.equal(v.accounts[1].name, "claude-two.json");
  } finally {
    close();
  }
});

test("a_reset_is_due_a_minute_after", () => {
  const at = (secs: number) => new Date(Date.now() + secs * 1000).toISOString().replace("Z", "+00:00");
  assert.ok(!reset_due(at(60)));
  assert.ok(!reset_due(at(-30)));
  assert.ok(reset_due(at(-61)));
});

test("merge_keeps_unmentioned_limits", () => {
  const lim = (id: string, p: number): Limit => ({ id, label: id, percent: p, resets_at: null });
  const u = Usage_new("");
  u.limits = [lim("weekly:fable", 3.0), lim("session", 10.0)];
  merge(u, [lim("weekly", 50.0), lim("session", 12.0)]);
  assert.deepEqual(u.limits, [lim("session", 12.0), lim("weekly", 50.0), lim("weekly:fable", 3.0)]);
});
