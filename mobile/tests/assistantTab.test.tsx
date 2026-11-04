// The Assistant tab switching profiles while a send to the last profile's assistant is under way: that send's answer
// mustn't become the new assistant's task, and Stop stops the assistant shown.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AssistantTab from "../src/app/(tabs)/index";
import { boards } from "../src/session";

// A header button (headerRight) renders in place, as the header would show it.
jest.mock("expo-router", () => ({
  Tabs: { Screen: ({ options }: { options?: { headerRight?: () => unknown } }) => options?.headerRight?.() ?? null },
  Redirect: () => null,
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("../src/secrets", () => {
  const m = new Map<string, string>();
  return { secrets: { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k) } };
});
jest.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 0 }));

const mockSends: ((t: unknown) => void)[] = [];
const mockClient = {
  hosts: jest.fn(async () => [{ id: "h", name: "desk", local: true, connected: true, mode: "local", api_version: 116 }]),
  profiles: jest.fn(async () => [
    { id: "pa", name: "A" },
    { id: "pb", name: "B" },
  ]),
  assistant: jest.fn(async (_h: string, profileId: string) => ({ id: profileId === "pa" ? "ta" : "tb", host_id: "h", running: false })),
  task: jest.fn(async (_h: string, id: string) => ({ task: { id, host_id: "h", running: true } })),
  messagePage: jest.fn(async () => ({ messages: [], more: false, subagents: [] })),
  send: jest.fn(() => new Promise((r) => mockSends.push(r))),
  stop: jest.fn(async () => ({ stopped: true })),
  uploadAttachment: jest.fn(),
};
jest.mock("../src/session", () => ({ ...jest.requireActual("../src/session"), clientFor: () => mockClient }));

test("a send to A that finishes after switching to B leaves B's assistant shown, and Stop stops B's", async () => {
  await boards.add({ id: "home", url: "https://home", name: "home", deviceId: "d", apiVersion: 116, profile: "A", pairedAt: "" }, "token");
  await render(<AssistantTab />);
  await waitFor(() => expect(mockClient.task).toHaveBeenCalledWith("h", "ta"));
  await fireEvent.changeText(await screen.findByLabelText("Message"), "For A");
  // Pressing settles when the send does, which is held.
  const pressed = fireEvent.press(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(mockClient.send).toHaveBeenCalledWith("h", "ta", "For A"));

  // The B chip, as the profile picker does.
  await fireEvent.press(screen.getByRole("button", { name: "B" }));
  await waitFor(() => expect(mockClient.task).toHaveBeenCalledWith("h", "tb"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy());
  expect(screen.getByLabelText("Message").props.value).toBe("");

  // A's send answers now, with A's task.
  await act(async () => {
    mockSends[0]({ id: "ta", host_id: "h", running: true });
    await pressed;
  });
  await fireEvent.press(screen.getByRole("button", { name: "Stop" }));
  expect(mockClient.stop).toHaveBeenCalledWith("h", "tb");
  expect(mockClient.stop).not.toHaveBeenCalledWith("h", "ta");
});
