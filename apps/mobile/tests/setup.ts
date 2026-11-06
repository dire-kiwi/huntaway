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
