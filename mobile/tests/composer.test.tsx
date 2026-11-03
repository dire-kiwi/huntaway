import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { afterSend, Composer } from "../src/composer";

jest.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  launchImageLibraryAsync: async () => ({ canceled: false, assets: [{ base64: "aGk=", fileName: "cat.jpg", mimeType: "image/jpeg" }] }),
}));

test("what's left in the field once a message has gone", () => {
  expect(afterSend("First", "First")).toBe("");
  expect(afterSend("Next unsent message", "First")).toBe("Next unsent message");
  expect(afterSend("First\nand more", "First")).toBe("and more");
});

test("a draft typed while a message is being sent stays", async () => {
  let release: (t: unknown) => void = () => {};
  const send = jest.fn(() => new Promise((r) => (release = r)) as never);
  const onSent = jest.fn();
  await render(<Composer client={{ send, uploadAttachment: jest.fn() }} host="h" taskId="t" bottom={0} onSent={onSent} />);
  const field = screen.getByLabelText("Message");
  await fireEvent.changeText(field, "First message");
  // Pressing doesn't settle until the send does, which is held.
  const pressed = fireEvent.press(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("h", "t", "First message"));
  // The button's busy meanwhile, and the field takes the next message.
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
  await fireEvent.changeText(screen.getByLabelText("Message"), "Next unsent message");
  release({ id: "t" });
  await act(async () => pressed);
  await waitFor(() => expect(onSent).toHaveBeenCalledWith({ id: "t" }));
  expect(screen.getByLabelText("Message").props.value).toBe("Next unsent message");
  expect(send).toHaveBeenCalledTimes(1);
});

test("an unchanged draft is cleared once sent", async () => {
  const send = jest.fn(async () => ({ id: "t" }) as never);
  await render(<Composer client={{ send, uploadAttachment: jest.fn() }} host="h" taskId="t" bottom={0} onSent={() => {}} />);
  await fireEvent.changeText(screen.getByLabelText("Message"), "Hello");
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(screen.getByLabelText("Message").props.value).toBe(""));
});

test("a photo uploaded while a message is sending doesn't let the message be sent again", async () => {
  let release: (t: unknown) => void = () => {};
  const send = jest.fn(() => new Promise((r) => (release = r)) as never);
  const uploadAttachment = jest.fn(async () => ({ id: "a1", name: "cat.jpg", path: "/att/cat.jpg" }) as never);
  await render(<Composer client={{ send, uploadAttachment }} host="h" taskId="t" bottom={0} onSent={() => {}} />);
  await fireEvent.changeText(screen.getByLabelText("Message"), "Once");
  const pressed = fireEvent.press(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  // A photo picked and uploaded meanwhile.
  await fireEvent.press(screen.getByRole("button", { name: "🖼" }));
  await waitFor(() => expect(screen.getByLabelText("Remove cat.jpg")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true });
  await fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(send).toHaveBeenCalledTimes(1);
  release({ id: "t" });
  await act(async () => pressed);
  // The photo came after: it stays for the next message, and the sent text is gone.
  expect(screen.getByLabelText("Remove cat.jpg")).toBeTruthy();
  expect(screen.getByLabelText("Message").props.value).toBe("");
});
