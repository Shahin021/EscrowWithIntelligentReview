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

// v2: salted email commitments
import { createOneTxEnrollment as enrollmentFor } from '../src/one-tx.js';
import { emailCommitment } from '../../dapp/src/workspace/one-tx.js';
const SALT='00'.repeat(31)+'01', SALT2='ab'.repeat(32);
const VECTOR='30c6d13e2195647f4b08524e1f5012d205cf360f8c329e96c23201c674c55d77'; // python hashlib, independent of this code
function salted(salt=SALT) { const h=setup(); h.snap.oneTx.client.email_hash=emailDigest('client@example.com',salt); return h; }
it('v2 commitment matches the fixed vector, the site implementation, and normalizes the email',async()=>{
 assert.equal(emailDigest('client@example.com',SALT),VECTOR);
 assert.equal(emailDigest('  Client@Example.COM ',SALT),VECTOR);
 assert.equal(await emailCommitment('client@example.com',SALT),VECTOR);
 assert.notEqual(emailDigest('client@example.com',SALT2),VECTOR);
 assert.equal(emailDigest('client@example.com'),'f93fa2e5fb59200922637972bb68e780754fc45c0b8f4f9467779f9dc8e3dfe1','legacy digest unchanged');
});
it('the on-chain value cannot be matched from a guessed email without the salt',()=>{
 const h=salted();
 for(const guess of ['client@example.com','CLIENT@example.com']) assert.notEqual(emailDigest(guess),h.snap.oneTx.client.email_hash);
});
it('a salted enrollment is verified with its salt and keeps it for every later check',async()=>{
 const h=salted();h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt:SALT});
 h.chain.tx.statusName='FINALIZED';await h.enroll.tick();
 assert.equal(h.enroll.status(evmHash).state,'enrolled');
 const rows=h.db.prepare('SELECT * FROM consents').all();
 assert.equal(rows[0].email_salt,SALT);
 assert.equal(filterOnchainConsents(rows,h.snap).length,1);
 assert.equal(filterOnchainConsents(rows.map(r=>({...r,email_salt:SALT2})),h.snap).length,0);
 assert.equal(filterOnchainConsents(rows.map(r=>({...r,email_salt:null})),h.snap).length,0);
});
it('a missing or wrong salt cannot enroll against a salted commitment',async()=>{
 for(const emailSalt of [undefined,SALT2]) {
  const h=salted();h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt});
  h.chain.tx.statusName='FINALIZED';await h.enroll.tick();
  assert.equal(h.enroll.status(evmHash).state,'blocked');assert.equal(h.db.prepare('SELECT count(*) n FROM consents').get().n,0);
 }
});
it('refuses malformed salts and a second enrollment with a different salt',()=>{
 const h=setup();
 for(const emailSalt of ['AB'.repeat(32),'ab'.repeat(31),'zz'.repeat(32),42]) assert.throws(()=>h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt}),/salt/);
 h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt:SALT});
 assert.equal(h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt:SALT}).recorded,true,'same request is idempotent');
 assert.throws(()=>h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt:SALT2}),/different enrollment/);
 assert.throws(()=>h.enroll.add({evmHash,role:'client',email:'client@example.com'}),/different enrollment/);
});
it('migrates an existing database in place; legacy rows stay valid and unsalted',async()=>{
 const t=tempDb();
 t.db.exec(`CREATE TABLE one_tx_watches (evm_hash TEXT PRIMARY KEY, role TEXT NOT NULL, email TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', escrow TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
 t.db.prepare('INSERT INTO one_tx_watches (evm_hash,role,email,created_at,updated_at) VALUES (?,?,?,?,?)').run(evmHash,'client','client@example.com',NOW,NOW);
 assert.ok(!t.db.prepare('PRAGMA table_info(consents)').all().some(c=>c.name==='email_salt'));
 const h=setup();h.chain.tx.statusName='FINALIZED';
 const e=createOneTxEnrollment({db:t.db,chain:h.chain,config:baseConfig(),now:()=>NOW});
 enrollmentFor({db:t.db,chain:h.chain,config:baseConfig(),now:()=>NOW}); // idempotent on restart
 for(const table of ['one_tx_watches','consents']) assert.ok(t.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='email_salt'),table);
 await e.tick();
 assert.equal(e.status(evmHash).state,'enrolled');
 assert.equal(t.db.prepare('SELECT email_salt FROM consents').get().email_salt,null);
});
it('the salt is never returned by the watch status',()=>{
 const h=setup();h.enroll.add({evmHash,role:'client',email:'client@example.com',emailSalt:SALT});
 assert.deepEqual(Object.keys(h.enroll.status(evmHash)).sort(),['error','escrow','state']);
 assert.ok(!JSON.stringify(h.enroll.status(evmHash)).includes(SALT.slice(-8)));
});
