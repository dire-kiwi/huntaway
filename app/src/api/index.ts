// The board's API for this page: the shared client (packages/client) for the board that served it, with its token in
// localStorage. The types and helpers are the package's.
import { createClient, type KeyValueStorage } from "@huntaway/client";

export * from "@huntaway/client";

// localStorage, read when used (the unit tests run without one); the client catches its errors.
const storage: KeyValueStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};

const TOKEN_KEY = "ia.token";

/** Every call to this page's board. */
export const api = createClient({
  baseUrl: "",
  getToken: () => storage.getItem(TOKEN_KEY) ?? "",
  setToken: (t) => storage.setItem(TOKEN_KEY, t),
  storage,
  wsBase: () => `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`,
});

export const { getToken, setToken, isOpenBoard, shouldFetchOpenToken, fetchOpenToken, setUnauthorizedHandler, wsUrl, movedHere, terminalWsUrl } = api;

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
