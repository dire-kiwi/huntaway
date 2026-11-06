// Port of server/src/agent/codex/rpc.rs.
/** A JSON-RPC client for `codex app-server`: requests, their responses, and replies to the server's requests. */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { program } from "../codex.ts";
import { VERSION } from "../../hosts/proto.ts";
import { context, expand_tilde } from "../../util.ts";

/** An unbounded channel (tokio's mpsc): `recv` gives the next value, or null once it's closed and drained. */
export class Channel<T> {
  private queue: T[] = [];
  private waiters: Array<(v: T | null) => void> = [];
  private closed = false;

  send(v: T): boolean {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) w(v);
    else this.queue.push(v);
    return true;
  }

  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  recv(): Promise<T | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
}

/** One `codex app-server` process. Messages are JSON lines without a `jsonrpc` field. */
export class Rpc {
  child: ChildProcess;
  private pending = new Map<number, Pending>();
  private next = 1;
  /** Why it couldn't be started, if it couldn't. */
  private failed: Error | null = null;
  private gone = false;
  /** Notifications and requests from the server, in order. */
  incoming = new Channel<any>();

  private constructor(child: ChildProcess) {
    this.child = child;
  }

  static start(codex_home: string | null, cwd: string): Rpc {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (codex_home != null && codex_home.trim() !== "") env.CODEX_HOME = expand_tilde(codex_home);
    const child = spawn(program(), ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    const rpc = new Rpc(child);
    child.on("error", (e) => {
      rpc.failed ??= context(`failed to start ${program()} app-server`, e);
      rpc.ended();
    });
    child.stdin!.on("error", () => {});
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let v: any;
      try {
        v = JSON.parse(line);
      } catch {
        return;
      }
      if (v === null || typeof v !== "object" || !("method" in v)) {
        // A response to one of our requests.
        if (!Number.isInteger(v?.id)) return;
        const p = rpc.pending.get(v.id);
        if (!p) return;
        rpc.pending.delete(v.id);
        if (v.error !== undefined) {
          const msg = typeof v.error?.message === "string" ? v.error.message : "request failed";
          p.reject(context(p.method, new Error(msg)));
        } else p.resolve(v.result ?? null);
      } else rpc.incoming.send(v);
    });
    lines.on("close", () => rpc.ended());
    return rpc;
  }

  /** The process is gone: fail whatever is still waiting. */
  private ended() {
    if (this.gone) return;
    this.gone = true;
    for (const p of this.pending.values()) p.reject(this.failed ?? new Error(`codex app-server exited during ${p.method}`));
    this.pending.clear();
    this.incoming.close();
  }

  private write(line: string): boolean {
    if (this.gone || !this.child.stdin || this.child.stdin.destroyed) return false;
    this.child.stdin.write(`${line}\n`);
    return true;
  }

  sender(): Responder {
    return new Responder((line) => this.write(line));
  }

  request(method: string, params: any): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (this.gone) return reject(this.failed ?? new Error("codex app-server exited"));
      this.pending.set(id, { resolve, reject, method });
      this.write(JSON.stringify({ id, method, params: params ?? null }));
    });
  }

  private notify(method: string) {
    this.write(JSON.stringify({ method }));
  }

  /** The handshake every client starts with. */
  async initialize(): Promise<any> {
    const info = { name: "huntaway", title: "Huntaway", version: VERSION };
    const r = await this.request("initialize", { clientInfo: info, capabilities: { experimentalApi: true } });
    this.notify("initialized");
    return r;
  }

  /** `start_kill` (and kill_on_drop). */
  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }

  /** Its exit status if it has exited, as Rust's `ExitStatus` shows. */
  exit_status(): string | null {
    if (this.child.exitCode !== null) return `exit status: ${this.child.exitCode}`;
    if (this.child.signalCode !== null) return `signal: ${this.child.signalCode}`;
    return null;
  }
}

/** Answers the server's requests; given to the tasks that wait on the board. */
export class Responder {
  send: (line: string) => any;
  constructor(send: (line: string) => any) {
    this.send = send;
  }

  result(id: any, result: any) {
    this.send(JSON.stringify({ id: id ?? null, result }));
  }

  error(id: any, message: string) {
    this.send(JSON.stringify({ id: id ?? null, error: { code: -32601, message } }));
  }
}
