import { validateProject, deployConsensusCall, OBSERVED_GAS_CAP } from './create.js';
import { sha256Hex } from './artifact.js';
import { normalizeEmail } from './automation-consent.js';

export const ONE_TX_ARTIFACT = {
  path: 'contracts/project_escrow_one_tx.packed.py', bytes: 19241,
  sha256: '89d23d8d35958d5cec32f508e900c97441b64061545e7770d2874c41f0c8fd4f', sourcePath: 'contracts/project_escrow_one_tx.py', sourceSha256: '89e9753edf383b9cdd0665010a6a83b813ba3ecb58152069097df6e3072b989a',
};
export async function hashEmail(email) {
  const e = normalizeEmail(email);
  return sha256Hex(new TextEncoder().encode(e));
}
export async function prepareOneTx(form, code, { chain, account, readClient }) {
  if ((form.milestones || []).some(m => typeof m.amount !== 'string')) throw new Error('Quote every wei amount as a decimal string to avoid numeric rounding.');
  const verified = validateProject({ ...form, account, contractVersion: 'automation', maxRevisions: 1 });
  if (!verified.ok) throw new Error(verified.errors.map(e => e.message).join('\n'));
  const now = Number((await readClient.getBlock({blockTag:'latest'})).timestamp);
  const expires = now + 30*86400;
  const args = [...verified.args, expires, await hashEmail(form.email)];
  const call = deployConsensusCall({chain,sender:account,code,constructorArgs:args,validUntil:now+3600});
  const estimate = await readClient.estimateTransactionGas({from:account,to:call.to,data:call.data,value:BigInt(verified.totalRequired)});
  const gas = (BigInt(estimate)*102n+99n)/100n;
  if (gas > OBSERVED_GAS_CAP) throw new Error('This project exceeds the deployment gas limit including 2% margin. Shorten its terms.');
  return { verified,args,call,gas,expires,value:BigInt(verified.totalRequired) };
}
export async function prepareWorker({readClient,project,account,deliveries,email}) {
  const read = (functionName,args=[]) => readClient.readContract({address:project,functionName,args,transactionHashVariant:'latest-final'});
  const [parties, auth,block] = await Promise.all([read('parties'),read('get_one_tx_authorizations'),readClient.getBlock({blockTag:'latest'})]);
  if (auth.interface !== 'genlayer.escrow-one-tx.v1') throw new Error('This is not a one-transaction contract.');
  if (parties.worker.toLowerCase() !== account.toLowerCase()) throw new Error('Connect the project worker account.');
  if (parties.project_status !== 'ACTIVE' || Number(auth.deliveries_committed) !== 0) throw new Error('This project is not ready for its worker commitment.');
  if (!Array.isArray(deliveries) || deliveries.length !== Number(parties.milestone_count)) throw new Error('Supply exactly one evidence URL for every milestone.');
  for (const d of deliveries) if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-fA-F]{40}\/.+/.test(d.url || '') || typeof (d.notes ?? '') !== 'string' || String(d.notes || '').length > 2000) throw new Error('Use pinned GitHub evidence URLs and notes of at most 2000 characters.');
  return { args:[JSON.stringify(deliveries),Number(block.timestamp)+30*86400,await hashEmail(email)], parties };
}
export async function enrollEntry(entry, { journal, api, fetchImpl=fetch }) {
  if (!entry.evmHash || !entry.enrollment || entry.enrollmentRecorded) return entry;
  const response = await fetchImpl(`${api}/v1/one-tx-watches`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({evmHash:entry.evmHash,...entry.enrollment})});
  const body = await response.json();
  if (!response.ok || !body.recorded) throw new Error(body.error || 'The service has not durably recorded this transaction yet. Keep this page open.');
  return journal.update(entry.id,{enrollmentRecorded:true});
}
