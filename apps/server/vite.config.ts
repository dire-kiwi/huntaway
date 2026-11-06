import { defineConfig } from "vite-plus";

// The server's tests (`vp test`): each file in a process of its own (Vitest's forks pool), as the server is one, since
// tests set process-wide state (the environment, TEST_CAN_RUN, the working directory).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
