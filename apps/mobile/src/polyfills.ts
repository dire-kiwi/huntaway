// What the app's code (and packages/client, contracts, a2ui) calls that Hermes lacks (HE-98): ES2023's copying array
// methods. Without them the network search died on `toSorted` before it asked anyone, and the inbox, project lists and
// thread would too. Loaded first, by the entry (src/index.ts), before any of that code runs.

const define = (name: string, fn: (this: Array<unknown>, ...args: Array<never>) => unknown): void => {
  if (!(name in Array.prototype)) Object.defineProperty(Array.prototype, name, { value: fn, writable: true, configurable: true })
}

define("toSorted", function (this: Array<unknown>, compare?: (a: unknown, b: unknown) => number) {
  return [...this].sort(compare)
})
define("toReversed", function (this: Array<unknown>) {
  return [...this].reverse()
})
