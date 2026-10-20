
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
const {Window}=await import(pathToFileURL(process.env.ESCROW_AUDIT_DOM_MODULE || resolve('qa-tools/node_modules/happy-dom/lib/index.js')));
const repo=fileURLToPath(new URL('../../',import.meta.url));
const dapp=resolve(repo,'dapp');
const require=createRequire(resolve(dapp,'package.json'));
const actualSDK=await import(pathToFileURL(require.resolve('genlayer-js')));
const realArtifact=await import(pathToFileURL(resolve(dapp,'src/workspace/artifact.js')));
const realOneTx=await import(pathToFileURL(resolve(dapp,'src/workspace/one-tx.js')));
const realSender=await import(pathToFileURL(resolve(dapp,'src/workspace/sender.js')));
const address='0x'+'a1'.repeat(20),worker='0x'+'b1'.repeat(20),clientAccount='0x'+'c1'.repeat(20),other='0x'+'d1'.repeat(20);
const hash='0x'+'e1'.repeat(32);
const baseline=process.argv.includes('--baseline');
const pause=()=>new Promise(r=>setTimeout(r,15));
const deferred=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
let checks=0;
async function setup({savedStorage=null,locked=false,corrupt=false}={}){
 const w=new Window({url:'http://127.0.0.1:5184/one-tx.html'});w.document.write((baseline?execFileSync('git',['show','1b9093b:dapp/one-tx.html'],{cwd:repo,encoding:'utf8'}):readFileSync(resolve(dapp,'one-tx.html'),'utf8')).replace(/<script[^>]*>[\s\S]*?<\/script>/g,''));
 if(savedStorage)for(const [k,v]of savedStorage)w.localStorage.setItem(k,v);
 if(corrupt)w.localStorage.setItem('escrow-workspace:v2:journal','corrupt');
 const h={w,account:locked?null:worker,chain:'0x107d',rpc:[],sent:0,events:{},committed:0,service:true,readGate:null,blockGate:null,estimateGate:null,sendGate:null,enrollOffline:false,nextAccount:null};
 const provider={on:(event,fn)=>h.events[event]=fn,request:async({method,params})=>{
  h.rpc.push(method);
  if(method==='eth_accounts'||method==='eth_requestAccounts')return h.account?[h.account]:[];
  if(method==='eth_chainId')return h.chain;
  if(method==='wallet_requestPermissions'){if(h.rejectPermission)throw Object.assign(new Error('Rejected'),{code:4001});if(h.nextAccount){h.account=h.nextAccount;h.nextAccount=null;h.events.accountsChanged?.([h.account]);}return [];}
  if(method==='wallet_switchEthereumChain'){h.chain=params[0].chainId;h.events.chainChanged?.(h.chain);return null;}
  throw new Error(`Unexpected wallet method: ${method}`);
 }};
 w.ethereum=provider;
 const read={readContract:async({functionName,address:target})=>{
  if(h.readGate)await h.readGate.promise;
  return {parties:{interface_id:'genlayer.milestone-escrow.v2',worker,client:clientAccount,milestone_count:'1',project_status:'ACTIVE',total_required:'1',total_funded:'1',total_released:'0',total_refunded:'0'},get_accounting:{locked:'1',queued_out:'0',inflight_out:'0'},get_milestone_status:'AWAITING_DELIVERY',get_milestone_amount:'1',get_milestone_spec:target===other?'Other project':'Read the exact evidence',get_milestone_criteria_count:1,get_criterion_text:'Read the document',get_criterion_required:true,get_allowed_sources:'raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview',get_one_tx_authorizations:{interface:'genlayer.escrow-one-tx.v1',deliveries_committed:h.committed}}[functionName];
 },getBalance:async()=>1n,getBlock:async()=>{if(h.blockGate)await h.blockGate.promise;return {timestamp:1800000000n};},estimateTransactionGas:async()=>{if(h.estimateGate)await h.estimateGate.promise;return 15000000n;}};
 const fetch=async(url,options={})=>{
  const reply=body=>({ok:true,json:async()=>body});
  if(String(url).endsWith('/v1/info'))return reply({chainId:4221,oneTransactionEnrollment:true,sendingEnabled:h.service,operator:'operator',mailTransport:'file'});
  if(String(url).endsWith('/v1/one-tx-watches')&&options.method==='POST'){if(h.enrollOffline)throw new Error('service offline');return reply({recorded:true});}
  if(String(url).includes('/v1/one-tx-watches/'))return reply({state:'enrolled'});
  if(String(url).includes('/v1/projects/'))return reply({jobs:[],sendingEnabled:true,operator:'operator'});
  throw new Error(`Unexpected fetch: ${url}`);
 };
 const context=createContext({window:w,document:w.document,localStorage:w.localStorage,fetch,console,crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,setTimeout,clearTimeout,AbortSignal,URL,navigator:w.navigator});
 const cache=new Map();
 function synthetic(name,exports){const names=Object.keys(exports);return new SyntheticModule(names,function(){for(const k of names)this.setExport(k,exports[k]);},{context,identifier:name});}
 const sdk=synthetic('genlayer-js',{...actualSDK,createClient:()=>read});
 const artifact=synthetic('artifact',{...realArtifact,loadArtifact:async()=>new Uint8Array([1,2,3])});
 const oneTx=synthetic('one-tx',{...realOneTx,enrollEntry:(e,o)=>realOneTx.enrollEntry(e,{...o,fetchImpl:fetch})});
 const sender=synthetic('sender',{...realSender,sendTracked:async(request,{journal})=>{
  if(h.sendGate)await h.sendGate.promise;
  request.assertCurrent?.();
  h.sent++;
  const e=journal.create({kind:request.kind,network:'testnetBradbury',account:request.account,project:request.project||'deploy',functionName:request.functionName||'__deploy__',args:request.args||request.constructorArgs,value:String(request.value),enrollment:request.enrollment,label:request.label});
  if(h.lostAnswer){journal.update(e.id,{phase:'prompting',possiblySent:true,forwardedAt:Date.now(),forwarded:{data:'0x1234'}});throw new Error('Possibly sent: answer lost. Do not resend.');}
  h.committed=request.kind==='call'?1:h.committed;
  return journal.update(e.id,{phase:'tracking',verdict:h.failedFinal?{final:true,ok:false,label:'FINALIZED / FINISHED_WITH_ERROR'}:undefined,evmHash:hash,createdAddress:request.kind==='deploy'?address:undefined});
 },advance:async e=>e,checkPossiblySent:async e=>({entry:e}),readFinalityWindow:async()=>null});
 async function load(path){
  path=resolve(path);if(cache.has(path))return cache.get(path);
  const m=new SourceTextModule(baseline && path.endsWith('/src/one-tx-main.js')?execFileSync('git',['show','1b9093b:dapp/src/one-tx-main.js'],{cwd:repo,encoding:'utf8'}):readFileSync(path,'utf8'),{context,identifier:path,initializeImportMeta:meta=>meta.env={VITE_AUTOMATION_URL:'http://127.0.0.1:8790'}});cache.set(path,m);
  await m.link(async(spec,ref)=>{
   if(spec==='genlayer-js')return sdk;
   const target=spec.startsWith('.')?resolve(dirname(ref.identifier),spec):null;
   if(target?.endsWith('/one-tx.js'))return oneTx;
   if(target?.endsWith('/artifact.js'))return artifact;
   if(target?.endsWith('/sender.js'))return sender;
   if(target)return load(target);
   const host=await import(pathToFileURL(require.resolve(spec)));
   return synthetic(spec,host);
  });return m;
 }
 const main=await load(resolve(dapp,'src/one-tx-main.js'));await main.evaluate();await pause();
 h.$=id=>w.document.getElementById(id);
 h.click=async id=>{h.$(id).click();await pause();};
 h.input=(id,value)=>{h.$(id).value=value;h.$(id).dispatchEvent(new w.Event('input'));};
 h.accept=()=>{h.$('worker-accept').checked=true;h.$('worker-accept').dispatchEvent(new w.Event('input'));};
 h.load=async()=>{h.input('project',address);await h.click('load-project');h.input('deliveries',JSON.stringify([{url:'https://raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview/3baa66017d4368b3f4031a18719de8896653ce16/evidence/one-tx-deliverable.txt',notes:''}]));};
 h.change=async account=>{h.account=account;h.events.accountsChanged?.(account?[account]:[]);await pause();};
 h.save=()=>Array.from({length:w.localStorage.length},(_,i)=>{const k=w.localStorage.key(i);return [k,w.localStorage.getItem(k)];});
 h.done=()=>w.happyDOM.abort();
 return h;
}
// Actual main module + real DOM, journal, preflight and wallet-session modules.
{
 const h=await setup();assert.match(h.$('connect').textContent,/^0x.* · Disconnect$/);assert.equal(h.$('worker-connect').textContent,'Disconnect');assert.match(h.$('account').textContent,/b1b1/);checks++;
 await h.load();assert.match(h.$('worker-wallet-status').textContent,/Worker account ready/);h.accept();assert.equal(h.$('submit').disabled,false);checks++;
 h.rpc.length=0;await h.click('worker-connect');assert.equal(h.$('connect').textContent,'Connect wallet');assert.equal(h.$('submit').disabled,true);assert.deepEqual(h.rpc,[]);checks++;
 const reload=await setup({savedStorage:h.save()});assert.equal(reload.$('worker-connect').textContent,'Connect worker wallet');assert.deepEqual(reload.rpc,[]);checks++;
 await reload.click('worker-connect');assert.match(reload.$('connect').textContent,/^0x.* · Disconnect$/);assert.ok(reload.rpc.includes('wallet_requestPermissions'));checks++;
 await reload.load();reload.nextAccount=clientAccount;await reload.click('change-account');assert.match(reload.$('worker-wallet-status').textContent,/Wrong account/);assert.equal(reload.$('submit').disabled,true);assert.equal(reload.$('worker-connect').textContent,'Disconnect');checks++;
 reload.nextAccount=worker;await reload.click('change-account');reload.accept();assert.equal(reload.$('submit').disabled,false);checks++;
 reload.input('worker-email','bad');await reload.click('submit');assert.equal(reload.sent,0);assert.match(reload.$('worker-message').textContent,/email/i);checks++;
 reload.input('worker-email','worker@example.com');await reload.click('submit');assert.equal(reload.sent,1);assert.match(reload.$('worker-message').textContent,/Background tracking recorded/);assert.equal(reload.$('submit').disabled,true);await reload.click('submit');assert.equal(reload.sent,1);checks++;
 await reload.change(null);assert.equal(reload.$('connect').textContent,'Connect wallet');assert.equal(reload.$('worker-connect').textContent,'Connect worker wallet');assert.equal(reload.$('submit').disabled,true);checks++;
 h.done();reload.done();
}
{
 const h=await setup();h.chain='0x1';h.events.chainChanged?.(h.chain);await pause();assert.equal(h.$('connect').textContent,'Connect wallet');assert.equal(h.$('submit').disabled,true);await h.click('connect');assert.match(h.$('connect').textContent,/^0x.* · Disconnect$/);assert.equal(h.chain,'0x107d');checks++;h.done();
}
{
 const h=await setup();h.readGate=deferred();h.input('project',address);h.$('load-project').click();await pause();h.input('project',other);h.readGate.release();h.readGate=null;await pause();assert.equal(h.$('worker-summary').textContent,'');assert.equal(h.$('submit').disabled,true);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.blockGate=deferred();h.$('submit').click();await pause();await h.change(clientAccount);h.blockGate.release();h.blockGate=null;await pause();assert.equal(h.sent,0);assert.match(h.$('worker-message').textContent,/changed during preparation/);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.sendGate=deferred();h.$('submit').click();await pause();h.$('submit').click();h.sendGate.release();h.sendGate=null;await pause();assert.equal(h.sent,1);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.sendGate=deferred();h.$('submit').click();await pause();h.input('deliveries','[]');h.sendGate.release();h.sendGate=null;await pause();assert.equal(h.sent,0);assert.match(h.$('worker-message').textContent,/terms changed/);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.service=false;await h.click('submit');assert.equal(h.sent,0);assert.match(h.$('worker-message').textContent,/tracking-only/);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.lostAnswer=true;await h.click('submit');assert.equal(h.sent,1);await h.click('submit');assert.equal(h.sent,1);assert.equal(h.$('submit').disabled,true);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.enrollOffline=true;await h.click('submit');assert.equal(h.sent,1);assert.doesNotMatch(h.$('worker-message').textContent,/Background tracking recorded/);await h.click('submit');assert.equal(h.sent,1);checks++;h.done();
}
{
 const h=await setup({corrupt:true});await h.load();h.accept();assert.equal(h.$('submit').disabled,true);assert.equal(h.$('preview').disabled,true);assert.equal(h.w.localStorage.getItem('escrow-workspace:v2:journal'),'corrupt');checks++;h.done();
}
{
 const h=await setup();h.input('worker',clientAccount);h.input('client-email','client@example.com');h.$('terms').checked=true;h.$('terms').dispatchEvent(new h.w.Event('input'));h.estimateGate=deferred();h.$('preview').click();await pause();h.input('milestones','[{"spec":"Updated requirement","amount":"2"}]');h.estimateGate.release();h.estimateGate=null;await pause();assert.equal(h.$('create').disabled,true);assert.match(h.$('client-message').textContent,/terms changed/);assert.equal(h.sent,0);checks++;h.done();
}
{
 const h=await setup();await h.load();h.accept();h.input('worker-email','worker@example.com');h.failedFinal=true;await h.click('submit');assert.equal(h.sent,1);assert.match(h.$('worker-message').textContent,/without successful execution/);assert.doesNotMatch(h.$('worker-message').textContent,/Background tracking recorded/);checks++;h.done();
}
{
 const h=await setup();const root=h.$('milestone-builder');
 const amount=root.querySelector('input');amount.value='9007199254740993';amount.dispatchEvent(new h.w.Event('input'));
 assert.equal(JSON.parse(h.$('milestones').value)[0].amount,'9007199254740993');checks++;
 root.querySelector('.button-quiet').click();assert.equal(JSON.parse(h.$('milestones').value).length,2);
 const removes=root.querySelectorAll('.text-button');removes[1].click();assert.equal(JSON.parse(h.$('milestones').value).length,1);checks++;
 await h.load();const url=h.$('delivery-builder').querySelector('input');url.value='https://raw.githubusercontent.com/Shahin021/EscrowWithIntelligentReview/3baa66017d4368b3f4031a18719de8896653ce16/evidence/one-tx-deliverable.txt';url.dispatchEvent(new h.w.Event('input'));
 assert.equal(JSON.parse(h.$('deliveries').value)[0].url,url.value);assert.equal(h.$('deliveries').hidden,true);checks++;
 h.done();
}
console.log(`Passed ${checks} actual-app DOM scenarios with mocked wallet/RPC/sender. No live transactions.`);
