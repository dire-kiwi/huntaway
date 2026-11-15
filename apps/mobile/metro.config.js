// Expo's defaults. In this pnpm workspace they watch the workspace's root and resolve from the app's node_modules and
// the root's, so packages/client and packages/contracts (TypeScript sources, `exports` pointing at `src/index.ts`, with
// `.ts` in their imports) bundle as they are.
const { getDefaultConfig } = require("expo/metro-config")

module.exports = getDefaultConfig(__dirname)
