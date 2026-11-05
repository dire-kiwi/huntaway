// The Expo side of native push (see push.ts): the notification channels (Android) and the prompt category with Allow
// and Deny, this phone's Expo push token and its subscription on each paired board, and what taps on notifications do.
//
// Taps reach the app in different ways: on iOS always through the response listener (also when the app was killed, so
// it's added when this module is loaded, from index.ts); on Android through the listener while the app runs, and
// through a background task for an action tapped while it's in the background or killed. A tap that comes both ways
// is handled once (see responseHandler).
import { createClient, type PushDevice, type PushEvents } from "@huntaway/client";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { useRouter } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import type { Board } from "./boards";
import { memoryStorage } from "./pairing";
import {
  ALLOW,
  DENY,
  handledStore,
  PROMPT_CATEGORY,
  PushRegistrar,
  pushTarget,
  responseHandler,
  saveBoardUrls,
  savedBoardUrl,
  subscribedKey,
  type PushData,
  type Response,
  type Subscribed,
} from "./push";
import { lockScreenStore, secrets } from "./secrets";
import { boards, boardStatus, clientFor, statusOf, useBoards, useBoardStatuses } from "./session";

export const supported = Platform.OS === "ios" || Platform.OS === "android";

const BACKGROUND_TASK = "huntaway-notification-response";

/** What the phone calls itself on the boards. */
export const deviceName = () => Device.deviceName || Device.modelName || (Platform.OS === "ios" ? "iPhone" : "Android phone");

// ---------- setting up ----------

let configured: Promise<void> | null = null;

/** The channels, the prompt category and how notifications show while the app is open. Once. */
export function configure(): Promise<void> {
  if (!supported) return Promise.resolve();
  configured ??= (async () => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    });
    if (Platform.OS === "android") {
      // The server's channelId: prompts apart, so they can be loud while the rest stays quiet.
      await Notifications.setNotificationChannelAsync("default", { name: "Tasks", importance: Notifications.AndroidImportance.DEFAULT });
      await Notifications.setNotificationChannelAsync("prompts", {
        name: "Permission prompts",
        description: "An agent waits for you to allow or deny something.",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    await Notifications.setNotificationCategoryAsync(PROMPT_CATEGORY, [
      // Allowing needs the phone unlocked (iOS asks for Face ID or the passcode on the lock screen); denying doesn't.
      { identifier: ALLOW, buttonTitle: "Allow", options: { opensAppToForeground: false, isAuthenticationRequired: true } },
      { identifier: DENY, buttonTitle: "Deny", options: { opensAppToForeground: false, isDestructive: true } },
    ]);
  })().catch((e) => {
    configured = null;
    throw e;
  });
  return configured;
}

// ---------- taps ----------

let opener: ((d: PushData) => void) | null = null;
/** A push to open once the app's screens are up (a tap that started the app), when its boards have been read. */
let pendingPush: PushData | null = null;

type Router = ReturnType<typeof useRouter>;

/** Opens what push `d` is about: its task, or for the assistant's reply, the Assistant tab on its board and profile. */
async function openPush(router: Router, d: PushData) {
  const target = await pushTarget(d, {
    board: (id) => boards.board(id),
    status: (id) => boardStatus(id),
    client: (id) => {
      const b = boards.board(id);
      return b ? clientFor(b) : null;
    },
  });
  if (!target) return;
  if ("task" in target) return router.push(target.task);
  const { board, profile } = target.assistant;
  await boards.update(board, { profile });
  await boards.select(board);
  router.navigate("/");
}

const handle = responseHandler({
  // The boards aren't read in the background (and the keychain can't be while the phone is locked).
  boardUrl: async (id) => boards.board(id)?.url ?? savedBoardUrl(lockScreenStore, id),
  fetch: (url, init) => globalThis.fetch(url, init),
  open: (d) => (opener ? opener(d) : (pendingPush = d)),
  show: async (title, body, data) => {
    await Notifications.scheduleNotificationAsync({ content: { title, body, data: { ...data } }, trigger: Platform.OS === "android" ? { channelId: "prompts" } : null });
  },
  dismiss: (id) => Notifications.dismissNotificationAsync(id),
  // Readable in the background and on the lock screen, as the taps come.
  seen: handledStore(lockScreenStore),
});

/** From index.ts, before the app's screens: the listener and the background task for taps on notifications. */
export function startNotifications() {
  if (!supported) return;
  void configure().catch(() => {});
  Notifications.addNotificationResponseReceivedListener((r) => void handle(r));
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_TASK, async ({ data }) => {
    // Android's action taps in the background; plain taps open the app, whose listener has them.
    if (data && "actionIdentifier" in data && (data.actionIdentifier === ALLOW || data.actionIdentifier === DENY)) await handle(data as Response);
  });
  void Notifications.registerTaskAsync(BACKGROUND_TASK).catch(() => {});
}

// ---------- this phone's subscriptions ----------

export interface PushState {
  /** This phone's Expo push token, once had. */
  token: string | null;
  /** Why there's none: notifications not allowed, or a build without its EAS project id, or an error. */
  problem: "denied" | "no_project" | "unsupported" | string | null;
  /** By board id. */
  subscribed: Subscribed;
  /** The boards whose push was turned off here, but which can't have been told yet. */
  pendingOff: string[];
}

let state: PushState = { token: null, problem: supported ? null : "unsupported", subscribed: {}, pendingOff: [] };
const listeners = new Set<() => void>();
const set = (change: Partial<PushState>) => {
  state = { ...state, ...change };
  for (const fn of listeners) fn();
};

export const usePushState = () =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => state,
  );

/** Asked to show notifications at most once a run: Android asks again each time otherwise. */
let asked = false;

/** This phone's Expo push token, asking to show notifications first (once). */
async function expoToken(): Promise<{ token: string } | { retry: boolean }> {
  if (!supported) return { retry: false };
  if (state.token) return { token: state.token };
  try {
    await configure();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted" && !asked) {
      asked = true;
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") {
      set({ problem: "denied" });
      return { retry: false };
    }
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      set({ problem: "no_project" });
      return { retry: false };
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    set({ token, problem: null });
    return { token };
  } catch (e) {
    // Expo's token is fetched from Expo: offline, it fails, and is tried again.
    set({ problem: e instanceof Error ? e.message : String(e) });
    return { retry: true };
  }
}

export const registrar = new PushRegistrar({
  boards,
  store: secrets,
  expoToken,
  name: deviceName,
  clientFor: (b, token) =>
    token ? createClient({ baseUrl: b.url, getToken: () => token, setToken: () => {}, storage: memoryStorage() }) : clientFor(b),
  later: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
  onChange: () => set({ subscribed: registrar.subscribed, pendingOff: registrar.pending.filter((p) => p.kind === "unsubscribe").map((p) => p.board) }),
});

/** Turns push from `board` to this phone on or off (off is done on the board now, or once it can be reached). */
export const setBoardPush = (board: Board, on: boolean) => registrar.setPush(board.id, on);

/** Changes the events `board` pushes to this phone. */
export async function setBoardEvents(board: Board, device: PushDevice, events: PushEvents): Promise<PushDevice> {
  const changed = await clientFor(board).updatePushDevice(device.id, { events });
  registrar.noteDevice(board.id, changed);
  return changed;
}

/** Asks again (after notifications were allowed in the phone's settings, or the token changed). */
export function retryPush() {
  asked = false;
  set({ token: null, problem: null });
  void registrar.tokenChanged();
}

/**
 * Keeps this phone subscribed on each paired board that can push to it, and unsubscribed where that was turned off
 * or the board removed: done at start, again whenever a board's websocket connects (after the network or the app
 * came back, say) and when the token changes, and retried by itself after a failure. Also keeps the boards' addresses
 * for the lock screen, and opens what taps are about. Rendered once, at the root.
 */
export function PushSetup() {
  const router = useRouter();
  const { boards: list } = useBoards();
  const all = useBoardStatuses();

  useEffect(() => {
    if (!supported) return;
    opener = (d) => void openPush(router, d).catch(() => {});
    if (pendingPush) {
      const d = pendingPush;
      pendingPush = null;
      opener(d);
    }
    // A tap that started the app may have come before the listener did (and comes again on each start, which the
    // handler knows from the taps it keeps).
    void Notifications.getLastNotificationResponseAsync().then((r) => {
      if (!r) return;
      void handle(r);
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    });
    // Expo's token follows the device's, which can change.
    const rotated = Notifications.addPushTokenListener(() => retryPush());
    const app = AppState.addEventListener("change", (s) => {
      if (s === "active") void registrar.sync();
    });
    return () => {
      opener = null;
      rotated.remove();
      app.remove();
    };
  }, [router]);

  const urls = list.map((b) => `${b.id}=${b.url}`).join(" ");
  useEffect(() => {
    if (supported) void saveBoardUrls(lockScreenStore, list).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls]);

  // Each board as it is, and whether it's connected: a board that comes back is tried again.
  const key = list.map((b) => `${subscribedKey(b, "")}|${b.push !== false}|${b.apiVersion}|${statusOf(all, b.id).connected}`).join(" ");
  useEffect(() => {
    if (supported) void registrar.sync();
  }, [key]);
  return null;
}
