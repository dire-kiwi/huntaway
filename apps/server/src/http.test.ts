import { afterAll, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { ApiError, readBody } from "./http.ts";
import { sleep } from "./util.ts";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

/** A server that reads bodies with `readBody(req, limit, drain_ms)` and answers with what it read, or its 413. */
async function server(limit: number, drain_ms?: number) {
  const srv = createServer(async (req, res) => {
    try {
      const raw = await readBody(req, limit, drain_ms);
      answer(res, 200, {}, `read ${raw.length}`);
    } catch (e) {
      answer(res, e instanceof ApiError ? e.status : 500, { connection: "close" }, String(e));
    }
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return (srv.address() as AddressInfo).port;
}

function answer(res: ServerResponse, status: number, headers: Record<string, string>, body: string) {
  res.writeHead(status, { ...headers, "content-length": String(Buffer.byteLength(body)) }).end(body);
}

/** A connection that has sent the headers of a POST with a body of `length` bytes. */
async function post(port: number, length: number) {
  const sock: Socket = connect(port, "127.0.0.1");
  let answer = "";
  sock.on("data", (c: Buffer) => (answer += c.toString("utf8")));
  sock.on("error", () => {});
  const closed = new Promise<void>((r) => sock.once("close", () => r()));
  await new Promise<void>((r) => sock.once("connect", r));
  sock.write(`POST / HTTP/1.1\r\nhost: x\r\ncontent-length: ${length}\r\n\r\n`);
  const write = (b: Buffer) => new Promise<void>((r, j) => sock.write(b, (e) => (e ? j(e) : r())));
  return { sock, write, closed, answer: () => answer };
}

test("a_body_within_the_limit_is_read", async () => {
  const port = await server(1000);
  const c = await post(port, 1000);
  await c.write(Buffer.alloc(1000, "x"));
  while (!c.answer().includes("read")) await sleep(10);
  assert.match(c.answer(), /^HTTP\/1\.1 200 .*read 1000$/s);
  c.sock.destroy();
});

test("a_body_over_the_limit_is_answered_413_once_it_has_all_been_read", async () => {
  const port = await server(1000);
  const c = await post(port, 5000);
  // Well past the limit, and nothing back yet: the rest is still to come.
  await c.write(Buffer.alloc(3000, "x"));
  await sleep(200);
  assert.equal(c.answer(), "");
  await c.write(Buffer.alloc(2000, "x"));
  await c.closed;
  assert.match(c.answer(), /^HTTP\/1\.1 413 .*length limit exceeded$/s);
});

test("a_client_still_sending_after_the_drain_time_gets_its_413_then", async () => {
  const port = await server(1000, 300);
  const c = await post(port, 1 << 20);
  await c.write(Buffer.alloc(3000, "x"));
  const t = Date.now();
  await c.closed;
  assert.ok(Date.now() - t >= 250, `answered after ${Date.now() - t} ms`);
  assert.match(c.answer(), /^HTTP\/1\.1 413 /);
});
