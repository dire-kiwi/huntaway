import { defineConfig } from "vite-plus"

// The phone app's tests: its pure logic (src/logic), in Node. Screens are checked on the app's web build in a browser.
export default defineConfig({ test: { name: "mobile", include: ["tests/**/*.test.ts"] } })
