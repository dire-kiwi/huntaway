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

describe("a share from another app", () => {
  const upload = () => jest.fn(async (_h: string, name: string, data: string) => ({ id: name, name, path: `/att/${name}`, data }) as never);

  test("fills the composer after what was typed, and uploads its files to the thread's host", async () => {
    const uploadAttachment = upload();
    const readFile = jest.fn(async (uri: string) => `b64:${uri}`);
    const onPrefilled = jest.fn();
    const send = jest.fn(async () => ({ id: "a1" }) as never);
    const props = { client: { send, uploadAttachment }, host: "vps", taskId: "a1", bottom: 0, onSent: () => {}, onPrefilled, readFile };
    const view = await render(<Composer {...props} />);
    await fireEvent.changeText(screen.getByLabelText("Message"), "Look at this");
    const prefill = { id: 1, text: "A page\nhttps://example.com/a", files: [{ uri: "file:///cache/cat.jpg", name: "cat.jpg", mime: "image/jpeg", size: 3 }] };
    await view.rerender(<Composer {...props} prefill={prefill} />);
    await waitFor(() => expect(screen.getByLabelText("Remove cat.jpg")).toBeTruthy());
    expect(screen.getByLabelText("Message").props.value).toBe("Look at this\n\nA page\nhttps://example.com/a");
    expect(onPrefilled).toHaveBeenCalledWith(1);
    expect(readFile).toHaveBeenCalledWith("file:///cache/cat.jpg", "cat.jpg");
    expect(uploadAttachment).toHaveBeenCalledWith("vps", "cat.jpg", "b64:file:///cache/cat.jpg");
    // The same share again (a re-render) isn't put in twice.
    await view.rerender(<Composer {...props} prefill={{ ...prefill }} />);
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Message").props.value).toBe("Look at this\n\nA page\nhttps://example.com/a");
    await fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("vps", "a1", "Look at this\n\nA page\nhttps://example.com/a\n\nAttached files:\n- /att/cat.jpg"));
  });

  test("a file that can't be read says why, and the rest still go", async () => {
    const uploadAttachment = upload();
    const readFile = jest.fn(async (uri: string, name: string) => {
      if (uri.endsWith("big.mov")) throw new Error(`${name} is larger than 10 MB, which is as large as an attachment can be`);
      return "x";
    });
    const files = [
      { uri: "file:///big.mov", name: "big.mov", mime: "video/quicktime", size: null },
      { uri: "file:///a.pdf", name: "a.pdf", mime: "application/pdf", size: 1 },
    ];
    await render(<Composer client={{ send: jest.fn(), uploadAttachment }} host="h" taskId="t" bottom={0} onSent={() => {}} readFile={readFile} prefill={{ id: 2, text: "", files }} />);
    await waitFor(() => expect(screen.getByLabelText("Remove a.pdf")).toBeTruthy());
    expect(screen.getByText(/big.mov is larger than 10 MB/)).toBeTruthy();
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("the mic", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const speech = require("./mocks/speech") as typeof import("./mocks/speech");
  const mod = speech.ExpoSpeechRecognitionModule;
  beforeEach(() => jest.clearAllMocks());

  test("dictates into the field after what was typed, on the phone where it can", async () => {
    await render(<Composer client={{ send: jest.fn(), uploadAttachment: jest.fn() }} host="h" taskId="t" bottom={0} onSent={() => {}} />);
    await fireEvent.changeText(screen.getByLabelText("Message"), "Note:");
    await fireEvent.press(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(mod.start).toHaveBeenCalledTimes(1));
    expect(mod.start.mock.calls[0][0]).toMatchObject({ interimResults: true, requiresOnDeviceRecognition: true, recordingOptions: undefined });
    expect(screen.getByText(/Listening · on this phone/)).toBeTruthy();
    await act(async () => speech.emit("result", speech.result("buy")));
    expect(screen.getByLabelText("Message").props.value).toBe("Note: buy");
    await act(async () => speech.emit("result", speech.result("Buy milk.", true)));
    expect(screen.getByLabelText("Message").props.value).toBe("Note: Buy milk.");
    // Not sent mid-dictation: what's heard next would write the sent text back.
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole("button", { name: "Done" }));
    expect(mod.stop).toHaveBeenCalled();
    await act(async () => speech.emit("end"));
    expect(screen.queryByText(/Listening/)).toBeNull();
    expect(screen.getByLabelText("Message").props.value).toBe("Note: Buy milk.");
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  test("tries the phone's recognition service when the language isn't on the device", async () => {
    await render(<Composer client={{ send: jest.fn(), uploadAttachment: jest.fn() }} host="h" taskId="t" bottom={0} onSent={() => {}} />);
    await fireEvent.press(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(mod.start).toHaveBeenCalledTimes(1));
    await act(async () => speech.emit("error", { error: "language-not-supported", message: "nope" }));
    await act(async () => speech.emit("end"));
    expect(mod.start).toHaveBeenCalledTimes(2);
    expect(mod.start.mock.calls[1][0]).toMatchObject({ requiresOnDeviceRecognition: false });
    expect(screen.getByText("Listening")).toBeTruthy();
    expect(screen.queryByText(/nope/)).toBeNull();
  });

  test("held, records a voice note, attached with what was heard of it", async () => {
    const uploadAttachment = jest.fn(async (_h: string, name: string) => ({ id: name, name, path: `/att/${name}` }) as never);
    const readFile = jest.fn(async () => "UklGRg==");
    await render(<Composer client={{ send: jest.fn(), uploadAttachment }} host="vps" taskId="t" bottom={0} onSent={() => {}} readFile={readFile} />);
    await fireEvent(screen.getByRole("button", { name: "Dictate" }), "longPress");
    await waitFor(() => expect(mod.start).toHaveBeenCalledTimes(1));
    expect(mod.start.mock.calls[0][0]).toMatchObject({ continuous: true, recordingOptions: { persist: true } });
    expect(screen.getByText(/Voice note 0:00/)).toBeTruthy();
    await act(async () => speech.emit("result", speech.result("Call the plumber", true)));
    // The field isn't written while recording; the transcript shows on the bar.
    expect(screen.getByLabelText("Message").props.value).toBe("");
    expect(screen.getByRole("button", { name: "Send" }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole("button", { name: "Attach" }));
    expect(mod.stop).toHaveBeenCalled();
    await act(async () => {
      speech.emit("audioend", { uri: "file:///cache/recording_1.wav", timestamp: 0 });
      speech.emit("end");
    });
    await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));
    expect(uploadAttachment.mock.calls[0][0]).toBe("vps");
    expect(uploadAttachment.mock.calls[0][1]).toMatch(/^voice-note-\d+\.wav$/);
    expect(readFile).toHaveBeenCalledWith("file:///cache/recording_1.wav", "The voice note");
    expect(screen.getByLabelText("Message").props.value).toBe("Voice note, as the phone heard it: Call the plumber");
    expect(screen.getByLabelText(/Remove voice-note-/)).toBeTruthy();
  });

  test("a voice note can be dropped", async () => {
    const uploadAttachment = jest.fn();
    await render(<Composer client={{ send: jest.fn(), uploadAttachment }} host="h" taskId="t" bottom={0} onSent={() => {}} />);
    await fireEvent(screen.getByRole("button", { name: "Dictate" }), "longPress");
    await waitFor(() => expect(mod.start).toHaveBeenCalled());
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(mod.abort).toHaveBeenCalled();
    await act(async () => {
      speech.emit("audioend", { uri: "file:///cache/recording_2.wav", timestamp: 0 });
      speech.emit("end");
    });
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText(/Voice note/)).toBeNull();
  });

  test("says why when it can't listen", async () => {
    mod.supportsRecording.mockReturnValueOnce(false);
    await render(<Composer client={{ send: jest.fn(), uploadAttachment: jest.fn() }} host="h" taskId="t" bottom={0} onSent={() => {}} />);
    await fireEvent(screen.getByRole("button", { name: "Dictate" }), "longPress");
    await waitFor(() => expect(screen.getByText("Voice notes need Android 13 or later.")).toBeTruthy());
    mod.requestPermissionsAsync.mockResolvedValueOnce({ granted: false });
    await fireEvent.press(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(screen.getByText(/access is off for Huntaway/)).toBeTruthy());
    expect(mod.start).not.toHaveBeenCalled();
  });
});
