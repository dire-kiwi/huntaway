// Requests to one board. Where it is, its token and what's remembered about it come from the app the client runs in (a
// ClientAdapter), so that an app can talk to several boards, with a client each; nothing here is kept per process.

/** Strings kept over restarts, as localStorage keeps them. It may throw (a browser that blocks storage): the client copes. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What the client reads of a `fetch` response. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<any>;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

/** What the app a client runs in tells it about the board it's for. */
export interface ClientAdapter {
  /** The board's address, such as `https://board.example.com:7878`, or "" for the one that served the page. */
  baseUrl: string;
  /** The board's token, kept where the app keeps secrets ("" for none yet). */
  getToken(): string;
  setToken(token: string): void;
  /** Where the client keeps what it remembers of this board besides its token: an app with several boards gives each its own. */
  storage: KeyValueStorage;
  /** The start of the board's websocket addresses, `ws(s)://host[:port]`; by default `baseUrl`'s, ws for http and wss for https. */
  wsBase?: () => string;
  /** `fetch` by default. */
  fetch?: Fetch;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** An id in a path. */
export const enc = encodeURIComponent;

// Whether this board handed out its token last time ("1") or not ("0"), so that a load with a token stored needn't wait
// for /api/open-token, nor ask a board that doesn't hand it out (and have the browser log the 404).
const OPEN_KEY = "ia.openBoard";

/** Requests to the board an adapter describes, and its token. */
export function createHttp(adapter: ClientAdapter) {
  const { baseUrl, storage } = adapter;
  const doFetch: Fetch = adapter.fetch ?? ((url, init) => (globalThis as unknown as { fetch: Fetch }).fetch(url, init));

  function getToken(): string {
    try {
      return adapter.getToken() ?? "";
    } catch {
      return "";
    }
  }

  function setToken(t: string) {
    try {
      adapter.setToken(t);
    } catch {
      /* ignore */
    }
  }

  const openFlag = () => {
    try {
      return storage.getItem(OPEN_KEY);
    } catch {
      return null;
    }
  };

  let openBoard = openFlag() === "1";

  /** Whether this board hands out its token (`--open-token`), as PR previews do and the user's own boards never do. */
  const isOpenBoard = () => openBoard;

  /** Whether to ask for the open token on this load: always without a token, else unless the board didn't hand it out before. */
  const shouldFetchOpenToken = () => !getToken() || openFlag() !== "0";

  let fetching: Promise<boolean> | null = null;

  /**
   * Servers started with `--open-token` (PR previews) hand out their token; sign in with it. Resolves to whether that
   * changed the token (a rebuilt preview's is new). Calls made at once share one request.
   */
  function fetchOpenToken(): Promise<boolean> {
    return (fetching ??= (async () => {
      try {
        const res = await doFetch(`${baseUrl}/api/open-token`, { method: "GET", headers: {} });
        const data = res.ok ? await res.json() : null;
        if (typeof data?.token === "string" && data.token) {
          openBoard = true;
          remember("1");
          if (data.token === getToken()) return false;
          setToken(data.token);
          return true;
        }
        if (res.status === 404) {
          openBoard = false;
          remember("0");
        }
      } catch {
        /* not offered */
      }
      return false;
    })().finally(() => (fetching = null)));
  }

  function remember(open: "0" | "1") {
    try {
      storage.setItem(OPEN_KEY, open);
    } catch {
      /* asked again next time */
    }
  }

  /**
   * Called when the server turns down a request, with the token it was made with. Only this board's token being wrong is
   * a 401: the hub answers a linked host turning down the link's token (its own changed since it was linked) with a 502.
   */
  let onUnauthorized: (token: string) => void = () => {};

  function setUnauthorizedHandler(fn: (token: string) => void) {
    onUnauthorized = fn;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = getToken();
    const res = await doFetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      onUnauthorized(token);
      throw new ApiError(401, "Unauthorized");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
    return data as T;
  }

  const get = <T>(p: string) => request<T>("GET", p);

  const post = <T>(p: string, b: unknown = {}) => request<T>("POST", p, b);

  const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);

  const del = <T>(p: string) => request<T>("DELETE", p);

  /** Requests for one host, through this node's hub (`/api/h/<host>/...`). */
  const on = (h: string) => ({
    get: <T>(p: string) => get<T>(`/h/${enc(h)}${p}`),
    post: <T>(p: string, b: unknown = {}) => post<T>(`/h/${enc(h)}${p}`, b),
    patch: <T>(p: string, b: unknown) => patch<T>(`/h/${enc(h)}${p}`, b),
    del: <T>(p: string) => del<T>(`/h/${enc(h)}${p}`),
  });

  const wsBase = adapter.wsBase ?? (() => baseUrl.replace(/^http/, "ws"));

  function wsUrl(path = "/ws") {
    const sep = path.includes("?") ? "&" : "?";
    return `${wsBase()}/api${path}${sep}token=${encodeURIComponent(getToken())}`;
  }

  return { storage, getToken, setToken, isOpenBoard, shouldFetchOpenToken, fetchOpenToken, setUnauthorizedHandler, request, get, post, patch, del, on, wsUrl };
}

export type Http = ReturnType<typeof createHttp>;
