// Browser storage that never throws: a full, disabled or private-mode store
// only means the value lasts for this page. Kept outside components, whose
// try blocks the React compiler cannot yet compile.

/** Stores a value, ignoring storage that is full or disabled. */
export function storeItem(storage: Storage, key: string, value: string) {
  try { storage.setItem(key, value); } catch { /* Kept in memory only. */ }
}

/** Whether localStorage holds the key; false when storage is unavailable. */
export function storedItemExists(key: string) {
  try { return localStorage.getItem(key) !== null; } catch { return false; }
}

/** A JSON value kept in localStorage, or fallback when absent or unreadable. */
export function storedJSON<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T; } catch { return fallback; }
}
