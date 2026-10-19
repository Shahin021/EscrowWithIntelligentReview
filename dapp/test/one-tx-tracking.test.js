import {it,expect,vi,describe} from 'vitest';
import {savedProjects,readTrackedProject,boundedRead} from '../src/workspace/one-tx-tracking.js';
import {createJournal} from '../src/workspace/journal.js';
import {safeStorage,memoryStorage} from '../src/workspace/storage.js';
const address='0x'+'a1'.repeat(20),worker='0x'+'b2'.repeat(20);
const deployment=(over={})=>({id:'deploy1',kind:'deploy',project:'deploy',value:'1',createdAddress:address,enrollment:{role:'client'},args:[worker,'[{"spec":"Original submitted requirement","amount":"1"}]','raw.githubusercontent.com/example/repo','text',1,false,'',0,1800000000],...over});
it('recovers the submitted form from the existing journal after refresh, not from current empty inputs',()=>{
 const local=memoryStorage();let journal=createJournal(safeStorage(local));journal.create(deployment());
 journal=createJournal(safeStorage(local));const [row]=savedProjects(journal.list());
 expect(row.address).toBe(address);expect(row.terms.milestones[0].spec).toBe('Original submitted requirement');expect(row.terms.principalWei).toBe('1');
});
it('groups client and worker submissions under one project, retaining both receipt identities',()=>{
 const [row]=savedProjects([deployment(),{id:'worker1',project:address.toUpperCase().replace('0X','0x'),kind:'call',enrollment:{role:'worker'},txId:'0x'+'c3'.repeat(32)}]);
 expect(row.entries).toHaveLength(2);expect(row.id).toBe('deploy1');
});
it('a pending deployment stays identifiable before its address exists',()=>{
 const [row]=savedProjects([deployment({createdAddress:null,evmHash:'0x'+'d4'.repeat(32),phase:'sent'})]);
 expect(row.address).toBeNull();expect(row.key).toContain('deployment:');expect(row.entries[0].phase).toBe('sent');
});
it('the saved selection identity survives address discovery',()=>{
 const before=savedProjects([deployment({createdAddress:null})])[0];
 const after=savedProjects([deployment()])[0];expect(after.id).toBe(before.id);
});
it('does not invent a form from unreadable saved terms or claim unrelated browser entries',()=>{
 expect(savedProjects([deployment({args:[worker,'broken-json']}),{id:'legacy'}])[0].terms).toBeNull();
 expect(savedProjects([{id:'legacy'}])).toEqual([]);
});
function reader({balanceFails=false,readFails=false}={}) {
 const c={readContract:vi.fn(async({functionName})=>{
 if(readFails)throw new Error('Finalized state not available yet');
 return {parties:{interface_id:'genlayer.milestone-escrow.v2',milestone_count:'1',project_status:'AWAITING_DEPOSIT',total_funded:'0'},get_accounting:{locked:'0',deposit_credit_held:'1'},get_milestone_status:'LOCKED',get_milestone_amount:'1',get_milestone_spec:'Agreed requirements',get_one_tx_authorizations:{interface:'genlayer.escrow-one-tx.v1',deliveries_committed:'0'}}[functionName];
 }),getBalance:vi.fn(async()=>{if(balanceFails)throw new Error('RPC offline');return 0n;}),writeContract:vi.fn(),deployContract:vi.fn()};return c;
}
it('only reads finalized contract state, and keeps deposit credit distinct from funded principal',async()=>{
 const c=reader();const s=await readTrackedProject(c,address);
 expect(s.parties.total_funded).toBe('0');expect(s.accounting.deposit_credit_held).toBe('1');expect(s.parties.project_status).toBe('AWAITING_DEPOSIT');
 for(const [call] of c.readContract.mock.calls)expect(call.transactionHashVariant).toBe('latest-final');
 expect(c.writeContract).not.toHaveBeenCalled();expect(c.deployContract).not.toHaveBeenCalled();
});
it('an unavailable balance is unknown, not a zero balance',async()=>{
 expect((await readTrackedProject(reader({balanceFails:true}),address)).balance).toBeNull();
 expect((await readTrackedProject(reader(),address)).balance).toBe('0');
});
it('read failure never becomes a successful project state',async()=>{
 await expect(readTrackedProject(reader({readFails:true}),address)).rejects.toThrow('not available');
});
it('invalid addresses are rejected before any RPC read',async()=>{
 const c=reader();await expect(readTrackedProject(c,'not an address')).rejects.toThrow();expect(c.readContract).not.toHaveBeenCalled();
});
it('a stalled read has a bounded wait and can be retried',async()=>{
 await expect(boundedRead(new Promise(()=>{}),5)).rejects.toThrow('timed out');
 expect(await boundedRead(Promise.resolve('fresh'),5)).toBe('fresh');
});

import {projectIndicator} from '../src/workspace/one-tx-tracking.js';
describe('project status indicators',()=>{
 const row={entries:[{phase:'done',verdict:{ok:true}}]};
 const chain=status=>({chain:{parties:{project_status:'ACTIVE'},milestones:[{status}]}});
 it('does not call a finalized deployment evidence approval',()=>{
  expect(projectIndicator(row,chain('AWAITING_DELIVERY'))).toEqual({tone:'neutral',label:'Ready for delivery'});
 });
 it('shows awaiting confirmation separately from successful execution',()=>{
  expect(projectIndicator({entries:[{phase:'tracking'}]},chain('AWAITING_DELIVERY')).tone).toBe('pending');
 });
 it('uses orange for unavailable evidence even when resolve succeeded',()=>{
  expect(projectIndicator(row,chain('EVIDENCE_UNAVAILABLE')).tone).toBe('problem');
 });
 it('uses green only for evidence approval or released payment with an explicit label',()=>{
  expect(projectIndicator(row,chain('APPROVED'))).toEqual({tone:'success',label:'Evidence approved'});
  expect(projectIndicator(row,chain('RELEASED')).label).toBe('Payment released');
 });
 it('uses red for rejection and orange for failed reads or refunds',()=>{
  expect(projectIndicator(row,chain('REJECTED_FINAL')).tone).toBe('rejected');
  expect(projectIndicator(row,{readError:true}).tone).toBe('problem');
  expect(projectIndicator(row,chain('REFUNDED')).tone).toBe('problem');
 });
});
