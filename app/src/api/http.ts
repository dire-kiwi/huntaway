const TOKEN_KEY = "ia.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

/** Pick up `?token=` from the URL (Electron and shared links pass it this way). */
export function captureTokenFromUrl() {
  const url = new URL(window.location.href);
  const t = url.searchParams.get("token");
  if (t) {
    setToken(t);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}

// Whether this board handed out its token last time ("1") or not ("0"), so that a load with a token stored needn't wait
// for /api/open-token, nor ask a board that doesn't hand it out (and have the browser log the 404).
const OPEN_KEY = "ia.openBoard";

const openFlag = () => {
  try {
    return localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
};

let openBoard = openFlag() === "1";

/** Whether this board hands out its token (`--open-token`), as PR previews do and the user's own boards never do. */
export const isOpenBoard = () => openBoard;

/** Whether to ask for the open token on this load: always without a token, else unless the board didn't hand it out before. */
export const shouldFetchOpenToken = () => !getToken() || openFlag() !== "0";

let fetching: Promise<boolean> | null = null;

/**
 * Servers started with `--open-token` (PR previews) hand out their token; sign in with it. Resolves to whether that
 * changed the token (a rebuilt preview's is new). Calls made at once share one request.
 */
export function fetchOpenToken(): Promise<boolean> {
  return (fetching ??= (async () => {
    try {
      const res = await fetch("/api/open-token");
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
    localStorage.setItem(OPEN_KEY, open);
  } catch {
    /* asked again next time */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Called when the server turns down a request, with the token it was made with. Only this board's token being wrong is
 * a 401: the hub answers a linked host turning down the link's token (its own changed since it was linked) with a 502.
 */
let onUnauthorized: (token: string) => void = () => {};

export function setUnauthorizedHandler(fn: (token: string) => void) {
  onUnauthorized = fn;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
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

export const get = <T>(p: string) => request<T>("GET", p);

export const post = <T>(p: string, b: unknown = {}) => request<T>("POST", p, b);

export const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);

export const del = <T>(p: string) => request<T>("DELETE", p);

/** An id in a path. */
export const enc = encodeURIComponent;

/** Requests for one host, through this node's hub (`/api/h/<host>/...`). */
export const on = (h: string) => ({
  get: <T>(p: string) => get<T>(`/h/${enc(h)}${p}`),
  post: <T>(p: string, b: unknown = {}) => post<T>(`/h/${enc(h)}${p}`, b),
  patch: <T>(p: string, b: unknown) => patch<T>(`/h/${enc(h)}${p}`, b),
  del: <T>(p: string) => del<T>(`/h/${enc(h)}${p}`),
});

export function wsUrl(path = "/ws") {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const sep = path.includes("?") ? "&" : "?";
  return `${proto}://${window.location.host}/api${path}${sep}token=${encodeURIComponent(getToken())}`;
}
