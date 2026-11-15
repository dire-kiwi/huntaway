import * as SecureStore from "expo-secure-store"
import { Platform } from "react-native"

// Where the app keeps its board: the phone's keychain (expo-secure-store, readable only while the phone is unlocked and
// only on this phone), or a browser's localStorage when the app runs on the web for a check (secure-store has no web).

/** A browser's localStorage, when there is one. */
interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const isWebStorage = (v: unknown): v is WebStorage => typeof v === "object" && v !== null && "getItem" in v && "setItem" in v && "removeItem" in v

const web = (): WebStorage | null => {
  const ls: unknown = Platform.OS === "web" ? Reflect.get(globalThis, "localStorage") : undefined
  return isWebStorage(ls) ? ls : null
}

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

/** The value kept under `key`, or null. Never rejects: a store that can't be read has nothing. */
export const load = (key: string): Promise<string | null> => {
  const ls = web()
  if (Platform.OS === "web") return Promise.resolve(ls?.getItem(key) ?? null)
  return SecureStore.getItemAsync(key, options).catch(() => null)
}

/** Keeps `value` under `key` (null removes it). Never rejects: what can't be kept lasts until the app closes. */
export const save = (key: string, value: string | null): Promise<void> => {
  const ls = web()
  if (Platform.OS === "web") {
    if (value === null) ls?.removeItem(key)
    else ls?.setItem(key, value)
    return Promise.resolve()
  }
  const done = value === null ? SecureStore.deleteItemAsync(key, options) : SecureStore.setItemAsync(key, value, options)
  return done.catch(() => undefined)
}
