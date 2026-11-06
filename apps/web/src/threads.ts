// The model the server keeps tasks' threads as: items, requests, numbered events, snapshots and windows, with the reducer
// both ends fold events with. It's one file the server and the clients share, which the app takes from the shared client
// (packages/client/src/protocol.ts) as the phone does. See docs/threads.md. The thread view draws a task's thread kept as
// items with it (itemThreads.ts, itemModel.ts).
export * from "@huntaway/client/protocol";
