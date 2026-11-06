import { clock, heard, NOTHING_HEARD, spoken, voiceNoteName, voiceNoteText, withSpeech } from "../src/dictation";

describe("what dictation heard", () => {
  test("iOS: each result is everything so far, and the final one ends it", () => {
    let h = heard(NOTHING_HEARD, "remind me", false);
    h = heard(h, "remind me to call", false);
    expect(spoken(h)).toBe("remind me to call");
    h = heard(h, "Remind me to call Sam.", true);
    expect(spoken(h)).toBe("Remind me to call Sam.");
  });

  test("Android: each stretch of speech is its own, and they're put together", () => {
    let h = heard(NOTHING_HEARD, "first", false);
    h = heard(h, "First part.", true);
    h = heard(h, "and", false);
    expect(spoken(h)).toBe("First part. and");
    h = heard(h, "And the second.", true);
    expect(spoken(h)).toBe("First part. And the second.");
  });

  test("goes after what was typed", () => {
    expect(withSpeech("", "Hello")).toBe("Hello");
    expect(withSpeech("Note:", "hello")).toBe("Note: hello");
    expect(withSpeech("Note:\n", "hello")).toBe("Note:\nhello");
    expect(withSpeech("Typed", "")).toBe("Typed");
  });

  test("voice notes", () => {
    expect(voiceNoteText("  call the plumber ")).toBe("Voice note, as the phone heard it: call the plumber");
    expect(voiceNoteText("")).toBe("");
    expect(voiceNoteName("file:///cache/recording_1.wav", 5)).toBe("voice-note-5.wav");
    expect(voiceNoteName("file:///cache/audio.caf", 5)).toBe("voice-note-5.caf");
    expect(clock(65_400)).toBe("1:05");
  });
});
