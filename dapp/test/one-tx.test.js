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
