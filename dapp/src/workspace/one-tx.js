import { validateProject, deployConsensusCall, OBSERVED_GAS_CAP, LIMITS } from './create.js';
import { sha256Hex } from './artifact.js';
import { normalizeEmail } from './automation-consent.js';
import { commitmentPreimage, newEmailSalt } from './email-commitment.js';

export const ONE_TX_ARTIFACT = {
  path: 'contracts/project_escrow_one_tx.packed.py', bytes: 19241,
  sha256: '89d23d8d35958d5cec32f508e900c97441b64061545e7770d2874c41f0c8fd4f', sourcePath: 'contracts/project_escrow_one_tx.py', sourceSha256: '89e9753edf383b9cdd0665010a6a83b813ba3ecb58152069097df6e3072b989a',
};
/** The client's evidence-recovery choice, in whole hours (72 h to 30 days). Immutable once created. */
export function recoveryWindow(hours) {
  const raw = String(hours ?? '').trim();
  const { minRecoveryHours: min, maxRecoveryHours: max } = LIMITS;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) return { ok: false, error: `Choose an evidence-recovery window of ${min} to ${max} whole hours (3 to 30 days).` };
  const h = Number(raw);
  return { ok: true, hours: h, seconds: h * 3600, label: recoveryLabel(h * 3600) };
}
export function recoveryLabel(seconds) {
  const h = Number(seconds) / 3600;
  const days = h / 24;
  return `${h} hours (${Number.isInteger(days) ? days : days.toFixed(1)} days)`;
}
/** Salted commitment written on chain for new projects (see email-commitment.js). */
export async function emailCommitment(email, salt) {
  return sha256Hex(new TextEncoder().encode(commitmentPreimage(email, salt)));
}
/** Legacy unsalted digest, used only by projects created before v2. */
export async function hashEmail(email) {
  const e = normalizeEmail(email);
  return sha256Hex(new TextEncoder().encode(e));
}
export async function prepareOneTx(form, code, { chain, account, readClient, emailSalt = newEmailSalt() }) {
  if ((form.milestones || []).some(m => typeof m.amount !== 'string')) throw new Error('Quote every wei amount as a decimal string to avoid numeric rounding.');
  const recovery = recoveryWindow(form.recoveryHours ?? '72');
  if (!recovery.ok) throw new Error(recovery.error);
  const verified = validateProject({ ...form, recoveryHours: String(recovery.hours), account, contractVersion: 'automation', maxRevisions: 1 });
  if (!verified.ok) throw new Error(verified.errors.map(e => e.message).join('\n'));
  const now = Number((await readClient.getBlock({blockTag:'latest'})).timestamp);
  const expires = now + 30*86400;
  const args = [...verified.args, expires, await emailCommitment(form.email, emailSalt)];
  const call = deployConsensusCall({chain,sender:account,code,constructorArgs:args,validUntil:now+3600});
  const estimate = await readClient.estimateTransactionGas({from:account,to:call.to,data:call.data,value:BigInt(verified.totalRequired)});
  const gas = (BigInt(estimate)*102n+99n)/100n;
  if (gas > OBSERVED_GAS_CAP) throw new Error('This project exceeds the deployment gas limit including 2% margin. Shorten its terms.');
  return { verified,args,call,gas,expires,value:BigInt(verified.totalRequired),recovery,emailSalt };
}
export async function prepareWorker({readClient,project,account,deliveries,email,emailSalt=newEmailSalt()}) {
  const read = (functionName,args=[]) => readClient.readContract({address:project,functionName,args,transactionHashVariant:'latest-final'});
  const [parties, auth,block,allowed] = await Promise.all([read('parties'),read('get_one_tx_authorizations'),readClient.getBlock({blockTag:'latest'}),read('get_allowed_sources')]);
  if (auth.interface !== 'genlayer.escrow-one-tx.v1') throw new Error('This is not a one-transaction contract.');
  if (parties.worker.toLowerCase() !== account.toLowerCase()) throw new Error('Connect the project worker account.');
  if (parties.project_status !== 'ACTIVE' || Number(auth.deliveries_committed) !== 0) throw new Error('This project is not ready for its worker commitment.');
  if (!Array.isArray(deliveries) || deliveries.length !== Number(parties.milestone_count)) throw new Error('Supply exactly one evidence URL for every milestone.');
  const prefixes=String(allowed).split(',').map(x=>x.trim().toLowerCase().replace(/^https:\/\//,'').replace(/\/+$/,'')).filter(Boolean);
  for (const d of deliveries) {
    if(!d || typeof d!=='object' || typeof d.url!=='string')throw new Error('Each milestone needs an evidence URL.');
    const url=d.url.trim();
    if(url.length>400 || /[\s?#]/.test(url) || url.includes('..') || !/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-fA-F]{40}\/.+$/i.test(url))throw new Error('Use a pinned raw GitHub URL of at most 400 characters, without query, fragment, whitespace or traversal.');
    if(!url.startsWith('https://'))throw new Error('The URL must start with https://.');
    const path=url.slice(8).toLowerCase();
    if(!prefixes.some(prefix=>path===prefix || path.startsWith(prefix+'/')))throw new Error('Evidence URL is outside this project’s agreed sources.');
    if(typeof (d.notes===undefined?'':d.notes)!=='string' || [...(d.notes ?? '')].length>500)throw new Error('Notes must contain at most 500 characters; the active review rejects longer notes.');
    for(const value of [url,d.notes ?? ''])if(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value))throw new Error('Evidence contains an invalid Unicode character.');
  }
  if([...JSON.stringify(deliveries)].length>32000)throw new Error('The evidence bundle exceeds 32000 characters.');
  return { args:[JSON.stringify(deliveries),Number(block.timestamp)+30*86400,await emailCommitment(email,emailSalt)], parties, emailSalt };
}
export async function enrollEntry(entry, { journal, api, fetchImpl=fetch }) {
  if (!entry.evmHash || !entry.enrollment || entry.enrollmentRecorded) return entry;
  const response = await fetchImpl(`${api}/v1/one-tx-watches`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({evmHash:entry.evmHash,...entry.enrollment})});
  const body = await response.json();
  if (!response.ok || !body.recorded) throw new Error(body.error || 'The service has not durably recorded this transaction yet. Keep this page open.');
  return journal.update(entry.id,{enrollmentRecorded:true});
}

/**
 * After a successful, final creation, compare the contract's evidence-recovery
 * window with the value the client chose (stored with the creation record).
 * Read-only: it never sends, resends or changes any transaction. A read error
 * is recorded and retried on the next refresh; match and mismatch are final,
 * because the window is immutable on chain.
 */
export async function verifyRecoveryWindow(entry, { readClient, journal, now = () => Date.now() }) {
  if (!entry || entry.kind !== 'deploy' || entry.expectedRecoverySeconds == null) return entry;
  if (['match', 'mismatch'].includes(entry.recoveryCheck?.state)) return entry;
  if (!entry.verdict?.final || !entry.verdict.ok || !entry.createdAddress) return entry;
  const expected = String(entry.expectedRecoverySeconds);
  let check;
  try {
    const onChain = String(await readClient.readContract({ address: entry.createdAddress, functionName: 'get_evidence_recovery_seconds', args: [], transactionHashVariant: 'latest-final' }));
    if (!/^\d+$/.test(onChain)) throw new Error(`unexpected value ${onChain.slice(0, 40)}`);
    check = { state: onChain === expected ? 'match' : 'mismatch', expected, onChain, checkedAt: now() };
  } catch (error) {
    check = { state: 'read-error', expected, error: String(error?.shortMessage || error?.message || error).slice(0, 200), checkedAt: now() };
  }
  try { return journal.update(entry.id, { recoveryCheck: check }) || { ...entry, recoveryCheck: check }; }
  catch { return { ...entry, recoveryCheck: check }; }
}
export function recoveryCheckText(entry) {
  const c = entry?.recoveryCheck;
  if (entry?.kind !== 'deploy' || entry.expectedRecoverySeconds == null) return null;
  if (!c) return entry.verdict?.final ? (entry.verdict.ok ? 'Recovery window check pending.' : null) : 'Recovery window is checked after the creation is final.';
  if (c.state === 'match') return `Recovery window confirmed on chain: ${recoveryLabel(c.onChain)}.`;
  if (c.state === 'mismatch') return `Recovery window MISMATCH: you chose ${recoveryLabel(c.expected)}, the contract has ${recoveryLabel(c.onChain)}. Do not resend; the window cannot be changed. Do not use this project until you have reviewed it.`;
  return `Could not read the recovery window yet (${c.error}). It will be checked again on Check status. Nothing will be resent.`;
}
