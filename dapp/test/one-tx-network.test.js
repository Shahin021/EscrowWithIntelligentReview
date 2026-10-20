import {it,expect} from 'vitest';
import {ensureBradbury} from '../src/workspace/one-tx-network.js';
it('accepts hexadecimal Bradbury without a switch',async()=>{
 const calls=[];await ensureBradbury({request:async a=>{calls.push(a.method);return '0x107d';}},{interactive:true});
 expect(calls).toEqual(['eth_chainId']);
});
it('passive reconnect reports the actual chain and never prompts',async()=>{
 const calls=[];await expect(ensureBradbury({request:async a=>{calls.push(a.method);return '0xf22f';}})).rejects.toThrow('61999');
 expect(calls).toEqual(['eth_chainId']);
});
it('explicit Connect switches and verifies the selected chain, without sending or signing',async()=>{
 let chain='0xf22f';const calls=[];
 await ensureBradbury({request:async a=>{calls.push(a);if(a.method==='wallet_switchEthereumChain'){chain=a.params[0].chainId;return null;}return chain;}},{interactive:true});
 expect(calls.map(a=>a.method)).toEqual(['eth_chainId','wallet_switchEthereumChain','eth_chainId']);
 expect(calls[1].params).toEqual([{chainId:'0x107d'}]);
});
it('refuses a wallet that says it switched but still reports the wrong chain',async()=>{
 await expect(ensureBradbury({request:async a=>a.method==='eth_chainId'?'0x107e':null},{interactive:true})).rejects.toThrow('4222');
});
it('a rejected switch does not proceed',async()=>{
 await expect(ensureBradbury({request:async a=>{if(a.method==='eth_chainId')return '0x1';throw Object.assign(new Error('Rejected'),{code:4001});}},{interactive:true})).rejects.toThrow('Rejected');
});
