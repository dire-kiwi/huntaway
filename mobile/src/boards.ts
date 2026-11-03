// The boards this phone is paired with: a work hub and a personal board, say. Each has its own device token (kept in
// the keychain, see secrets.ts) and its own API client; the list itself (without tokens) is kept beside them. One is
// selected for the Projects tab, and each remembers the profile picked on it.

/** A paired board. Its `id` is the board's host id, which stays the same across restarts and re-pairing. */
export interface Board {
  id: string;
  /** Its HTTPS address, as the QR code gave it, without a trailing slash. */
  url: string;
  /** The board's host name, which labels its items in the inbox. */
  name: string;
  /** This phone's id among the board's devices (to unpair itself). */
  deviceId: string;
  /** The board's API version when it was last checked. */
  apiVersion: number;
  /** The profile (by name: boards merge profiles across their hosts by name) picked on it, if any. */
  profile: string | null;
  /** Push to this phone from it (API 103): on unless turned off here. */
  push?: boolean;
  pairedAt: string;
}

/** Async string storage, as expo-secure-store gives it (keys of letters, digits, `.`, `-` and `_`). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const LIST_KEY = "boards";
const SELECTED_KEY = "boards.selected";
/** A board's token's key: host ids are UUIDs, but anything else is made safe for the keychain. */
export const tokenKey = (id: string) => `token.${id.replace(/[^A-Za-z0-9._-]/g, "_")}`;

export interface BoardsState {
  boards: Board[];
  selected: string | null;
  loaded: boolean;
}

/** The paired boards and their tokens, kept in `store`. Subscribe for changes (it suits useSyncExternalStore). */
export class Boards {
  private state: BoardsState = { boards: [], selected: null, loaded: false };
  private tokens = new Map<string, string>();
  private listeners = new Set<() => void>();

  constructor(private store: SecretStore) {}

  get = (): BoardsState => this.state;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** A board's token, once loaded ("" if it has none). */
  token(id: string): string {
    return this.tokens.get(id) ?? "";
  }

  board(id: string): Board | undefined {
    return this.state.boards.find((b) => b.id === id);
  }

  selectedBoard(): Board | undefined {
    return this.board(this.state.selected ?? "") ?? this.state.boards[0];
  }

  /** Reads the list and the tokens. A board whose token is missing (the keychain was cleared) is dropped. */
  async load() {
    let list: Board[] = [];
    try {
      const raw = await this.store.get(LIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) list = parsed.filter((b) => b && typeof b.id === "string" && typeof b.url === "string");
    } catch {
      list = [];
    }
    const boards: Board[] = [];
    for (const b of list) {
      const token = await this.store.get(tokenKey(b.id)).catch(() => null);
      if (!token) continue;
      this.tokens.set(b.id, token);
      boards.push({ ...b, profile: b.profile ?? null, apiVersion: b.apiVersion ?? 0, deviceId: b.deviceId ?? "", name: b.name || b.url, pairedAt: b.pairedAt ?? "" });
    }
    const selected = await this.store.get(SELECTED_KEY).catch(() => null);
    this.set({ boards, selected: boards.some((b) => b.id === selected) ? selected : (boards[0]?.id ?? null), loaded: true });
    if (boards.length !== list.length) await this.saveList();
  }

  /** Adds a newly paired board, or replaces it (and its token) if it was paired before, and selects it. */
  async add(board: Board, token: string) {
    await this.store.set(tokenKey(board.id), token);
    this.tokens.set(board.id, token);
    const old = this.board(board.id);
    // Paired again: what was picked for it here stays (its profile, and push turned off).
    const next = { ...board, profile: board.profile ?? old?.profile ?? null, push: board.push ?? old?.push };
    const boards = old ? this.state.boards.map((b) => (b.id === board.id ? next : b)) : [...this.state.boards, next];
    this.set({ ...this.state, boards, selected: board.id });
    await this.saveList();
  }

  /** Forgets a board and its token; the next one is selected if it was. */
  async remove(id: string) {
    const boards = this.state.boards.filter((b) => b.id !== id);
    const selected = this.state.selected === id ? (boards[0]?.id ?? null) : this.state.selected;
    this.tokens.delete(id);
    this.set({ ...this.state, boards, selected });
    await this.store.delete(tokenKey(id)).catch(() => {});
    await this.saveList();
  }

  async select(id: string) {
    if (!this.board(id)) return;
    this.set({ ...this.state, selected: id });
    await this.store.set(SELECTED_KEY, id).catch(() => {});
  }

  /** Changes what's kept about a board (its profile, name, API version). */
  async update(id: string, change: Partial<Omit<Board, "id">>) {
    if (!this.board(id)) return;
    this.set({ ...this.state, boards: this.state.boards.map((b) => (b.id === id ? { ...b, ...change } : b)) });
    await this.saveList();
  }

  private async saveList() {
    await this.store.set(LIST_KEY, JSON.stringify(this.state.boards));
    if (this.state.selected) await this.store.set(SELECTED_KEY, this.state.selected).catch(() => {});
    else await this.store.delete(SELECTED_KEY).catch(() => {});
  }

  private set(state: BoardsState) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }
}
