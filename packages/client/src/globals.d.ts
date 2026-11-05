// The web platform's globals that the client uses besides fetch (see ClientAdapter), which browsers and React Native
// both have: the part of them it uses, for checking it on its own without the DOM's types.
declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | Iterable<[string, string]>);
  append(name: string, value: string): void;
  set(name: string, value: string): void;
  toString(): string;
}
