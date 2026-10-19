import {it,expect,vi} from 'vitest';
import {hashEmail,prepareOneTx,enrollEntry} from '../src/workspace/one-tx.js';
import {testnetBradbury} from 'genlayer-js/chains';
it('binds email consistently without a wallet signature',async()=>{
 expect(await hashEmail(' Client@Example.com ')).toBe(await hashEmail('client@example.com'));
 await expect(hashEmail('invalid')).rejects.toThrow();
});
it('estimates attached principal, includes both client authorizations, and uses chain time',async()=>{
 const readClient={getBlock:async()=>({timestamp:1800000000n}),estimateTransactionGas:vi.fn(async()=>15000000n)};
 const r=await prepareOneTx({worker:'0x'+'b1'.repeat(20),email:'client@example.com',allowedSources:'raw.githubusercontent.com/a/b',milestones:[{spec:'A complete deliverable',amount:'7'}]},new Uint8Array([1]),{chain:testnetBradbury,account:'0x'+'a1'.repeat(20),readClient});
 expect(r.value).toBe(7n);expect(readClient.estimateTransactionGas.mock.calls[0][0].value).toBe(7n);
 expect(r.args[4]).toBe(1);expect(r.args[8]).toBe(1802592000);expect(r.args[9]).toHaveLength(64);
});
it('refuses a project that does not fit, rather than falling back to an unfunded deployment',async()=>{
 await expect(prepareOneTx({worker:'0x'+'b1'.repeat(20),email:'client@example.com',allowedSources:'raw.githubusercontent.com/a/b',milestones:[{spec:'A complete deliverable',amount:'1'}]},new Uint8Array([1]),{chain:testnetBradbury,account:'0x'+'a1'.repeat(20),readClient:{getBlock:async()=>({timestamp:1800000000n}),estimateTransactionGas:async()=>16777216n}})).rejects.toThrow('gas limit');
});
it('does not claim background tracking until the durable service accepts it',async()=>{
 const entry={id:'one',evmHash:'0x'+'ab'.repeat(32),enrollment:{role:'client',email:'client@example.com'}};
 const journal={update:vi.fn()};
 await expect(enrollEntry(entry,{journal,api:'http://service',fetchImpl:async()=>({ok:false,json:async()=>({error:'offline'})})})).rejects.toThrow('offline');
 expect(journal.update).not.toHaveBeenCalled();
 await enrollEntry(entry,{journal,api:'http://service',fetchImpl:async()=>({ok:true,json:async()=>({recorded:true})})});
 expect(journal.update).toHaveBeenCalledWith('one',{enrollmentRecorded:true});
});

import {prepareWorker} from '../src/workspace/one-tx.js';
const worker='0x'+'b1'.repeat(20), project='0x'+'c1'.repeat(20);
const pinned='https://raw.githubusercontent.com/owner/repo/'+'a'.repeat(40)+'/evidence.txt';
const workerRead={getBlock:async()=>({timestamp:1800000000n}),readContract:async({functionName})=>({parties:{worker,project_status:'ACTIVE',milestone_count:1},get_one_tx_authorizations:{interface:'genlayer.escrow-one-tx.v1',deliveries_committed:0},get_allowed_sources:'raw.githubusercontent.com/Owner/Repo'})[functionName]};
const preflight=deliveries=>prepareWorker({readClient:workerRead,project,account:worker,email:'worker@example.com',deliveries});
it('validates sources from the final contract state before any signing',async()=>{
 const result=await preflight([{url:pinned,notes:'a'.repeat(500)}]);expect(result.args[0]).toContain(pinned);
});
it.each([
 [pinned+'?raw=1','query'],[pinned+'#part','fragment'],[pinned.replace('owner/repo','owner/repo-evil'),'allowlist boundary'],[pinned.replace('owner/repo','other/repo'),'different source'],[pinned.replace('evidence.txt','../evidence.txt'),'traversal'],[pinned.replace('evidence.txt','a'.repeat(401)),'too long'],[pinned+'\ninvalid','whitespace']
])('refuses invalid evidence %s (%s)',async url=>{await expect(preflight([{url}])).rejects.toThrow();});
it('rejects notes accepted by the bundle parser but rejected by the active milestone',async()=>{
 await expect(preflight([{url:pinned,notes:'a'.repeat(501)}])).rejects.toThrow('500');
});
it.each([null,42,{}, {url:pinned,notes:5},{url:pinned,notes:null}])('refuses malformed evidence entries %s',async d=>{await expect(preflight([d])).rejects.toThrow();});

import {recoveryWindow,recoveryLabel} from '../src/workspace/one-tx.js';
import {LIMITS} from '../src/workspace/create.js';
import {readFileSync} from 'node:fs';
const base={worker:'0x'+'b1'.repeat(20),email:'client@example.com',allowedSources:'raw.githubusercontent.com/a/b',milestones:[{spec:'A complete deliverable',amount:'7'}]};
const chainRead=()=>({getBlock:vi.fn(async()=>({timestamp:1800000000n})),estimateTransactionGas:vi.fn(async()=>15000000n)});
const prep=(form,readClient=chainRead())=>prepareOneTx(form,new Uint8Array([1]),{chain:testnetBradbury,account:'0x'+'a1'.repeat(20),readClient});
it('accepts only whole hours from 72 to 720 for the evidence-recovery window',()=>{
 expect(recoveryWindow('72')).toMatchObject({ok:true,seconds:259200,label:'72 hours (3 days)'});
 expect(recoveryWindow(' 720 ')).toMatchObject({ok:true,seconds:2592000,label:'720 hours (30 days)'});
 expect(recoveryWindow('100').label).toBe('100 hours (4.2 days)');
 for(const bad of ['71','721','0','','96.5','-72','1e3','abc',null,undefined])expect(recoveryWindow(bad).ok).toBe(false);
});
it('sends the chosen window to the constructor and shows it in the preview data',async()=>{
 const r=await prep({...base,recoveryHours:'168'});
 expect(r.args[7]).toBe(168*3600);
 expect(r.recovery).toMatchObject({hours:168,seconds:604800,label:'168 hours (7 days)'});
 expect(r.args[8]).toBe(1802592000);
});
it('sends 72 hours explicitly when no window is given, and both bounds unchanged',async()=>{
 expect((await prep(base)).args[7]).toBe(259200);
 expect((await prep({...base,recoveryHours:'72'})).args[7]).toBe(259200);
 expect((await prep({...base,recoveryHours:'720'})).args[7]).toBe(2592000);
});
it.each(['71','721','48','',' '])('refuses window %j before reading the chain or estimating',async hours=>{
 const readClient=chainRead();
 await expect(prep({...base,recoveryHours:hours},readClient)).rejects.toThrow('72 to 720');
 expect(readClient.getBlock).not.toHaveBeenCalled();expect(readClient.estimateTransactionGas).not.toHaveBeenCalled();
});
it('the form field defaults to 72 hours with the same bounds as the contract',()=>{
 const html=readFileSync(new URL('../one-tx.html',import.meta.url),'utf8');
 const input=html.match(/<input id="recovery-hours"[^>]*>/)[0];
 expect(input).toContain('min="72"');expect(input).toContain('max="720"');expect(input).toContain('value="72"');
 expect([LIMITS.minRecoveryHours,LIMITS.maxRecoveryHours]).toEqual([72,720]);
 expect(recoveryLabel('259200')).toBe('72 hours (3 days)');
});

import {verifyRecoveryWindow,recoveryCheckText} from '../src/workspace/one-tx.js';
import {createJournal} from '../src/workspace/journal.js';
import {memoryStorage,safeStorage} from '../src/workspace/storage.js';
const CREATED='0x'+'d4'.repeat(20);
function createdEntry(storage,{expected=604800,verdict={final:true,ok:true,key:'success',label:'Finalized'}}={}){
 const j=createJournal(storage);
 const e=j.create({kind:'deploy',network:'testnetBradbury',project:'deploy',account:'0x'+'a1'.repeat(20),functionName:'__deploy__',args:[],value:'1',label:'Create, fund and authorize',enrollment:{role:'client',email:'c@example.com'},expectedRecoverySeconds:expected});
 return j.update(e.id,{phase:'done',evmHash:'0x'+'11'.repeat(32),txId:'0x'+'22'.repeat(32),createdAddress:CREATED,verdict});
}
const reader=value=>({readContract:vi.fn(async()=>{if(value instanceof Error)throw value;return value;})});
it('confirms a matching window after successful finality',async()=>{
 const storage=safeStorage(memoryStorage());const e=createdEntry(storage);const r=reader('604800');
 const out=await verifyRecoveryWindow(e,{readClient:r,journal:createJournal(storage)});
 expect(out.recoveryCheck).toMatchObject({state:'match',expected:'604800',onChain:'604800'});
 expect(recoveryCheckText(out)).toBe('Recovery window confirmed on chain: 168 hours (7 days).');
 expect(createJournal(storage).list()[0].recoveryCheck.state).toBe('match');
 await verifyRecoveryWindow(createJournal(storage).list()[0],{readClient:r,journal:createJournal(storage)});
 expect(r.readContract).toHaveBeenCalledTimes(1);
});
it('reports a mismatch clearly and never retries or resends',async()=>{
 const storage=safeStorage(memoryStorage());const e=createdEntry(storage);
 const out=await verifyRecoveryWindow(e,{readClient:reader('259200'),journal:createJournal(storage)});
 expect(out.recoveryCheck.state).toBe('mismatch');
 expect(recoveryCheckText(out)).toMatch(/^Recovery window MISMATCH: you chose 168 hours \(7 days\), the contract has 72 hours \(3 days\)\. Do not resend/);
});
it('records a read error, survives a reload, and checks again on the next refresh',async()=>{
 const storage=safeStorage(memoryStorage());const e=createdEntry(storage);
 const failed=await verifyRecoveryWindow(e,{readClient:reader(new Error('rpc timeout')),journal:createJournal(storage)});
 expect(failed.recoveryCheck).toMatchObject({state:'read-error',expected:'604800',error:'rpc timeout'});
 expect(recoveryCheckText(failed)).toMatch(/Could not read the recovery window yet \(rpc timeout\).*Nothing will be resent/);
 const reloaded=createJournal(storage).list()[0]; // a page refresh reads the record back
 expect(reloaded.recoveryCheck.state).toBe('read-error');expect(reloaded.expectedRecoverySeconds).toBe(604800);
 const ok=await verifyRecoveryWindow(reloaded,{readClient:reader('604800'),journal:createJournal(storage)});
 expect(ok.recoveryCheck.state).toBe('match');
});
it('treats a malformed value as a read error, not a match',async()=>{
 const storage=safeStorage(memoryStorage());
 const out=await verifyRecoveryWindow(createdEntry(storage),{readClient:reader('abc'),journal:createJournal(storage)});
 expect(out.recoveryCheck.state).toBe('read-error');
});
it.each([
 ['not final',{final:false,ok:false,key:'accepted'}],
 ['finalized without success',{final:true,ok:false,key:'failed'}],
])('does not read before a successful final creation (%s)',async(_n,verdict)=>{
 const storage=safeStorage(memoryStorage());const r=reader('604800');
 const out=await verifyRecoveryWindow(createdEntry(storage,{verdict}),{readClient:r,journal:createJournal(storage)});
 expect(r.readContract).not.toHaveBeenCalled();expect(out.recoveryCheck).toBeUndefined();
});
it('ignores records without a chosen window (earlier projects and worker calls)',async()=>{
 const r=reader('259200');
 expect(await verifyRecoveryWindow({kind:'call',expectedRecoverySeconds:604800},{readClient:r,journal:{update:vi.fn()}})).toEqual({kind:'call',expectedRecoverySeconds:604800});
 const legacy={kind:'deploy',verdict:{final:true,ok:true},createdAddress:CREATED};
 expect(await verifyRecoveryWindow(legacy,{readClient:r,journal:{update:vi.fn()}})).toBe(legacy);
 expect(r.readContract).not.toHaveBeenCalled();expect(recoveryCheckText(legacy)).toBeNull();
});

import {emailCommitment} from '../src/workspace/one-tx.js';
import {commitmentPreimage,newEmailSalt,EMAIL_COMMITMENT_TAG} from '../src/workspace/email-commitment.js';
const S1='00'.repeat(31)+'01';
it('new projects commit a salted email; the legacy digest is never sent',async()=>{
 expect(await emailCommitment('client@example.com',S1)).toBe('30c6d13e2195647f4b08524e1f5012d205cf360f8c329e96c23201c674c55d77');
 const r=await prep(base);
 expect(r.emailSalt).toMatch(/^[0-9a-f]{64}$/);
 expect(r.args.at(-1)).toBe(await emailCommitment('client@example.com',r.emailSalt));
 expect(r.args.at(-1)).not.toBe(await hashEmail('client@example.com'));
 const again=await prep(base);
 expect(again.emailSalt).not.toBe(r.emailSalt);expect(again.args.at(-1)).not.toBe(r.args.at(-1));
});
it('the previewed salt is reused at send time, so the shown commitment is the one sent',async()=>{
 const r=await prepareOneTx(base,new Uint8Array([1]),{chain:testnetBradbury,account:'0x'+'a1'.repeat(20),readClient:chainRead(),emailSalt:S1});
 expect(r.emailSalt).toBe(S1);expect(r.args.at(-1)).toBe('30c6d13e2195647f4b08524e1f5012d205cf360f8c329e96c23201c674c55d77');
});
it('the worker commitment is salted too',async()=>{
 const r=await preflight([{url:pinned}]);
 expect(r.emailSalt).toMatch(/^[0-9a-f]{64}$/);
 expect(r.args[2]).toBe(await emailCommitment('worker@example.com',r.emailSalt));
 expect(r.args[2]).not.toBe(await hashEmail('worker@example.com'));
});
it('salts are 32 random bytes and malformed salts are refused',()=>{
 const a=newEmailSalt(),b=newEmailSalt();expect(a).toMatch(/^[0-9a-f]{64}$/);expect(a).not.toBe(b);
 expect(newEmailSalt({getRandomValues:x=>x.fill(255)})).toBe('ff'.repeat(32));
 for(const bad of ['AB'.repeat(32),'ab'.repeat(31),'',null])expect(()=>commitmentPreimage('client@example.com',bad)).toThrow('salt');
 expect(commitmentPreimage(' Client@Example.com ',S1)).toBe(`${EMAIL_COMMITMENT_TAG}\n${S1}\nclient@example.com`);
});
it('enrollment sends the salt with the email to the service, from the durable record',async()=>{
 const entry={id:'one',evmHash:'0x'+'ab'.repeat(32),enrollment:{role:'client',email:'client@example.com',emailSalt:S1}};
 let body;await enrollEntry(entry,{journal:{update:vi.fn()},api:'http://service',fetchImpl:async(_u,init)=>{body=JSON.parse(init.body);return {ok:true,json:async()=>({recorded:true})};}});
 expect(body).toEqual({evmHash:entry.evmHash,role:'client',email:'client@example.com',emailSalt:S1});
});
