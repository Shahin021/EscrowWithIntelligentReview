/**
 * Site side of the optional automation service.
 *
 * Nothing here sends a transaction except the on-chain grant, which goes
 * through the same guarded, journaled path as every other write. Consent and
 * revocation are EIP-712 signatures (no fee) posted to the service.
 */

import { consentTypedData, revokeTypedData, ROLE_SCOPES, SCOPES } from "./automation-consent.js";

export const AUTOMATION_INTERFACE = "genlayer.escrow-automation.v1";

/** On-chain grant support and state (automation contract only). */
export async function readGrants(readClient, escrow) {
  try {
    const [client, worker] = await Promise.all([
      readClient.readContract({ address: escrow, functionName: "get_automation", args: ["client"] }),
      readClient.readContract({ address: escrow, functionName: "get_automation", args: ["worker"] }),
    ]);

    if (client?.interface !== AUTOMATION_INTERFACE) return { supported: false };

    return { supported: true, client, worker };
  } catch {
    return { supported: false };
  }
}

export function grantActive(grant, chainTime) {
  return Boolean(grant) && BigInt(grant.max_amount || "0") > 0n && Number(grant.expires_at || 0) > Number(chainTime || 0);
}

async function call(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { "content-type": "application/json", ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const serviceInfo = (base) => call(`${base}/v1/info`);
export const serviceStatus = (base, escrow) => call(`${base}/v1/projects/${escrow}`);
export const postConsent = (base, body) => call(`${base}/v1/consents`, { method: "POST", body: JSON.stringify(body) });
export const postRevocation = (base, body) => call(`${base}/v1/revocations`, { method: "POST", body: JSON.stringify(body) });

const jsonSafe = (value) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** eth_signTypedData_v4 through the wallet (explicit user action; no transaction). */
export async function signTyped(provider, account, typed) {
  const payload = {
    ...typed,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...typed.types,
    },
  };

  return provider.request({ method: "eth_signTypedData_v4", params: [account, jsonSafe(payload)] });
}

/** Build, sign and post a consent. Returns the service's (masked) record. */
export async function giveConsent({ provider, base, chainId, escrow, account, role, scopes, maxAmount, expiresAt, email, nonce = Date.now() }) {
  if (!scopes || scopes & ~ROLE_SCOPES[role]) throw new Error("Choose at least one step available to your role.");

  const typed = consentTypedData({ chainId, escrow, signer: account, role, scopes, maxAmount, nonce, expiresAt, email });
  const signature = await signTyped(provider, account, typed);

  return postConsent(base, {
    escrow,
    email,
    signature,
    message: JSON.parse(jsonSafe(typed.message)),
  });
}

export async function revokeConsent({ provider, base, chainId, escrow, account, nonce = Date.now() }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const typed = revokeTypedData({ chainId, escrow, signer: account, nonce, issuedAt });
  const signature = await signTyped(provider, account, typed);

  return postRevocation(base, { escrow, signature, message: JSON.parse(jsonSafe(typed.message)) });
}

export function roleScopes(role) {
  const allowed = ROLE_SCOPES[role] || 0;

  return [
    { bit: SCOPES.REVIEW, label: "Run the consensus review after evidence is submitted", note: "Permissionless. The verdict comes from GenLayer consensus; the service cannot influence it." },
    { bit: SCOPES.SETTLE, label: "Claim and settle my approved payments", note: "Worker only. Needs your on-chain grant (shown above when the contract supports it); the payout always goes to the worker." },
    { bit: SCOPES.RECOVER, label: "Recover and refund after deadlines", note: "Permissionless. Only after the contract's own deadlines; refunds always go to the client." },
    { bit: SCOPES.ACTIVATE, label: "Activate funding after my exact deposit", note: "Client only. Needs your on-chain grant (shown above when the contract supports it); the service never deposits." },
  ].filter((s) => (allowed & s.bit) !== 0);
}

export { SCOPES };
