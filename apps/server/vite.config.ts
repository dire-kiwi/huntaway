import { defineConfig } from "vite-plus"

export default defineConfig({
  test: {
    name: "server",
    include: ["src/**/*.test.ts", "tests/structure/**/*.test.ts", "migrations/**/*.test.ts"],
  },
})
