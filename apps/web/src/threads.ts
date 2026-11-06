// The model the server keeps tasks' threads as: items, requests, numbered events, snapshots and windows, with the reducer
// both ends fold events with. It's one file the server and the app share, imported by relative path (Vite bundles it,
// and the app's typecheck checks it with the app's settings). See docs/threads.md. The thread view draws a task's thread
// kept as items with it (itemThreads.ts, itemModel.ts).
export * from "../../server/src/threads/protocol.ts";
