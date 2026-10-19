/** Enrollment is derived from the party's finalized on-chain authorization,
 * not an additional wallet signature. Untrusted watch requests never authorize jobs. */
import { createHash, randomBytes } from 'node:crypto';
import { ConsentError, normalizeEmail } from './consent.js';
import { immediate } from './db.js';
import { verificationEmail } from './notifier.js';
import { newTransactionFromReceipt } from '../../dapp/src/workspace/sender.js';
import { classifyReceipt } from '../../dapp/src/workspace/finality.js';
import { commitmentPreimage, EMAIL_SALT_PATTERN } from '../../dapp/src/workspace/email-commitment.js';

/** The on-chain email value: a salted commitment (v2), or the legacy unsalted digest when no salt was recorded. */
export const emailDigest = (email, salt = null) => createHash('sha256').update(salt ? commitmentPreimage(email, salt) : normalizeEmail(email)).digest('hex');
/** Additive, idempotent migration: existing rows keep NULL (legacy, unsalted). */
export function ensureColumn(db, table, column) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}
export function liveAuthorization(snapshot, role, emailHash) {
  const a = snapshot.oneTx?.[role];
  if (snapshot.finality !== 'final' || snapshot.oneTx?.interface !== 'genlayer.escrow-one-tx.v1' || !['client','worker'].includes(role)) return null;
  if (!a || a.email_hash !== emailHash || Number(a.expires_at) <= snapshot.chainTime || BigInt(a.max_amount || 0) <= 0n) return null;
  const scopes = role === 'client' ? 5 : 7;
  if (Number(a.scopes) !== scopes || BigInt(a.nonce || 0) <= 0n) return null;
  return { ...a, signer: snapshot.project[role], scopes };
}
export function filterOnchainConsents(rows, snapshot) {
  return rows.filter(c => {
    if (c.signature !== 'onchain-v1') return true;
    const a = liveAuthorization(snapshot, c.role, emailDigest(c.email, c.email_salt));
    return a && String(a.signer).toLowerCase() === c.signer.toLowerCase() && String(a.nonce) === c.nonce && String(a.max_amount) === c.max_amount && Number(a.expires_at) === c.expires_at && a.scopes === c.scopes;
  });
}
export function createOneTxEnrollment({ db, chain, config, now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS one_tx_watches (
    evm_hash TEXT PRIMARY KEY, role TEXT NOT NULL, email TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', escrow TEXT, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  ensureColumn(db, 'one_tx_watches', 'email_salt');
  ensureColumn(db, 'consents', 'email_salt');
  return {
    add({ evmHash, role, email, emailSalt = null }) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(evmHash || '') || !['client','worker'].includes(role)) throw new ConsentError('hash and party role are required');
      email = normalizeEmail(email);
      if (emailSalt !== null && emailSalt !== undefined && !EMAIL_SALT_PATTERN.test(String(emailSalt))) throw new ConsentError('the email salt must be 64 lowercase hex characters');
      const salt = emailSalt || null;
      return immediate(db, () => {
        const existing = db.prepare('SELECT * FROM one_tx_watches WHERE evm_hash = ?').get(evmHash.toLowerCase());
        if (existing && (existing.role !== role || existing.email !== email || (existing.email_salt || null) !== salt)) throw new ConsentError('this hash already has a different enrollment');
        if (!existing) {
          if (db.prepare('SELECT count(*) n FROM one_tx_watches WHERE state = ?').get('pending').n >= config.maxEscrows * 4) throw new ConsentError('watch capacity reached');
          db.prepare('INSERT INTO one_tx_watches (evm_hash,role,email,email_salt,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(evmHash.toLowerCase(),role,email,salt,now(),now());
        }
        return { recorded: true, state: existing?.state || 'pending', evmHash };
      });
    },
    async tick() {
      const rows = db.prepare("SELECT * FROM one_tx_watches WHERE state='pending' ORDER BY updated_at LIMIT ?").all(config.maxEscrows);
      for (const w of rows) {
        try {
          if (now() - w.created_at > 7*86400) throw new ConsentError('enrollment expired; recheck the transaction manually');
          const receipt = await chain.getReceipt(w.evm_hash);
          if (!receipt) continue;
          if (receipt.status !== 'success') throw new ConsentError('EVM transaction failed');
          const found = newTransactionFromReceipt(receipt, chain.chainConfig.consensusMainContract);
          if (!found.txId) throw new ConsentError('expected exactly one consensus transaction');
          const tx = await chain.getGenLayerTx(found.txId);
          const verdict = classifyReceipt(tx, found.recipient);
          if (!verdict.final) continue;
          if (!verdict.ok) throw new ConsentError('GenLayer execution did not finalize successfully');
          const snapshot = await chain.snapshot(found.recipient);
          const a = liveAuthorization(snapshot, w.role, emailDigest(w.email, w.email_salt));
          const sender = tx?.sender || tx?.data?.sender;
          if (!a || String(sender).toLowerCase() !== String(a.signer).toLowerCase()) throw new ConsentError('finalized party authorization does not match this enrollment');
          immediate(db, () => {
            const escrow = found.recipient.toLowerCase();
            const signer = a.signer.toLowerCase();
            const old = db.prepare('SELECT id FROM consents WHERE chain_id=? AND escrow=? AND signer=? AND nonce=?').get(chain.chainConfig.id,escrow,signer,String(a.nonce));
            if (!old) {
              const token = randomBytes(24).toString('hex');
              const r = db.prepare(`INSERT INTO consents(chain_id,escrow,signer,role,scopes,max_amount,nonce,expires_at,email,email_salt,verify_token,digest,signature,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(chain.chainConfig.id,escrow,signer,w.role,a.scopes,String(a.max_amount),String(a.nonce),Number(a.expires_at),w.email,w.email_salt || null,token,`${found.txId}:${w.role}`,'onchain-v1',now());
              const mail = verificationEmail({email:w.email,token,escrow,apiUrl:config.publicApiUrl,scopesText: w.role === 'client' ? 'review, recover' : 'review, settle, recover'});
              db.prepare('INSERT OR IGNORE INTO outbox(event_key,email,subject,body,created_at) VALUES(?,?,?,?,?)').run(`verify:${r.lastInsertRowid}`,mail.email,mail.subject,mail.body,now());
            }
            db.prepare("UPDATE one_tx_watches SET state='enrolled',escrow=?,error=NULL,updated_at=? WHERE evm_hash=?").run(escrow,now(),w.evm_hash);
          });
        } catch(e) {
          db.prepare('UPDATE one_tx_watches SET state=?,error=?,updated_at=? WHERE evm_hash=?').run(e instanceof ConsentError ? 'blocked' : 'pending',String(e.message).slice(0,160),now(),w.evm_hash);
        } finally {
          db.prepare('UPDATE one_tx_watches SET updated_at=? WHERE evm_hash=?').run(now(),w.evm_hash);
        }
      }
    },
    status(hash) {
      const r = db.prepare('SELECT state,escrow,error FROM one_tx_watches WHERE evm_hash=?').get(String(hash).toLowerCase());
      return r || {state:'unknown'};
    },
  };
}
