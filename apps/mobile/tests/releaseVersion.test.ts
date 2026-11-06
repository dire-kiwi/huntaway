// The release workflows' app versions (scripts/release-version.js): Android's versionCode must go up with each release.
const { versionCode, iosVersion } = require("../scripts/release-version.js") as typeof import("../scripts/release-version.js");

test("versionCode orders releases and their prereleases", () => {
  const order = ["0.2.8", "0.2.9-rc.1", "0.2.9-rc.2", "0.2.9", "0.3.0-beta", "0.3.0", "0.10.0", "1.0.0", "v1.0.1", "12.99.99"];
  const codes = order.map(versionCode);
  expect(codes).toEqual([...codes].sort((a, b) => a - b));
  expect(new Set(codes).size).toBe(codes.length);
  expect(versionCode("0.2.8")).toBe(208999);
  expect(versionCode("0.0.0-pr.140")).toBe(140);
});

test("versionCode refuses what it can't order", () => {
  expect(() => versionCode("1.100.0")).toThrow(/below 100/);
  expect(() => versionCode("1.2")).toThrow(/semver/);
  expect(() => versionCode("300.0.0")).toThrow(/too high/);
});

test("iOS gets the numbers only", () => {
  expect(iosVersion("v1.2.3-rc.4")).toBe("1.2.3");
  expect(iosVersion("1.2.3")).toBe("1.2.3");
});
