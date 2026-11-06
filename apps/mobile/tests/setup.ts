// Native modules the composer uses, faked for every test: speech recognition (see mocks/speech.ts) and reading a file
// on the phone (its base64 is "b64:<uri>").
jest.mock("expo-speech-recognition", () => require("./mocks/speech"));
jest.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get size() {
      return 3;
    }
    async base64() {
      return `b64:${this.uri}`;
    }
  },
}));

// Expo's runtime (which jest-expo installs) makes some globals lazy getters that load their polyfill when first read
// (expo/src/winter/runtime.native.ts), and Jest's teardown reads every global once the file's modules can no longer be
// loaded ("You are trying to `require` a file outside of the scope of the test code"). Read them while they still can:
// with pnpm's layout, nothing in tests/appConfig.test.ts reads them before then.
const LAZY_GLOBALS = [
  "TextDecoderStream",
  "TextEncoderStream",
  "URL",
  "URLSearchParams",
  "DOMException",
  "__ExpoImportMetaRegistry",
  "structuredClone",
  "fetch",
];
afterAll(() => {
  for (const name of LAZY_GLOBALS) void (globalThis as Record<string, unknown>)[name];
});
