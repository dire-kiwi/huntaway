// The app's live state: the paired boards, an API client for each (with its own token), each board's status (live,
// signed out, too old), and its websocket's events, which screens listen to.
import { createClient, type Client } from "@huntaway/client";
import * as Network from "expo-network";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { Boards, type Board } from "./boards";
import { BoardSocket, type BoardEvent } from "./live";
import { memoryStorage, tooOld } from "./pairing";
import { secrets } from "./secrets";

export const boards = new Boards(secrets);

export const useBoards = () => useSyncExternalStore(boards.subscribe, boards.get);

// ---------- clients ----------

const clients = new Map<string, { url: string; client: Client }>();

/** The API client for a board: its address and its own token. */
export function clientFor(board: Pick<Board, "id" | "url">): Client {
  const known = clients.get(board.id);
  if (known && known.url === board.url) return known.client;
  const client = createClient({
    baseUrl: board.url,
    getToken: () => boards.token(board.id),
    // A device's token is only ever replaced by pairing again.
    setToken: () => {},
    storage: memoryStorage(),
  });
  // Turned down: this phone was revoked on the board (or the board's data was reset).
  client.setUnauthorizedHandler((token) => {
    if (token && token === boards.token(board.id)) setStatus(board.id, { unauthorized: true });
  });
  clients.set(board.id, { url: board.url, client });
  return client;
}

// ---------- each board's status ----------

export interface BoardStatus {
  connected: boolean;
  /** Its token was turned down: the phone was revoked there, and needs pairing again. */
  unauthorized: boolean;
  /** It runs an API older than the app needs. */
  tooOld: boolean;
}

const NO_STATUS: BoardStatus = { connected: false, unauthorized: false, tooOld: false };
let statuses: Record<string, BoardStatus> = {};
const statusListeners = new Set<() => void>();

function setStatus(id: string, change: Partial<BoardStatus>) {
  const was = statuses[id] ?? NO_STATUS;
  if (Object.entries(change).every(([k, v]) => was[k as keyof BoardStatus] === v)) return;
  statuses = { ...statuses, [id]: { ...was, ...change } };
  for (const fn of statusListeners) fn();
}

export function useBoardStatuses(): Record<string, BoardStatus> {
  return useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => void statusListeners.delete(fn);
    },
    () => statuses,
  );
}

/** Forgets what was known of a board's status (it was paired again). */
export function clearStatus(id: string) {
  setStatus(id, { unauthorized: false, tooOld: false });
}

export const statusOf = (all: Record<string, BoardStatus>, id: string) => all[id] ?? NO_STATUS;

/** Whether a board can be used: paired and new enough. */
export const usable = (s: BoardStatus) => !s.unauthorized && !s.tooOld;

// ---------- events ----------

type Listener = (boardId: string, ev: BoardEvent) => void;
const eventListeners = new Set<Listener>();

/** Calls `fn` with each event from every paired board (the latest `fn`, without resubscribing). */
export function useBoardEvents(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (b, ev) => ref.current(b, ev);
    eventListeners.add(l);
    return () => void eventListeners.delete(l);
  }, []);
}

/** Calls `fn` at most once per `ms` after events that `matches` says are relevant (to refetch a list, say). */
export function useRefetchOn(matches: (boardId: string, ev: BoardEvent) => boolean, fn: () => void, ms = 600) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useBoardEvents((b, ev) => {
    if (!matches(b, ev) || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  });
}

// ---------- keeping in touch ----------

/** Checks a board's API version (and that its token still works), and notes it. */
async function checkBoard(board: Board) {
  const client = clientFor(board);
  try {
    const health = await client.health();
    const old = tooOld(health.api_version);
    setStatus(board.id, { tooOld: old });
    if (health.api_version && health.api_version !== board.apiVersion) await boards.update(board.id, { apiVersion: health.api_version });
    if (!old) {
      await client.devices();
      setStatus(board.id, { unauthorized: false });
    }
  } catch {
    /* unreachable for now: the socket keeps trying */
  }
}

/**
 * Keeps a websocket open to every usable paired board, and reconnects them when the app comes back to the front or
 * the network changes (checking the boards' versions again then). Rendered once, at the root.
 */
export function LiveUpdates() {
  const { boards: list } = useBoards();
  const all = useBoardStatuses();
  const sockets = useRef(new Map<string, { socket: BoardSocket; url: string }>());

  const live = list.filter((b) => usable(statusOf(all, b.id)));
  const key = live.map((b) => `${b.id}@${b.url}`).join(" ");
  useEffect(() => {
    const want = new Map(live.map((b) => [b.id, b]));
    for (const [id, s] of sockets.current) {
      if (want.get(id)?.url !== s.url) {
        s.socket.stop();
        sockets.current.delete(id);
        setStatus(id, { connected: false });
      }
    }
    for (const b of live) {
      if (sockets.current.has(b.id)) continue;
      const client = clientFor(b);
      const socket = new BoardSocket(
        () => client.wsUrl(),
        (ev) => {
          for (const l of eventListeners) l(b.id, ev);
        },
        undefined,
        (connected) => {
          setStatus(b.id, { connected });
          // Dropped: it may have been revoked, which only a request can tell.
          if (!connected) void checkBoard(b);
        },
      );
      sockets.current.set(b.id, { socket, url: b.url });
      socket.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => sockets.current.forEach((s) => s.socket.stop()), []);

  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    for (const b of listRef.current) void checkBoard(b);
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      for (const s of sockets.current.values()) s.socket.kick();
      for (const b of listRef.current) void checkBoard(b);
    });
    // A new network (Wi-Fi to cellular, say) leaves sockets that look open but go nowhere: open them again.
    const net = Network.addNetworkStateListener((state) => {
      if (state.isConnected) for (const s of sockets.current.values()) s.socket.kick(true);
    });
    return () => {
      app.remove();
      net.remove();
    };
  }, [list.length]);
  return null;
}

// ---------- reading ----------

/** A value read with `load`, again on `reload()`; it keeps the last value while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const gen = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    const g = ++gen.current;
    setState((s) => ({ ...s, loading: true }));
    loadRef
      .current()
      .then((data) => g === gen.current && setState({ data, loading: false }))
      .catch((e) => g === gen.current && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })));
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  const setData = useCallback((data: T | ((prev: T | undefined) => T)) => {
    // A change made here outdates a read under way.
    gen.current++;
    setState((s) => ({ ...s, loading: false, data: typeof data === "function" ? (data as (prev: T | undefined) => T)(s.data) : data }));
  }, []);
  return { ...state, reload, setData };
}
