/**
 * Durable state (SQLite, node:sqlite). One file; WAL; every state change is a
 * compare-and-set inside BEGIN IMMEDIATE, so several processes on the same
 * file can run without two of them taking the same step.
 */

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  escrow TEXT NOT NULL,
  signer TEXT NOT NULL,
  role TEXT NOT NULL,
  scopes INTEGER NOT NULL,
  max_amount TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (chain_id, escrow, signer, nonce)
);

CREATE TABLE IF NOT EXISTS signer_nonces (
  chain_id INTEGER NOT NULL, escrow TEXT NOT NULL, signer TEXT NOT NULL, nonce TEXT NOT NULL,
  PRIMARY KEY (chain_id, escrow, signer)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  escrow TEXT NOT NULL,
  function_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  scope INTEGER NOT NULL,
  amount TEXT NOT NULL,
  reason TEXT NOT NULL,
  consent_ids TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sender TEXT,
  nonce INTEGER,
  gas TEXT,
  gas_price TEXT,
  data TEXT,
  raw_tx TEXT,
  evm_hash TEXT,
  broadcast_count INTEGER NOT NULL DEFAULT 0,
  last_broadcast_at INTEGER,
  evm_block TEXT,
  gl_tx_id TEXT,
  verdict_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS jobs_escrow ON jobs (escrow);

CREATE TABLE IF NOT EXISTS sender_nonce (sender TEXT PRIMARY KEY, next_nonce INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, wei TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS snapshots (escrow TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  escrow TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready',     -- ready to fan out
  batch TEXT,                              -- block of the finalized snapshot that produced it (B1)
  baseline TEXT,                           -- block of the previous finalized snapshot (B0)
  provenance_json TEXT,                    -- job events only: the service's own transaction
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  event_key TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (event_key, email)
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  return db;
}

/** Run fn inside BEGIN IMMEDIATE; commit on success, roll back on any throw. */
export function immediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");

  try {
    const result = fn();

    db.exec("COMMIT");

    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }

    throw error;
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
