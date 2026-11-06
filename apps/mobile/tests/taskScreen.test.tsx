// HA-262: moving a task to In progress from the phone's Move menu only changed its status, so a fresh task sat in In
// progress with no agent. It starts it now, as dragging its card on the web board does.
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import TaskScreen from "../src/app/task/[board]/[host]/[id]";
import { boards } from "../src/session";

// A header button (headerRight) renders in place, as the header would show it.
jest.mock("expo-router", () => ({
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => unknown } }) => options?.headerRight?.() ?? null },
  useLocalSearchParams: () => ({ board: "home", host: "h", id: "t1" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../src/secrets", () => {
  const m = new Map<string, string>();
  return {
    secrets: {
      get: async (k: string) => m.get(k) ?? null,
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async (k: string) => void m.delete(k),
    },
  };
});
// The thread and the composer aren't what's tested: the task is shown as loaded. It has no host_id, as the API's tasks don't: the
// screen's host is the route's.
let mockTask: Record<string, unknown> = {};
const mockSetData = jest.fn();
jest.mock("../src/threadView", () => ({
  useThread: () => ({ detail: { setData: mockSetData }, thread: {}, task: mockTask }),
  ThreadMessages: () => null,
}));
jest.mock("../src/composer", () => ({ Composer: () => null }));

const mockClient = {
  hosts: jest.fn(async () => [{ id: "h", name: "desk", local: true, connected: true, mode: "local", api_version: 120 }]),
  updateTask: jest.fn(async (_h: string, id: string, b: object) => ({ ...mockTask, id, ...b })),
  send: jest.fn(async () => ({ ...mockTask, running: true })),
};
jest.mock("../src/session", () => ({ ...jest.requireActual("../src/session"), clientFor: () => mockClient }));

beforeEach(async () => {
  jest.clearAllMocks();
  await boards.add({ id: "home", url: "https://home", name: "home", deviceId: "d", apiVersion: 120, profile: null, pairedAt: "" }, "token");
});

const moveTo = async (status: string) => {
  await render(<TaskScreen />);
  await fireEvent.press(screen.getByRole("button", { name: "Move" }));
  await fireEvent.press(screen.getByRole("button", { name: status }));
  // The screen shows the task the move left.
  await waitFor(() => expect(mockSetData).toHaveBeenCalled());
};

test("a fresh task moved into In progress starts its agent", async () => {
  mockTask = { id: "t1", title: "Fresh", status: "todo", session_id: null, running: false };
  await moveTo("In progress");
  expect(mockClient.updateTask).toHaveBeenCalledWith("h", "t1", { status: "in_progress" });
  expect(mockClient.send).toHaveBeenCalledWith("h", "t1", "");
  expect(mockSetData).toHaveBeenCalledWith(expect.objectContaining({ running: true }));
});

test("one that has run before only moves", async () => {
  mockTask = { id: "t1", title: "Ran", status: "in_review", session_id: "s", running: false };
  await moveTo("In progress");
  expect(mockClient.updateTask).toHaveBeenCalledWith("h", "t1", { status: "in_progress" });
  expect(mockClient.send).not.toHaveBeenCalled();
});
