// Rust's `asana::tests` helpers (`pub(crate) mod tests`), which other modules' tests use: a fake Asana API. The tests
// themselves are in ../asana.test.ts.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { set_test_url } from "../asana.ts";

/** The token the fake Asana takes. */
export const TOKEN = "good-token";

function task_json(gid: string, name: string, completed: boolean) {
  return {
    gid,
    name,
    completed,
    permalink_url: `https://app.asana.com/0/1/${gid}`,
    notes: `Notes for ${name}`,
    assignee: { name: "Ivy" },
    projects: [{ name: "Web" }],
    workspace: { name: "Acme" },
  };
}

/** Starts a fake Asana API with two workspaces for this process's tests to call. */
export async function fake(): Promise<void> {
  const server = createServer((req, res) => {
    const send = (status: number, v: any) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errors: [{ message: "Not Authorized" }] });
    const url = new URL(req.url ?? "/", "http://x");
    let m: RegExpMatchArray | null;
    if (url.pathname === "/users/me") {
      return send(200, { data: { gid: "9", name: "Ivy", email: "ivy@example.com", workspaces: [{ gid: "100" }, { gid: "200" }] } });
    }
    if ((m = url.pathname.match(/^\/workspaces\/([^/]+)\/typeahead$/))) {
      if (url.searchParams.get("resource_type") !== "task") return send(500, { errors: [{ message: "resource_type must be task" }] });
      const all = m[1] === "100" ? [task_json("1001", "Fix login", true), task_json("1002", "Fix signup", false)] : [task_json("2001", "Write docs", false)];
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      return send(200, { data: all.filter((t) => t.name.toLowerCase().includes(query)) });
    }
    if ((m = url.pathname.match(/^\/tasks\/([^/]+)$/))) {
      if (m[1] === "1002") return send(200, { data: task_json("1002", "Fix signup", false) });
      return send(404, { errors: [{ message: "Unknown object" }] });
    }
    send(404, { errors: [{ message: "no such route" }] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  set_test_url(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}
