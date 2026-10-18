/**
 * Off-chain consent for the automation service (EIP-712, eth_signTypedData_v4).
 *
 * A consent is bound to:
 *   domain   name + version of this service, chainId, verifyingContract = the
 *            escrow (so it cannot be replayed on another contract or network)
 *   message  signer, role, the exact scopes, an amount ceiling, a per-signer
 *            nonce, an expiry and the hash of the notification email
 *
 * A consent only tells THIS service what the signer wants it to do. It
 * grants nothing on chain: permissionless steps need no grant, and the two
 * party-only continuations (worker claim, client activation) additionally
 * require the party's on-chain set_automation grant, which the contract
 * enforces. A consent can never widen what the contract allows.
 */

import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress } from "viem";

import {
  ConsentError,
  consentTypedData,
  MAX_CONSENT_SECONDS,
  normalizeEmail,
  revokeTypedData,
  ROLE_SCOPES,
} from "../../dapp/src/workspace/automation-consent.js";

export * from "../../dapp/src/workspace/automation-consent.js";

const lower = (v) => String(v || "").toLowerCase();

/**
 * Verify a submitted consent against the service's chain, the escrow's real
 * parties (read from chain by the caller) and the clock.
 * Returns the normalized consent or throws ConsentError.
 */
export async function verifyConsent(submission, { chainId, parties, now, lastNonce = null }) {
  const { escrow, message, signature, email } = submission || {};

  if (!isAddress(escrow || "")) throw new ConsentError("escrow must be an address");
  if (!message || typeof signature !== "string") throw new ConsentError("message and signature are required");

  const typed = consentTypedData({
    chainId,
    escrow,
    signer: message.signer,
    role: message.role,
    scopes: message.scopes,
    maxAmount: message.maxAmount,
    nonce: message.nonce,
    expiresAt: message.expiresAt,
    email,
  });

  if (lower(typed.message.emailHash) !== lower(message.emailHash)) throw new ConsentError("emailHash does not match the email given");

  let recovered;

  try {
    recovered = await recoverTypedDataAddress({ ...typed, signature });
  } catch {
    throw new ConsentError("signature is malformed");
  }

  if (lower(recovered) !== lower(typed.message.signer)) {
    throw new ConsentError("signature does not match the signer for this contract and network");
  }

  const role = message.role;
  const expectedRole = lower(parties.client) === lower(recovered) ? "client" : lower(parties.worker) === lower(recovered) ? "worker" : "observer";

  if (role !== expectedRole) throw new ConsentError(`signer is the ${expectedRole} of this escrow, not ${role}`);

  const scopes = Number(message.scopes);

  if (!Number.isInteger(scopes) || scopes <= 0 || scopes & ~ROLE_SCOPES[role]) {
    throw new ConsentError(`scopes ${scopes} are not available to the ${role}`);
  }

  const expiresAt = Number(message.expiresAt);

  if (!(expiresAt > now && expiresAt <= now + MAX_CONSENT_SECONDS)) throw new ConsentError("expiry must be in the future and within 180 days");
  if (typed.message.maxAmount <= 0n) throw new ConsentError("maxAmount must be positive");

  if (lastNonce !== null && typed.message.nonce <= BigInt(lastNonce)) {
    throw new ConsentError("nonce must be greater than every earlier consent or revocation from this signer for this escrow");
  }

  return {
    chainId,
    escrow: getAddress(escrow),
    signer: getAddress(recovered),
    role,
    scopes,
    maxAmount: typed.message.maxAmount.toString(),
    nonce: typed.message.nonce.toString(),
    expiresAt,
    email: normalizeEmail(email),
    digest: hashTypedData(typed),
  };
}

export async function verifyRevoke(submission, { chainId, now, lastNonce = null }) {
  const { escrow, message, signature } = submission || {};

  if (!isAddress(escrow || "") || !message || typeof signature !== "string") throw new ConsentError("escrow, message and signature are required");

  const typed = revokeTypedData({ chainId, escrow, signer: message.signer, nonce: message.nonce, issuedAt: message.issuedAt });
  let recovered;

  try {
    recovered = await recoverTypedDataAddress({ ...typed, signature });
  } catch {
    throw new ConsentError("signature is malformed");
  }

  if (lower(recovered) !== lower(typed.message.signer)) throw new ConsentError("signature does not match the signer");

  const issuedAt = Number(message.issuedAt);

  if (!(issuedAt <= now + 300 && issuedAt >= now - 86400)) throw new ConsentError("revocation timestamp is out of range");
  if (lastNonce !== null && typed.message.nonce <= BigInt(lastNonce)) throw new ConsentError("nonce must be greater than every earlier message");

  return { chainId, escrow: getAddress(escrow), signer: getAddress(recovered), nonce: typed.message.nonce.toString() };
}
