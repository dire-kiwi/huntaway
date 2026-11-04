// The HTTP plumbing axum gave the Rust server: a route table with path parameters, handlers that return JSON or throw
// ApiError, and websocket routes. Requests can also be answered in-process (the hub's proxy to this host, tunnels).
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import type { AppState } from "./state.ts";
import { err_str } from "./util.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
  static bad(msg: string) {
    return new ApiError(400, msg);
  }
  static not_found(what: string) {
    return new ApiError(404, `${what} not found`);
  }
  static conflict(msg: string) {
    return new ApiError(409, msg);
  }
}

/** A response other than a 200 with a JSON body. A Buffer or string body is sent as is. */
export class Reply {
  status: number;
  body: any;
  headers: Record<string, string>;
  constructor(status: number, body: any, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export interface Req {
  method: string;
  /** The path, without the query. */
  path: string;
  params: Record<string, string>;
  /** The query string's values (the last of a repeated key). */
  query: Record<string, string>;
  /** The query string as given (without `?`). */
  query_string: string;
  headers: IncomingHttpHeaders;
  /** The parsed JSON body: `{}` when it's empty, or `null` when it isn't JSON. */
  body: any;
  raw: Buffer;
  /** What a websocket route's `pre` check returned. */
  pre?: any;
  /** The node request, for routes served over HTTP (absent for in-process requests). */
  incoming?: IncomingMessage;
}

export type Handler = (s: AppState, r: Req) => any;
export type WsHandler = (s: AppState, r: Req, ws: WebSocket) => void;

interface Route {
  segs: string[];
  methods: Map<string, Handler>;
  ws?: WsHandler;
  /** Checks a websocket request before it's upgraded (see RouteOpts.pre). */
  pre?: (s: AppState, r: Req) => any;
  /** Body limit in bytes. */
  limit: number;
  /** Whether it needs the board's token. */
  auth: boolean;
}

export const DEFAULT_LIMIT = 2 << 20;

export interface RouteOpts {
  limit?: number;
  auth?: boolean;
  /**
   * For a websocket route: runs before the upgrade, as an axum handler does before `on_upgrade`. What it throws is the
   * answer instead (an ApiError's status and `{"error"}`), and what it returns is the handler's `r.pre`.
   */
  pre?: (s: AppState, r: Req) => any;
}

/** A route table: `/tasks/{id}`, `/h/{host_id}/{*rest}`. */
export class Router {
  routes: Route[] = [];

  private add(path: string, opts: RouteOpts): Route {
    const segs = path.split("/").filter(Boolean);
    let r = this.routes.find((x) => x.segs.join("/") === segs.join("/"));
    if (!r) {
      r = { segs, methods: new Map(), limit: opts.limit ?? DEFAULT_LIMIT, auth: opts.auth ?? true };
      this.routes.push(r);
    }
    if (opts.limit) r.limit = opts.limit;
    if (opts.auth !== undefined) r.auth = opts.auth;
    return r;
  }

  /** `methods` maps GET/POST/PATCH/DELETE (or ANY) to a handler. */
  route(path: string, methods: Record<string, Handler | undefined>, opts: RouteOpts = {}): this {
    const r = this.add(path, opts);
    for (const [m, h] of Object.entries(methods)) r.methods.set(m.toUpperCase(), h ?? notPorted(`${m.toUpperCase()} ${path}`));
    return this;
  }

  ws(path: string, h: WsHandler | undefined, opts: RouteOpts = {}): this {
    const r = this.add(path, opts);
    r.ws = h ?? (() => {});
    if (opts.pre) r.pre = opts.pre;
    r.methods.set("GET", r.methods.get("GET") ?? (() => new Reply(400, { error: "expected a websocket upgrade" })));
    return this;
  }

  /** The route for `path`, with its parameters. Static segments win over parameters. */
  find(path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    const rawParts = path.split("/").filter(Boolean);
    let best: { route: Route; params: Record<string, string>; score: number } | null = null;
    for (const route of this.routes) {
      const params: Record<string, string> = {};
      let score = 0;
      let ok = true;
      let i = 0;
      for (; i < route.segs.length; i++) {
        const seg = route.segs[i];
        if (seg.startsWith("{*")) {
          if (i >= parts.length) {
            ok = false;
            break;
          }
          params[seg.slice(2, -1)] = rawParts.slice(i).map((p) => safeDecode(p)).join("/");
          i = parts.length;
          break;
        }
        if (i >= parts.length) {
          ok = false;
          break;
        }
        if (seg.startsWith("{")) params[seg.slice(1, -1)] = parts[i];
        else if (seg === parts[i]) score += 2;
        else {
          ok = false;
          break;
        }
      }
      if (!ok || i !== parts.length) continue;
      if (!best || score > best.score) best = { route, params, score };
    }
    return best && { route: best.route, params: best.params };
  }
}

const safeDecode = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

function notPorted(what: string): Handler {
  return () => new Reply(501, { error: `not ported to the TypeScript server: ${what}` });
}

/** The start of the error for an `/api/...` path with no route (so it isn't served the UI). */
export const NO_ROUTE = "no such API route";

export function no_route_error(method: string, path: string) {
  return { error: `${NO_ROUTE}: ${method} ${path.split("?")[0]}` };
}

export function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) out[k] = v;
  return out;
}

export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonAnswer(status: number, v: any): Answer {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(v ?? null)) };
}

/** Turn what a handler returned (or threw) into a response. */
export function toAnswer(v: any): Answer {
  if (v instanceof Reply) {
    if (Buffer.isBuffer(v.body) || typeof v.body === "string") {
      return { status: v.status, headers: { "content-type": "text/plain; charset=utf-8", ...v.headers }, body: Buffer.from(v.body as any) };
    }
    const a = jsonAnswer(v.status, v.body);
    a.headers = { ...a.headers, ...v.headers };
    return a;
  }
  return jsonAnswer(200, v === undefined ? null : v);
}

export function errorAnswer(e: any): Answer {
  if (e instanceof ApiError) return jsonAnswer(e.status, { error: e.message });
  // A Reply thrown is a response made before the handler ran (axum's rejections: a body or query it can't read).
  if (e instanceof Reply) return toAnswer(e);
  return jsonAnswer(500, { error: err_str(e) });
}

/** Run a handler on a request, catching what it throws. */
export async function call(h: Handler, s: AppState, r: Req): Promise<Answer> {
  try {
    return toAnswer(await h(s, r));
  } catch (e) {
    if (!(e instanceof ApiError) && !(e instanceof Reply)) console.error(`${r.method} ${r.path}:`, e);
    return errorAnswer(e);
  }
}

export function parseBody(raw: Buffer): any {
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, "length limit exceeded"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function send(res: ServerResponse, a: Answer) {
  res.writeHead(a.status, { ...a.headers, "content-length": String(a.body.length) });
  res.end(a.body);
}
