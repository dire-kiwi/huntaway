// Expo's preset, with `import.meta` turned into something Hermes runs: effect reads `import.meta?.env` (its config
// provider), which Hermes cannot parse.
module.exports = function (api) {
  api.cache(true)
  return { presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]] }
}
