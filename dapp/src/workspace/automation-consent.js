/**
 * Automation consent: the EIP-712 messages a party signs for the optional
 * automation service (shared by the site and the service, so both encode the
 * exact same bytes). Signing one sends no transaction and costs nothing.
 *
 * Bound to: domain name + version, chainId, verifyingContract = the escrow,
 * signer, role, exact scopes, amount ceiling, per-signer nonce, expiry and
 * the hash of the notification email.
 */

import { getAddress, keccak256, toBytes } from "viem";

export const DOMAIN_NAME = "GenLayer Escrow Automation";
export const DOMAIN_VERSION = "1";

/** Separate, independently chosen scopes. */
export const SCOPES = {
  REVIEW: 1, // resolve(): run the consensus review of submitted evidence (permissionless)
  SETTLE: 2, // worker: claim_payment of an APPROVED milestone (needs on-chain grant) + emit/confirm that payout
  RECOVER: 4, // recover/expire/finalize after deadlines (permissionless) + emit/confirm the refund
  ACTIVATE: 8, // client: activate_funding of an exact deposit already made (needs on-chain grant)
};

export const SCOPE_NAMES = Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [v, k.toLowerCase()]));

/** Which role may ask for which scope. A client choice never stands in for the worker, and vice versa. */
export const ROLE_SCOPES = {
  client: SCOPES.REVIEW | SCOPES.RECOVER | SCOPES.ACTIVATE,
  worker: SCOPES.REVIEW | SCOPES.SETTLE | SCOPES.RECOVER,
  observer: SCOPES.REVIEW | SCOPES.RECOVER, // permissionless steps only
};

export const MAX_CONSENT_SECONDS = 180 * 86400;

export const CONSENT_TYPES = {
  Consent: [
    { name: "signer", type: "address" },
    { name: "role", type: "string" },
    { name: "scopes", type: "uint32" },
    { name: "maxAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "emailHash", type: "bytes32" },
  ],
};

export const REVOKE_TYPES = {
  Revoke: [
    { name: "signer", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
  ],
};

export class ConsentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsentError";
  }
}

export function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();

  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/.test(value)) throw new ConsentError("A valid email address is required.");

  return value;
}

export const emailHash = (email) => keccak256(toBytes(normalizeEmail(email)));

export function domainFor({ chainId, escrow }) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: getAddress(escrow) };
}

/** The typed data a wallet signs (eth_signTypedData_v4). */
export function consentTypedData({ chainId, escrow, signer, role, scopes, maxAmount, nonce, expiresAt, email }) {
  return {
    domain: domainFor({ chainId, escrow }),
    types: CONSENT_TYPES,
    primaryType: "Consent",
    message: {
      signer: getAddress(signer),
      role,
      scopes: Number(scopes),
      maxAmount: BigInt(maxAmount),
      nonce: BigInt(nonce),
      expiresAt: BigInt(expiresAt),
      emailHash: emailHash(email),
    },
  };
}

export function revokeTypedData({ chainId, escrow, signer, nonce, issuedAt }) {
  return {
    domain: domainFor({ chainId, escrow }),
    types: REVOKE_TYPES,
    primaryType: "Revoke",
    message: { signer: getAddress(signer), nonce: BigInt(nonce), issuedAt: BigInt(issuedAt) },
  };
}

