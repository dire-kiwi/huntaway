import type { Fetch, FetchResponse } from "@huntaway/client";
import type { SecretStore } from "../src/boards";

/** A SecretStore in memory, with what's in it to look at. */
export function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

export type Route = (method: string, path: string, body: unknown, headers: Record<string, string>) => { status: number; body?: unknown } | undefined;

/** A fetch that answers from `route` (a 404 where it doesn't), and the requests made. */
export function fakeFetch(route: Route) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, body, headers: init.headers });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const res = route(init.method, path, body, init.headers) ?? { status: 404, body: { error: "no such API route" } };
    const response: FetchResponse = { ok: res.status < 300, status: res.status, statusText: String(res.status), json: async () => res.body };
    return response;
  };
  return { fetch, calls };
}
