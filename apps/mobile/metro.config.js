// The shared API client is plain TypeScript in ../packages/client, linked with `file:` (as app/ does): Metro has to
// watch it, and resolve its imports from this app's node_modules.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../packages")];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
module.exports = config;
