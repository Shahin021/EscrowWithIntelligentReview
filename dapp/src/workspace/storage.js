/**
 * Browser storage that never throws.
 *
 * localStorage can be missing, full or blocked (private windows, embedded
 * previews). Every read and write is wrapped so the app keeps working with
 * an in-memory fallback; nothing that decides about money depends on it.
 */

export function memoryStorage() {
  const data = new Map();

  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

export function safeStorage(candidate) {
  const fallback = memoryStorage();
  let store = candidate || null;

  const use = (fn, otherwise) => {
    try {
      return fn(store || fallback);
    } catch {
      store = null; // stop using a store that throws
      return fn(fallback) ?? otherwise;
    }
  };

  return {
    getItem: (key) => use((s) => s.getItem(key), null),
    setItem: (key, value) => use((s) => s.setItem(key, value)),
    removeItem: (key) => use((s) => s.removeItem(key)),
    readJson(key, fallbackValue) {
      const raw = this.getItem(key);

      if (raw === null || raw === undefined) return fallbackValue;

      try {
        return JSON.parse(raw);
      } catch {
        return fallbackValue;
      }
    },
    writeJson(key, value) {
      this.setItem(key, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    },
  };
}

export function browserStorage() {
  try {
    return safeStorage(globalThis.localStorage);
  } catch {
    return safeStorage(null);
  }
}
