import { defineConfig } from "vite-plus"

export default defineConfig({ test: { name: "contracts", include: ["test/**/*.test.ts"] } })
