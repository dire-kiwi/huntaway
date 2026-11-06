/**
 * @jest-environment node
 */
/// <reference types="node" />
// The native setup the config plugins make, as `expo prebuild` and EAS Build see it: the iOS share extension's target
// (one app extension for EAS's credentials, with the app's own app group, so the extension can hand the share over),
// Android's share intents, and the microphone and speech permissions on both.
import { compileModsAsync } from "@expo/config-plugins";
import { getPrebuildConfigAsync } from "@expo/prebuild-config";
import path from "path";

const root = path.resolve(__dirname, "..");
// The plugins say what they add.
beforeAll(() => void jest.spyOn(console, "warn").mockImplementation(() => {}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

test("iOS: one share extension, in the app's app group, and the mic and speech permissions", async () => {
  const config = await getPrebuildConfigAsync(root, { platforms: ["ios"] });
  const bundle = config.exp.ios?.bundleIdentifier;
  const extensions = config.exp.extra?.eas?.build?.experimental?.ios?.appExtensions;
  expect(extensions).toEqual([
    { targetName: "HuntawayShare", bundleIdentifier: `${bundle}.share-extension`, entitlements: { "com.apple.security.application-groups": [`group.${bundle}`] } },
  ]);
  const plist = config.exp.ios?.infoPlist ?? {};
  expect(plist.NSMicrophoneUsageDescription).toMatch(/dictate/);
  expect(plist.NSSpeechRecognitionUsageDescription).toBeTruthy();
}, 60_000);

test("Android: share intents for text, photos and files, and recording audio isn't blocked by the camera's or image picker's settings", async () => {
  const config = await getPrebuildConfigAsync(root, { platforms: ["android"] });
  // As `expo config --type introspect` does: the mods run, without writing native files.
  const exp = await compileModsAsync(config.exp, { projectRoot: root, introspect: true, platforms: ["android"], assertMissingModProviders: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manifest = (exp as any)._internal.modResults.android.manifest.manifest;
  const permissions = (manifest["uses-permission"] ?? []).filter((p: Any) => p.$["tools:node"] !== "remove").map((p: Any) => p.$["android:name"]);
  expect(permissions).toContain("android.permission.RECORD_AUDIO");
  const filters = manifest.application[0].activity.find((a: Any) => a.$["android:name"] === ".MainActivity")["intent-filter"];
  const send = filters.find((f: Any) => f.action?.some((x: Any) => x.$["android:name"] === "android.intent.action.SEND"));
  expect(send.data.map((d: Any) => d.$["android:mimeType"])).toEqual(expect.arrayContaining(["text/*", "image/*"]));
}, 60_000);
