import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Board } from "../src/boards";
import { shares } from "../src/share";
import { waitingNote, WaitingShare } from "../src/shareCard";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));

const board = { id: "home", url: "https://home", name: "home", deviceId: "", apiVersion: 106, profile: null, pairedAt: "" } as Board;
const names = (id: string) => ({ home: "home", work: "work" })[id];

describe("a waiting share on the Assistant tab", () => {
  test("says where it's waiting, and nothing while this composer takes it", () => {
    const p = (boardId: string | null) => ({ id: 1, boardId, draft: { text: "x", files: [] } });
    expect(waitingNote(null, board, names, false)).toBeNull();
    expect(waitingNote(p("home"), board, names, true)).toBeNull();
    expect(waitingNote(p("home"), board, names, false)).toMatch(/waits here until the assistant opens/);
    expect(waitingNote(p("work"), board, names, false)).toMatch(/waiting for work's assistant/);
    expect(waitingNote(p(null), board, names, false)).toMatch(/pick the board/);
  });

  test("shows what it is, and can be dropped", async () => {
    const pending = shares.put({ text: "A page\nhttps://example.com", files: [{ uri: "file:///a.jpg", name: "a.jpg", mime: "image/jpeg", size: 1 }] }, "home");
    await render(<WaitingShare pending={pending} board={board} boardName={names} taking={false} />);
    expect(screen.getByText("A page · a.jpg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pick a board" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Drop it" }));
    expect(shares.get()).toBeNull();
  });

  test("one that went to no board offers the board picker", async () => {
    const pending = shares.put({ text: "Hello", files: [] });
    await render(<WaitingShare pending={pending} board={board} boardName={names} taking={false} />);
    await fireEvent.press(screen.getByRole("button", { name: "Pick a board" }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/share", params: { id: String(pending.id) } });
    shares.clear(pending.id);
  });
});
