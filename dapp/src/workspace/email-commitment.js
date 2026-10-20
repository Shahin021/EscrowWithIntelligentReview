/**
 * Email commitment for one-transaction projects (v2).
 *
 * The chain stores only sha256(TAG \n salt \n normalized email), where salt is
 * 32 random bytes chosen per authorization. Without the salt, a guessed email
 * cannot be matched against the on-chain value. The salt is kept with the
 * party's local transaction record and given to the background service with
 * the email; it is never written on chain. Shared by the site and the service
 * so both compute exactly the same preimage.
 *
 * Projects created before v2 stored sha256(normalized email) with no salt.
 * Those values are already public and cannot be removed; they keep working.
 */
import { normalizeEmail } from "./automation-consent.js";

export const EMAIL_COMMITMENT_TAG = "genlayer.escrow-one-tx.email-commitment.v2";
export const EMAIL_SALT_PATTERN = /^[0-9a-f]{64}$/;

export function commitmentPreimage(email, salt) {
  if (!EMAIL_SALT_PATTERN.test(String(salt))) throw new Error("The email salt must be 32 random bytes as 64 lowercase hex characters.");

  return `${EMAIL_COMMITMENT_TAG}\n${salt}\n${normalizeEmail(email)}`;
}

export function newEmailSalt(random = globalThis.crypto) {
  if (!random?.getRandomValues) throw new Error("This browser cannot generate a secure random value.");
  const bytes = new Uint8Array(32);

  random.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
