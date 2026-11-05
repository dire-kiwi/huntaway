import { render } from "@testing-library/react-native";
import { boards } from "../src/session";
import { shares } from "../src/share";
import { ShareHandler } from "../src/shareHandler";

const mockRouter = { push: jest.fn(), setParams: jest.fn(), navigate: jest.fn() };
let mockPath = "/";
jest.mock("expo-router", () => ({ useRouter: () => mockRouter, usePathname: () => mockPath, useRootNavigationState: () => ({ key: "root" }) }));
const mockIntent = { hasShareIntent: true, shareIntent: { text: "Read this", webUrl: null }, resetShareIntent: jest.fn(), error: null };
jest.mock("expo-share-intent", () => ({ useShareIntentContext: () => mockIntent }));

const b = (id: string) => ({ id, url: `https://${id}`, name: id, deviceId: "", apiVersion: 120, profile: null, pairedAt: "" });

beforeAll(async () => {
  await boards.add(b("work"), "w");
  await boards.add(b("home"), "h");
});
beforeEach(() => jest.clearAllMocks());

test("with several boards, a share asks which", async () => {
  mockPath = "/";
  await render(<ShareHandler />);
  expect(mockIntent.resetShareIntent).toHaveBeenCalled();
  expect(shares.get()?.draft.text).toBe("Read this");
  expect(mockRouter.push).toHaveBeenCalledWith({ pathname: "/share", params: { id: String(shares.get()!.id) } });
});

test("a second share while the share screen is open takes the first's place, not another screen on top", async () => {
  mockPath = "/share";
  const first = shares.get()!.id;
  mockIntent.shareIntent = { text: "And this", webUrl: null };
  await render(<ShareHandler />);
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(shares.get()).toMatchObject({ draft: { text: "And this" } });
  expect(shares.get()!.id).not.toBe(first);
  expect(mockRouter.setParams).toHaveBeenCalledWith({ id: String(shares.get()!.id) });
});
