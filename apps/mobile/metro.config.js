// Expo's defaults: in a monorepo (this pnpm workspace) they watch the workspace's root and resolve from both this app's
// node_modules and the root's, so the shared API client (packages/client, linked with `workspace:*`) bundles as it is.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
