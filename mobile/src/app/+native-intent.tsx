// Links the system opens the app with. The iOS share extension opens it with huntaway://dataUrl=<key>, which isn't a
// screen: expo-share-intent reads the share from it (see ShareHandler), and the app opens on its home tab meanwhile.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return path.includes("dataUrl=") ? "/" : path;
}
