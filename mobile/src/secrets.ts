// Where the paired boards and their device tokens are kept: the keychain (iOS) or the keystore (Android), through
// expo-secure-store. Its web target (only for trying the app in a browser) has no secure storage, so it uses
// localStorage there.
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { SecretStore } from "./boards";

const web: SecretStore = {
  get: async (k) => globalThis.localStorage?.getItem(`huntaway.${k}`) ?? null,
  set: async (k, v) => globalThis.localStorage?.setItem(`huntaway.${k}`, v),
  delete: async (k) => globalThis.localStorage?.removeItem(`huntaway.${k}`),
};

const native: SecretStore = {
  get: (k) => SecureStore.getItemAsync(k),
  // Readable only while the phone is unlocked, and not restored onto another device from a backup.
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  delete: (k) => SecureStore.deleteItemAsync(k),
};

export const secrets: SecretStore = Platform.OS === "web" ? web : native;
