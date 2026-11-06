import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalLoads, withApproval } from "../src/approvals.ts";

const approval = (request_id, status = "pending", created_at = request_id, host_id = "desktop") => ({ request_id, status, created_at, host_id });
const ids = (list) => list.map((a) => a.request_id);

test("a pending approval is added once and an answered one removed", () => {
  let list = withApproval([], approval("b"));
  list = withApproval(list, approval("a"));
  list = withApproval(list, approval("a"));
  assert.deepEqual(ids(list), ["a", "b"]);
  assert.deepEqual(ids(withApproval(list, approval("a", "allowed"))), ["b"]);
  // The same request id on another host is another approval.
  assert.deepEqual(ids(withApproval(list, approval("a", "denied", "a", "laptop"))), ["a", "b"]);
});

test("a list that loaded while approvals changed doesn't undo them", () => {
  const loads = approvalLoads();
  const load = loads.start("desktop");
  // Asked after the list was read, and answered before it arrived.
  loads.changed(approval("new"));
  loads.changed(approval("old", "allowed"));
  // Another host's changes don't apply to this host's list.
  loads.changed(approval("other", "pending", "other", "laptop"));
  assert.deepEqual(ids(load.merge([approval("old"), approval("kept")])), ["kept", "new"]);
  load.done();
  // Changes after a load is done aren't kept for the next one.
  loads.changed(approval("later"));
  assert.deepEqual(ids(loads.start("desktop").merge([approval("kept")])), ["kept"]);
});

test("a list that loaded after a newer one started doesn't count", () => {
  const loads = approvalLoads();
  const older = loads.start("desktop");
  // A resync loads it again; the older list (with an approval answered since) arrives last.
  const newer = loads.start("desktop");
  const other = loads.start("laptop");
  assert.deepEqual(ids(newer.merge([])), []);
  assert.equal(older.merge([approval("answered")]), null);
  // Other hosts' loads are separate.
  assert.deepEqual(ids(other.merge([approval("a", "pending", "a", "laptop")])), ["a"]);
});
