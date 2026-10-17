/**
 * Transaction journal, kept in this browser.
 *
 * Every write is recorded BEFORE the wallet prompt opens, then updated with
 * the EVM hash the wallet returns, the GenLayer transaction id read from the
 * EVM receipt, and the final receipt. A refresh or a timeout therefore never
 * loses an identifier, and the same call cannot be sent twice while an
 * earlier one is unresolved.
 *
 * Entries are separated by network, project and account. The journal is a
 * record of what this browser sent; it is not evidence of what the chain did,
 * which is always re-read from the network.
 *
 * Because the journal is what stops a second send, it must be durable: it is
 * written only through storage.writeStrict (verified read-back, no memory
 * fallback), a journal that cannot be read or parsed is never overwritten,
 * and create() refuses to record an intent unless that write is durable. A
 * caller must not open the wallet when create() throws.
 */

import { jsonReplacer, StorageUnavailable } from "./storage.js";

const KEY = "escrow-workspace:v2:journal";
const MAX_ENTRIES = 300;

export const PHASE_PROMPTING = "prompting"; // recorded; wallet prompt may be open
export const PHASE_SENT = "sent"; // wallet returned an EVM hash
export const PHASE_TRACKING = "tracking"; // GenLayer tx id known, awaiting finality
export const PHASE_DONE = "done"; // finalized and classified
export const PHASE_NOT_SENT = "not-sent"; // refused before or at the wallet
export const PHASE_ABANDONED = "abandoned"; // user confirmed it was never sent

const UNRESOLVED = new Set([PHASE_PROMPTING, PHASE_SENT, PHASE_TRACKING]);

const lower = (value) => String(value || "").toLowerCase();

/** Stable identity of one intended call: same binding = same action. */
export function bindingKey({ network, project, account, functionName, args, value }) {
  return JSON.stringify(
    [network, lower(project), lower(account), functionName, args ?? [], String(value ?? "0")],
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );
}

export function createJournal(storage, { now = () => Date.now(), randomId } = {}) {
  const makeId =
    randomId ||
    (() => `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  /** Strict read: throws StorageUnavailable when unreadable or corrupt. */
  const readAll = () => {
    const raw = storage.readStrict(KEY);

    if (raw === null || raw === undefined) return [];

    let value;

    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }

    if (!Array.isArray(value) || value.some((e) => !e || typeof e !== "object" || !e.id)) {
      throw new StorageUnavailable(
        "Writes are disabled: this browser's transaction journal is unreadable (corrupt). " +
          "It was left untouched so no record is lost; read-only features still work.",
      );
    }

    return value;
  };

  /** Lenient read for display: never throws. */
  const all = () => {
    try {
      return readAll();
    } catch {
      const value = storage.readJson(KEY, []);

      return Array.isArray(value) ? value.filter((e) => e && typeof e === "object" && e.id) : [];
    }
  };

  const save = (entries) => {
    // Keep unresolved entries no matter what; trim only settled history.
    const unresolved = entries.filter((e) => UNRESOLVED.has(e.phase));
    const settled = entries.filter((e) => !UNRESOLVED.has(e.phase));
    const keep = settled.slice(Math.max(0, settled.length - (MAX_ENTRIES - unresolved.length)));

    storage.writeStrict(KEY, JSON.stringify([...unresolved, ...keep].sort((a, b) => a.createdAt - b.createdAt), jsonReplacer));
  };

  return {
    list({ network, project, account } = {}) {
      return all().filter(
        (e) =>
          (network === undefined || e.network === network) &&
          (project === undefined || lower(e.project) === lower(project)) &&
          (account === undefined || lower(e.account) === lower(account)),
      );
    },

    get(id) {
      return all().find((e) => e.id === id) || null;
    },

    /** The unresolved entry for the same call, if any. */
    findUnresolved(binding) {
      const key = bindingKey(binding);

      return readAll().find((e) => e.binding === key && UNRESOLVED.has(e.phase)) || null;
    },

    /** { ok, reason }: may an intent be recorded durably right now? */
    health() {
      try {
        readAll();
        storage.probe();

        return { ok: true, reason: null };
      } catch (error) {
        return { ok: false, reason: error.message || String(error) };
      }
    },

    /** Records an intent durably or throws StorageUnavailable. */
    create(entry) {
      const existing = readAll(); // throws when unreadable or corrupt
      const record = {
        id: makeId(),
        createdAt: now(),
        updatedAt: now(),
        phase: PHASE_PROMPTING,
        evmHash: null,
        txId: null,
        verdict: null,
        error: null,
        ...entry,
        binding: bindingKey(entry),
      };

      save([...existing, record]);

      if (!readAll().some((e) => e.id === record.id)) {
        throw new StorageUnavailable("Writes are disabled: the journal entry was not kept by browser storage.");
      }

      return record;
    },

    /** Throws StorageUnavailable when the update cannot be stored durably. */
    update(id, patch) {
      const entries = readAll();
      const index = entries.findIndex((e) => e.id === id);

      if (index < 0) return null;

      const current = entries[index];
      const next = { ...current, ...patch, updatedAt: now() };

      // Identifiers are write-once: a later update can never erase or replace
      // a hash that was already recorded.
      for (const field of ["evmHash", "txId", "createdAddress"]) {
        if (current[field] && patch[field] !== undefined && patch[field] !== current[field]) {
          next[field] = current[field];
          next.identifierConflict = { field, ignored: patch[field] };
        }
      }

      // The expectation (exact calldata or code) is kept only while the entry
      // is unresolved, to match a possibly-sent transaction found later.
      if (!UNRESOLVED.has(next.phase)) delete next.expect;

      entries[index] = next;
      save(entries);

      return next;
    },

    isUnresolved(entry) {
      return Boolean(entry && UNRESOLVED.has(entry.phase));
    },
  };
}
