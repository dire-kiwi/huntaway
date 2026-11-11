import { defineConfig } from "vite-plus"

export default defineConfig({ test: { name: "client", include: ["test/**/*.test.ts"] } })
