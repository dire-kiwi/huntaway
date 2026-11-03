// The Expo side (notifications.ts) with expo-notifications and expo-task-manager faked: the prompt category, and taps
// reaching the answer by the listener and by Android's background task.
const mockListeners: ((r: unknown) => void)[] = [];
const mockTasks: Record<string, (b: { data: unknown }) => Promise<void>> = {};
const mockExpo = {
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => ({})),
  addNotificationResponseReceivedListener: jest.fn((fn: (r: unknown) => void) => {
    mockListeners.push(fn);
    return { remove: () => {} };
  }),
  registerTaskAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => "shown"),
  dismissNotificationAsync: jest.fn(async () => {}),
  AndroidImportance: { DEFAULT: 5, HIGH: 6 },
};
jest.mock("expo-notifications", () => mockExpo);
jest.mock("expo-task-manager", () => ({ defineTask: (name: string, fn: (b: { data: unknown }) => Promise<void>) => (mockTasks[name] = fn) }));
jest.mock("expo-secure-store", () => {
  const data = new Map<string, string>();
  return {
    getItemAsync: async (k: string) => data.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void data.set(k, v),
    deleteItemAsync: async (k: string) => void data.delete(k),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
  };
});
jest.mock("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }));
jest.mock("expo-network", () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));

import { saveBoardUrls } from "../src/push";

const data = { board: "work", host: "h1", task_id: "t1", event: "prompt", request_id: "r1", answer: { url: "/api/permissions/r1/push-answer", token: "tok" } };
const notification = (id: string) => ({ request: { identifier: id, content: { title: "WEB-3 Fix the login", data } } });

beforeAll(async () => {
  // Required here, once the fakes above exist (imports would run before them).
  const { configure, startNotifications } = require("../src/notifications") as typeof import("../src/notifications");
  const { lockScreenStore } = require("../src/secrets") as typeof import("../src/secrets");
  startNotifications();
  await configure();
  // As the app saves them for the lock screen (the boards themselves aren't read in the background).
  await saveBoardUrls(lockScreenStore, [{ id: "work", url: "https://work.ts.net", name: "work", deviceId: "d", apiVersion: 102, profile: null, pairedAt: "" }]);
});

test("prompts have Allow (which needs the phone unlocked) and Deny, answered without opening the app", () => {
  expect(mockExpo.setNotificationCategoryAsync).toHaveBeenCalledWith("prompt", [
    { identifier: "allow", buttonTitle: "Allow", options: { opensAppToForeground: false, isAuthenticationRequired: true } },
    { identifier: "deny", buttonTitle: "Deny", options: { opensAppToForeground: false, isDestructive: true } },
  ]);
  expect(mockListeners).toHaveLength(1);
  expect(mockExpo.registerTaskAsync).toHaveBeenCalledWith("huntaway-notification-response");
});

test("an action tapped in the background answers once, however it arrives", async () => {
  const fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ result: "allowed", message: "Allowed." }) }));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  const response = { actionIdentifier: "allow", notification: notification("n1") };
  await Promise.all([mockTasks["huntaway-notification-response"]({ data: response }), (async () => mockListeners[0](response))()]);
  await new Promise((r) => setTimeout(r, 10));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("https://work.ts.net/api/permissions/r1/push-answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok", decision: "allow" }) }));
  expect(mockExpo.dismissNotificationAsync).toHaveBeenCalledWith("n1");
  expect(mockExpo.scheduleNotificationAsync).toHaveBeenCalledWith({ content: { title: "WEB-3 Fix the login", body: "Allowed.", data: expect.not.objectContaining({ answer: expect.anything() }) }, trigger: null });
  // A plain tap isn't the background task's (the app opens, and its listener has it).
  await mockTasks["huntaway-notification-response"]({ data: { actionIdentifier: "expo.modules.notifications.actions.DEFAULT", notification: notification("n2") } });
  expect(fetch).toHaveBeenCalledTimes(1);
});
