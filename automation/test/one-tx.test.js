import { it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics } from 'viem';
import { createOneTxEnrollment, emailDigest, filterOnchainConsents } from '../src/one-tx.js';
import { CHAIN, CLIENT, WORKER, NOW, ESCROW, tempDb, snapshot, baseConfig } from './helpers.js';
import { planActions } from '../src/planner.js';

const evmHash='0x'+'a1'.repeat(32), txId='0x'+'b1'.repeat(32);
function setup() {
 const {db}=tempDb();const snap=snapshot();
 snap.oneTx={interface:'genlayer.escrow-one-tx.v1',client:{scopes:5,max_amount:'2000',expires_at:String(NOW+86400),nonce:'1',email_hash:emailDigest('client@example.com')},deliveries_committed:'0'};
 const event=CHAIN.consensusMainContract.abi.find(e=>e.name==='NewTransaction');
 const chain={chainConfig:CHAIN,receipt:{status:'success',logs:[{address:CHAIN.consensusMainContract.address,data:'0x',topics:encodeEventTopics({abi:[event],eventName:'NewTransaction',args:{txId,recipient:ESCROW,activator:CLIENT.address}})}]},
 tx:{recipient:ESCROW,sender:CLIENT.address,statusName:'ACCEPTED',resultName:'AGREE',txExecutionResultName:'FINISHED_WITH_RETURN'},
 getReceipt:async()=>chain.receipt,getGenLayerTx:async()=>chain.tx,snapshot:async()=>snap};
 const make=()=>createOneTxEnrollment({db,chain,config:baseConfig(),now:()=>NOW});
 return {db,chain,snap,make,enroll:make()};
}
it('persists enrollment immediately, requires no signature, and resumes only after successful finality',async()=>{
 const h=setup();h.enroll.add({evmHash,role:'client',email:'CLIENT@example.com'});
 await h.enroll.tick();assert.equal(h.db.prepare('SELECT count(*) n FROM consents').get().n,0);
 h.chain.tx.statusName='FINALIZED';await h.make().tick();
 assert.equal(h.enroll.status(evmHash).state,'enrolled');
 assert.equal(h.db.prepare('SELECT signature FROM consents').get().signature,'onchain-v1');
 await h.make().tick();assert.equal(h.db.prepare('SELECT count(*) n FROM consents').get().n,1);
 assert.equal(h.db.prepare('SELECT count(*) n FROM outbox').get().n,1);
});
it('a failed transaction cannot authorize operator actions or emails',async()=>{
 const h=setup();h.enroll.add({evmHash,role:'client',email:'client@example.com'});
 h.chain.tx.statusName='FINALIZED';h.chain.tx.txExecutionResultName='FINISHED_WITH_ERROR';await h.enroll.tick();
 assert.equal(h.enroll.status(evmHash).state,'blocked');assert.equal(h.db.prepare('SELECT count(*) n FROM consents').get().n,0);
});
it('a different email or sender cannot enroll as the party',async()=>{
 for(const mismatch of ['email','sender']) {
 const h=setup();h.enroll.add({evmHash,role:'client',email:mismatch==='email'?'attacker@example.com':'client@example.com'});
 h.chain.tx.statusName='FINALIZED';if(mismatch==='sender')h.chain.tx.sender=WORKER.address;
 await h.enroll.tick();assert.equal(h.enroll.status(evmHash).state,'blocked');
 }
});
it('on-chain expiry, revocation and authorization version are checked on every fresh snapshot',async()=>{
 const h=setup();h.enroll.add({evmHash,role:'client',email:'client@example.com'});h.chain.tx.statusName='FINALIZED';await h.enroll.tick();
 const rows=h.db.prepare('SELECT * FROM consents').all();assert.equal(filterOnchainConsents(rows,h.snap).length,1);
 h.snap.oneTx.client.nonce='2';assert.equal(filterOnchainConsents(rows,h.snap).length,0);
 h.snap.oneTx.client.nonce='1';h.snap.oneTx.client.max_amount='0';assert.equal(filterOnchainConsents(rows,h.snap).length,0);
});
it('cannot subscribe a second address to an existing transaction',()=>{
 const h=setup();h.enroll.add({evmHash,role:'client',email:'client@example.com'});
 assert.throws(()=>h.enroll.add({evmHash,role:'client',email:'other@example.com'}));
});
it('only precommitted worker evidence can advance a later milestone',()=>{
 const s=snapshot();s.oneTx={deliveries_committed:'2'};s.grants={worker:{max_amount:'2000',expires_at:String(NOW+100)}};
 const p=planActions(s,[{id:1,role:'worker',scopes:7,maxAmount:'2000'}]);
 assert.ok(p.some(x=>x.functionName==='submit_precommitted'));
 assert.ok(!planActions({...s,oneTx:null},[{id:1,scopes:7,maxAmount:'2000'}]).some(x=>x.functionName==='submit_precommitted'));
});
