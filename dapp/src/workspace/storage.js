/**
 * Browser storage.
 *
 * Two kinds of use, deliberately separated:
 *
 *   lenient  getItem / setItem / readJson / writeJson
 *            Preferences, drafts, the project list. A blocked or full
 *            localStorage falls back to memory so the page keeps working.
 *
 *   strict   readStrict / writeStrict / probe
 *            The transaction journal. It decides whether a call may be sent
 *            again, so it must never silently live in memory: every strict
 *            write is read back from durable storage, and any failure throws
 *            StorageUnavailable instead of falling back.
 */

export class StorageUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageUnavailable";
  }
}

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

const describeFailure = (error) =>
  /quota/i.test(`${error?.name} ${error?.message}`)
    ? "browser storage for this site is full"
    : `browser storage failed (${String(error?.message || error).slice(0, 120)})`;

export const jsonReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

export function safeStorage(candidate) {
  const fallback = memoryStorage();
  let store = candidate || null;
  let problem = candidate ? null : "browser storage (localStorage) is not available in this browser or window";

  const lenient = (fn, otherwise) => {
    try {
      return fn(store || fallback);
    } catch (error) {
      problem = describeFailure(error);
      store = null; // stop using a store that throws, for lenient uses only
      return fn(fallback) ?? otherwise;
    }
  };

  const durableStore = () => {
    if (!store) throw new StorageUnavailable(`Writes are disabled: ${problem}.`);

    return store;
  };

  return {
    getItem: (key) => lenient((s) => s.getItem(key), null),
    setItem: (key, value) => lenient((s) => s.setItem(key, value)),
    removeItem: (key) => lenient((s) => s.removeItem(key)),
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
      this.setItem(key, JSON.stringify(value, jsonReplacer));
    },

    /** Durable read: throws instead of answering from memory. */
    readStrict(key) {
      const s = durableStore();

      try {
        return s.getItem(key);
      } catch (error) {
        throw new StorageUnavailable(`Writes are disabled: ${describeFailure(error)}.`);
      }
    },

    /** Durable write, verified by reading it back. */
    writeStrict(key, value) {
      const s = durableStore();
      const text = String(value);

      try {
        s.setItem(key, text);
      } catch (error) {
        throw new StorageUnavailable(`Writes are disabled: ${describeFailure(error)}.`);
      }

      let back;

      try {
        back = s.getItem(key);
      } catch (error) {
        throw new StorageUnavailable(`Writes are disabled: ${describeFailure(error)}.`);
      }

      if (back !== text) {
        throw new StorageUnavailable("Writes are disabled: browser storage did not keep what was written.");
      }
    },

    /** Can a fresh value be written durably and read back right now? */
    probe() {
      const key = "escrow-workspace:v2:probe";
      const token = `${Date.now()}-${Math.random()}`;

      this.writeStrict(key, token);

      try {
        durableStore().removeItem(key);
      } catch {
        /* the write itself was verified */
      }
    },

    get durable() {
      return Boolean(store);
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
