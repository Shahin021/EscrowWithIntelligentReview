import {describe,it,expect} from 'vitest';
import {selectWorkerAccount} from '../src/workspace/one-tx-wallet.js';
describe('explicit worker account selection',()=>{
 it('opens permission selection even for a connected account and never signs',async()=>{
  const calls=[];const p={request:async x=>{calls.push(x);return x.method==='eth_requestAccounts'?['0xworker']:[];}};
  expect(await selectWorkerAccount(p)).toEqual(['0xworker']);
  expect(calls.map(x=>x.method)).toEqual(['wallet_requestPermissions','eth_requestAccounts']);
  expect(calls[0].params).toEqual([{eth_accounts:{}}]);
 });
 it('does not continue after rejection',async()=>{
  const calls=[];const p={request:async x=>{calls.push(x.method);throw Object.assign(new Error('Rejected'),{code:4001});}};
  await expect(selectWorkerAccount(p)).rejects.toThrow('Rejected');expect(calls).toEqual(['wallet_requestPermissions']);
 });
 it.each([4200,-32601])('falls back only for unsupported selection (%s)',async code=>{
  const p={request:async x=>{if(x.method==='wallet_requestPermissions')throw {code};return ['worker'];}};
  expect(await selectWorkerAccount(p)).toEqual(['worker']);
 });
 it('does not hide disconnects as account selection',async()=>{
  await expect(selectWorkerAccount({request:async()=>{throw Object.assign(new Error('Disconnected'),{code:4900});}})).rejects.toThrow('Disconnected');
 });
 it('rejects an empty account result',async()=>{
  await expect(selectWorkerAccount({request:async()=>[]})).rejects.toThrow('No account');
 });
});

import {createWalletSession} from '../src/workspace/one-tx-wallet.js';
import {safeStorage,memoryStorage} from '../src/workspace/storage.js';
describe('wallet session lifecycle',()=>{
 function setup(storage=safeStorage(memoryStorage())){
  const calls=[],states=[];let accounts=['worker'];
  const provider={request:async({method})=>{calls.push(method);return accounts;}};
  const session=createWalletSession({provider,storage,ensureNetwork:async()=>{},onChange:a=>states.push(a)});
  return {session,storage,calls,states,provider,setAccounts:a=>accounts=a};
 }
 it('passively restores an approved account without prompting',async()=>{
  const h=setup();await h.session.connect({passive:true});expect(h.session.account).toBe('worker');expect(h.calls).toEqual(['eth_accounts','eth_accounts']);
 });
 it('disconnects without wallet calls and remains disconnected after reload and account events',async()=>{
  const h=setup();await h.session.connect();h.calls.length=0;h.session.disconnect();expect(h.session.account).toBeNull();
  const reload=setup(h.storage);await reload.session.connect({passive:true});reload.session.invalidate();await reload.session.connect({passive:true});expect(reload.calls).toEqual([]);expect(h.calls).toEqual([]);
 });
 it('explicit reconnection clears the preference and later permits passive restore',async()=>{
  const h=setup();h.session.disconnect();await h.session.connect();const reload=setup(h.storage);await reload.session.connect({passive:true});expect(reload.session.account).toBe('worker');
 });
 it('a delayed response cannot undo disconnect',async()=>{
  const h=setup();let release;h.provider.request=()=>new Promise(r=>release=r);const pending=h.session.connect({passive:true});h.session.disconnect();release(['worker']);await pending;expect(h.session.account).toBeNull();expect(h.states).toEqual([null]);
 });
 it('clears stale identity when the wallet is locked',async()=>{
  const h=setup();await h.session.connect();h.setAccounts([]);await h.session.connect({passive:true});expect(h.session.account).toBeNull();
 });
 it('reads the current account after network selection instead of trusting an earlier account',async()=>{
  const storage=safeStorage(memoryStorage());let accounts=['client'];
  const session=createWalletSession({storage,provider:{request:async()=>accounts},ensureNetwork:async()=>{accounts=['worker'];}});
  expect(await session.connect()).toBe('worker');
 });
 it('network errors leave the app disconnected',async()=>{
  const session=createWalletSession({storage:safeStorage(memoryStorage()),provider:{request:async()=>['worker']},ensureNetwork:async()=>{throw new Error('wrong network');}});
  await expect(session.connect()).rejects.toThrow('wrong network');expect(session.account).toBeNull();
 });
});

it('does not publish an account if the network changes during connection',async()=>{
 let calls=0;
 const session=createWalletSession({storage:safeStorage(memoryStorage()),provider:{request:async()=>['worker']},ensureNetwork:async()=>{if(++calls===2)throw new Error('network changed');}});
 await expect(session.connect()).rejects.toThrow('network changed');expect(session.account).toBeNull();
});

it('explicit connect opens account selection instead of silently reusing the old site permission',async()=>{
 const calls=[];let accounts=['old-worker'];
 const session=createWalletSession({storage:safeStorage(memoryStorage()),ensureNetwork:async()=>{},provider:{request:async({method})=>{calls.push(method);if(method==='wallet_requestPermissions')accounts=['chosen-client'];return accounts;}}});
 expect(await session.connect()).toBe('chosen-client');
 expect(calls).toEqual(['wallet_requestPermissions','eth_requestAccounts','eth_accounts']);
 const restored=createWalletSession({storage:safeStorage(memoryStorage()),ensureNetwork:async()=>{},provider:{request:async({method})=>{expect(method).toBe('eth_accounts');return accounts;}}});
 expect(await restored.connect({passive:true})).toBe('chosen-client');
});
