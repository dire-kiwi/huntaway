import type { Board } from "../src/boards";
import { PendingShares, sharedDraft, sharedFileName, shareTargets, withDraft } from "../src/share";
import { redirectSystemPath } from "../src/app/+native-intent";

const NOW = 1730000000000;

describe("what a share puts in the composer", () => {
  test("text, with its link once", () => {
    expect(sharedDraft({ text: "Read this: https://example.com/a", webUrl: "https://example.com/a" }, NOW)).toEqual({ text: "Read this: https://example.com/a", files: [] });
    expect(sharedDraft({ text: "Read this", webUrl: "https://example.com/a" }, NOW)).toEqual({ text: "Read this\nhttps://example.com/a", files: [] });
    expect(sharedDraft({ text: "  just text \n", webUrl: null }, NOW)).toEqual({ text: "just text", files: [] });
  });

  test("a link on its own, with the page's title", () => {
    expect(sharedDraft({ text: "https://example.com/a", webUrl: "https://example.com/a", meta: { title: "A page" } }, NOW)?.text).toBe("A page\nhttps://example.com/a");
    // iOS shares a page as its URL, without text.
    expect(sharedDraft({ text: null, webUrl: "https://example.com/a", meta: { title: "A page" } }, NOW)?.text).toBe("A page\nhttps://example.com/a");
    expect(sharedDraft({ webUrl: "https://example.com/a" }, NOW)?.text).toBe("https://example.com/a");
  });

  test("photos and files, with names the host takes", () => {
    const d = sharedDraft(
      {
        files: [
          { path: "file:///cache/IMG 0001.HEIC", fileName: "IMG 0001.HEIC", mimeType: "image/heic", size: 1200 },
          { path: "file:///cache/x", fileName: null, mimeType: "image/jpeg", size: null },
          { path: null, fileName: "gone.png", mimeType: "image/png" },
          { path: "content://media/7", fileName: "../../Report (final).pdf", mimeType: "application/pdf", size: 9 },
        ],
      },
      NOW,
    );
    expect(d).toEqual({
      text: "",
      files: [
        { uri: "file:///cache/IMG 0001.HEIC", name: "IMG-0001.HEIC", mime: "image/heic", size: 1200 },
        { uri: "file:///cache/x", name: `photo-${NOW}-1.jpg`, mime: "image/jpeg", size: null },
        { uri: "content://media/7", name: "Report-final.pdf", mime: "application/pdf", size: 9 },
      ],
    });
    expect(sharedFileName("memo", "audio/mp4", 0, NOW)).toBe("memo.m4a");
    expect(sharedFileName("", "application/x-weird", 0, NOW)).toBe(`shared-${NOW}.bin`);
  });

  test("nothing shared is no draft", () => {
    expect(sharedDraft(null)).toBeNull();
    expect(sharedDraft({ text: "  ", webUrl: null, files: [] })).toBeNull();
    expect(sharedDraft({ files: [{ path: null }] })).toBeNull();
  });

  test("goes after what was already typed", () => {
    expect(withDraft("", "Shared")).toBe("Shared");
    expect(withDraft("Half a thought  ", "Shared")).toBe("Half a thought\n\nShared");
    expect(withDraft("Typed", " ")).toBe("Typed");
  });

  test("the iOS share extension's link opens the home tab, and other links are left alone", () => {
    expect(redirectSystemPath({ path: "huntaway://dataUrl=huntawayShareKey#text", initial: true })).toBe("/");
    expect(redirectSystemPath({ path: "/pair?url=https%3A%2F%2Fb&code=1", initial: false })).toBe("/pair?url=https%3A%2F%2Fb&code=1");
  });
});

describe("which board a share goes to", () => {
  const b = (id: string, apiVersion = 120): Board => ({ id, url: `https://${id}`, name: id, deviceId: "", apiVersion, profile: null, pairedAt: "" });
  const ok = () => ({ unauthorized: false, tooOld: false });

  test("the only board that can take it is used without asking", () => {
    const { only, boards } = shareTargets([b("work", 119), b("home")], ok, null);
    expect(only?.id).toBe("home");
    expect(boards.map((x) => x.id)).toEqual(["home"]);
  });

  test("with several, the last one picked comes first", () => {
    const { only, boards } = shareTargets([b("work"), b("home"), b("club")], ok, "club");
    expect(only).toBeUndefined();
    expect(boards.map((x) => x.id)).toEqual(["club", "work", "home"]);
  });

  test("boards that unpaired the phone, or are too old, can't take it", () => {
    const status = (id: string) => ({ unauthorized: id === "work", tooOld: id === "old" });
    expect(shareTargets([b("work"), b("old"), b("home")], status, "work").boards.map((x) => x.id)).toEqual(["home"]);
    expect(shareTargets([b("work")], status, null)).toEqual({ only: undefined, boards: [] });
  });
});

describe("the share waiting for the composer", () => {
  test("is sent to a board, and a newer share isn't cleared with an older one", () => {
    const shares = new PendingShares();
    const seen: unknown[] = [];
    shares.subscribe(() => seen.push(shares.get()?.id ?? null));
    const first = shares.put({ text: "one", files: [] });
    expect(first.boardId).toBeNull();
    shares.target("home");
    expect(shares.get()).toMatchObject({ id: first.id, boardId: "home" });
    const second = shares.put({ text: "two", files: [] });
    shares.clear(first.id);
    expect(shares.get()?.id).toBe(second.id);
    shares.clear(second.id);
    expect(shares.get()).toBeNull();
    expect(seen).toEqual([first.id, first.id, second.id, null]);
  });
});
