import { defineConfig } from "vite-plus"

export default defineConfig({ test: { name: "plugin", include: ["test/**/*.test.ts"] } })
