// The Expo side of native push (see push.ts): the notification channels (Android) and the prompt category with Allow
// and Deny, this phone's Expo push token and its subscription on each paired board, and what taps on notifications do.
//
// Taps reach the app in different ways: on iOS always through the response listener (also when the app was killed, so
// it's added when this module is loaded, from index.ts); on Android through the listener while the app runs, and
// through a background task for an action tapped while it's in the background or killed. A tap that comes both ways
// is handled once (see responseHandler).
import { type PushDevice, type PushEvents } from "@huntaway/client";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { useRouter } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { Board } from "./boards";
import {
  ALLOW,
  DENY,
  PROMPT_CATEGORY,
  pushable,
  responseHandler,
  saveBoardUrls,
  savedBoardUrl,
  subscribeAll,
  subscribedKey,
  subscriptionOn,
  type Response,
  type Subscribed,
  type taskRoute,
} from "./push";
import { lockScreenStore } from "./secrets";
import { boards, clientFor, statusOf, usable, useBoards, useBoardStatuses } from "./session";

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

type Route = NonNullable<ReturnType<typeof taskRoute>>;
let opener: ((r: Route) => void) | null = null;
/** A task to open once the app's screens are up (a tap that started the app). */
let pendingRoute: Route | null = null;

const handle = responseHandler({
  // The boards aren't read in the background (and the keychain can't be while the phone is locked).
  boardUrl: async (id) => boards.board(id)?.url ?? savedBoardUrl(lockScreenStore, id),
  fetch: (url, init) => globalThis.fetch(url, init),
  open: (r) => (opener ? opener(r) : (pendingRoute = r)),
  show: async (title, body, data) => {
    await Notifications.scheduleNotificationAsync({ content: { title, body, data: { ...data } }, trigger: Platform.OS === "android" ? { channelId: "prompts" } : null });
  },
  dismiss: (id) => Notifications.dismissNotificationAsync(id),
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
}

let state: PushState = { token: null, problem: supported ? null : "unsupported", subscribed: {} };
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

/** The boards subscribed with the current token (see subscribedKey). */
const done = new Set<string>();

/** This phone's Expo push token, asking to show notifications first if `ask`. */
async function expoToken(ask: boolean): Promise<string | null> {
  if (!supported) return null;
  if (state.token) return state.token;
  try {
    await configure();
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted" && ask) status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") {
      set({ problem: "denied" });
      return null;
    }
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      set({ problem: "no_project" });
      return null;
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    set({ token, problem: null });
    return token;
  } catch (e) {
    set({ problem: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

async function subscribe(list: Board[]) {
  if (!list.length) return;
  const token = await expoToken(true);
  if (!token) return;
  const got = await subscribeAll(list, token, deviceName(), clientFor, done);
  if (Object.keys(got).length) set({ subscribed: { ...state.subscribed, ...got } });
}

/** Turns push from `board` to this phone on or off (off unsubscribes it there). */
export async function setBoardPush(board: Board, on: boolean) {
  await boards.update(board.id, { push: on });
  for (const k of [...done]) if (k.startsWith(`${board.id}|`)) done.delete(k);
  if (on) return subscribe([{ ...board, push: true }]);
  const device = state.subscribed[board.id]?.device ?? (await subscriptionOn(clientFor(board), state.token).catch(() => null));
  const { [board.id]: _, ...rest } = state.subscribed;
  set({ subscribed: rest });
  if (device) await clientFor(board).removePushDevice(device.id);
}

/** Changes the events `board` pushes to this phone. */
export async function setBoardEvents(board: Board, device: PushDevice, events: PushEvents): Promise<PushDevice> {
  const changed = await clientFor(board).updatePushDevice(device.id, { events });
  set({ subscribed: { ...state.subscribed, [board.id]: { device: changed } } });
  return changed;
}

/** Asks again (after notifications were allowed in the phone's settings, say). */
export function retryPush() {
  done.clear();
  set({ token: null, problem: null });
  void subscribe(boards.get().boards.filter(pushable));
}

/**
 * Keeps this phone subscribed on each usable paired board that can push to it (subscribed again when the app starts,
 * when a board is paired again and when the token changes), the boards' addresses saved for the lock screen, and taps
 * opening tasks. Rendered once, at the root.
 */
export function PushSetup() {
  const router = useRouter();
  const { boards: list } = useBoards();
  const all = useBoardStatuses();

  useEffect(() => {
    if (!supported) return;
    opener = (r) => router.push(r);
    if (pendingRoute) {
      const r = pendingRoute;
      pendingRoute = null;
      router.push(r);
    }
    // A tap that started the app may have come before the listener did.
    void Notifications.getLastNotificationResponseAsync().then((r) => {
      if (!r) return;
      void handle(r);
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    });
    // Expo's token follows the device's, which can change.
    const rotated = Notifications.addPushTokenListener(() => retryPush());
    return () => {
      opener = null;
      rotated.remove();
    };
  }, [router]);

  const urls = list.map((b) => `${b.id}=${b.url}`).join(" ");
  useEffect(() => {
    if (supported) void saveBoardUrls(lockScreenStore, list).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls]);

  const live = list.filter((b) => pushable(b) && usable(statusOf(all, b.id)));
  const key = live.map((b) => subscribedKey(b, "")).join(" ");
  useEffect(() => {
    if (supported) void subscribe(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return null;
}
