import { createClient } from 'genlayer-js';
import { testnetBradbury as chain } from 'genlayer-js/chains';
import { readFinalityWindow, windowLabel } from './workspace/auto-tracker.js';
import { loadArtifact } from './workspace/artifact.js';
import { ONE_TX_ARTIFACT, prepareOneTx, prepareWorker, enrollEntry } from './workspace/one-tx.js';
import { createGuardedProvider } from './workspace/guard.js';
import { createJournal } from './workspace/journal.js';
import { safeStorage } from './workspace/storage.js';
import { sendTracked, advance, releaseIfNeverForwarded, checkPossiblySent } from './workspace/sender.js';

const $ = id => document.getElementById(id);
const api = (import.meta.env.VITE_AUTOMATION_URL || 'http://127.0.0.1:8788').replace(/\/$/,'');
const readClient = createClient({chain});
const journal = createJournal(safeStorage(globalThis.localStorage));
const consensus = chain.consensusMainContract;
let account, guard, client, prepared, code, workerPreview, busy=false, refreshing=false;
const text = x => JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v,2);
const message = value => { $('message').textContent=value; };
async function info(requireSending=false) {
  const response = await fetch(`${api}/v1/info`);
  if (!response.ok) throw new Error('Background service unavailable. Nothing can be sent.');
  const i=await response.json();
  if (i.chainId!==4221 || !i.oneTransactionEnrollment) throw new Error('Start the matching one-transaction service first.');
  $('service').textContent=i.sendingEnabled ? `Background operator online: ${i.operator}. Email delivery: ${i.mailTransport || 'unknown'}.` : 'Tracking only: the service has no active sender. Configure its dedicated operator before testing automatic continuation.';
  if (requireSending && !i.sendingEnabled) throw new Error('The operator is in tracking-only mode. Enable and fund its dedicated account first; otherwise later steps cannot be automatic.');
  return i;
}
async function connect(passive=false) {
  if (!window.ethereum) throw new Error('Open this page with MetaMask available.');
  const accounts=await window.ethereum.request({method:passive?'eth_accounts':'eth_requestAccounts'});
  if(!accounts.length) return;
  if (Number(await window.ethereum.request({method:'eth_chainId'}))!==4221) throw new Error('Select the Bradbury network in your wallet.');
  account=accounts[0];
  guard=createGuardedProvider({provider:window.ethereum,chainId:4221,consensus});
  client=createClient({chain,account,provider:guard});
  $('account').textContent=account;
  prepared=null;$('create').disabled=true;
}
const form = () => ({worker:$('worker').value,email:$('client-email').value,allowedSources:$('sources').value,milestones:JSON.parse($('milestones').value),renderMode:'text',maxRevisions:1,recoveryHours:'72',registry:'',continueAfterRefund:false});
const formKey=()=>text(form());
async function preview() {
  if (!account) await connect();
  await info(true);
  if (!$('terms').checked) throw new Error('Accept the one-review project terms before previewing.');
  code=await loadArtifact({artifact:ONE_TX_ARTIFACT});
  const f=form();
  prepared={...await prepareOneTx(f,code,{chain,account,readClient}),formKey:formKey(),account};
  $('preview-result').textContent=text({principalWei:prepared.value,gasLimit:prepared.gas,worker:f.worker,reviewAttemptsPerMilestone:1,automationExpires:new Date(prepared.expires*1000).toISOString(),clientScopes:'review and recover',network:'Bradbury 4221',emailHash:prepared.args.at(-1),milestones:prepared.verified.milestones});
  $('create').disabled=false;
}
async function send(request) {
  if (!account) await connect();
  await info(true);
  if (busy) throw new Error('A wallet action is already open.');
  const pending=journal.list({network:'testnetBradbury',account}).find(e=>e.enrollment?.role===request.enrollment.role && !['done','not-sent'].includes(e.phase) && (request.kind==='deploy' || e.project?.toLowerCase()===request.project?.toLowerCase()));
  if(pending) throw new Error('Your original transaction is still tracked. It will not be sent again; see Background progress.');
  busy=true;
  try {
    const e=await sendTracked({...request,chainId:4221,network:'testnetBradbury',account},{client,guard,journal,readClient,consensus,polls:1,sdkGraceMs:0,onUpdate:e=>{ $('progress').textContent=text(e); }});
    await enrollEntry(e,{journal,api});
    message('Background tracking recorded. You can close the browser; the online service will continue after finality. Confirm your email using its verification message.');
  } finally {busy=false;await refresh();}
}
async function create() {
  if (!prepared || prepared.formKey!==formKey() || prepared.account!==account || !$('terms').checked) throw new Error('Preview these exact terms first.');
  // Re-estimate fresh, so the value, gas and validUntil shown at the wallet
  // boundary come from the same new request; never fallback to an unfunded deploy.
  const f=form();const p=await prepareOneTx(f,code,{chain,account,readClient});
  await send({kind:'deploy',label:'Create, fund and authorize',code,constructorArgs:p.args,value:p.value,minGas:p.gas,maxGas:16777216n,fundedDeploy:p.call,enrollment:{role:'client',email:f.email.trim().toLowerCase()}});
  $('create').disabled=true;prepared=null;
}
async function loadProject() {
  const project=$('project').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(project)) throw new Error('Enter the new project address.');
  const read=(functionName,args=[])=>readClient.readContract({address:project,functionName,args,transactionHashVariant:'latest-final'});
  const [parties,auth]=await Promise.all([read('parties'),read('get_one_tx_authorizations')]);
  if(auth.interface!=='genlayer.escrow-one-tx.v1') throw new Error('Not a one-transaction project.');
  const count=Number(parties.milestone_count);
  if(!Number.isInteger(count)||count<1||count>10)throw new Error('Unexpected milestone count.');
  const milestones=[];
  for(let i=0;i<count;i++) {
    const criteria=[];
    const n=Number(await read('get_milestone_criteria_count',[i]));
    if(!Number.isInteger(n)||n<1||n>6) throw new Error('Unexpected criteria count.');
    for(let j=0;j<n;j++) criteria.push({text:await read('get_criterion_text',[i,j]),required:await read('get_criterion_required',[i,j])});
    milestones.push({index:i,spec:await read('get_milestone_spec',[i]),amountWei:await read('get_milestone_amount',[i]),criteria});
  }
  workerPreview=project.toLowerCase();
  $('worker-terms').textContent=text({parties,milestones,reviewAttemptsPerMilestone:1,technicalAuthorizationDays:30});
  $('worker-accept').checked=false;
}
async function submit() {
  if (!account) await connect();
  const project=$('project').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(project)) throw new Error('Enter the new project address.');
  if(workerPreview!==project.toLowerCase() || !$('worker-accept').checked) throw new Error('Read this project and accept its terms first.');
  const email=$('worker-email').value.trim().toLowerCase();
  const p=await prepareWorker({readClient,project,account,email,deliveries:JSON.parse($('deliveries').value)});
  await send({kind:'call',label:'Submit all evidence and authorize',project,functionName:'submit_once',args:p.args,value:0n,maxGas:3000000n,enrollment:{role:'worker',email}});
}
async function refresh() {
  if (refreshing) return;refreshing=true;
  try {
    const entries=journal.list({network:'testnetBradbury'}).filter(e=>e.enrollment);
    const out=[];
    for(let e of entries) {
      if(e.phase==='prompting' && !e.forwarded) e=releaseIfNeverForwarded(e,{journal}).entry || e;
      if(e.phase==='prompting' && e.forwardedAt && !e.evmHash) {
        const result=await checkPossiblySent(e,{readClient,consensus,journal});
        e=result.entry;
      }
      if(e.evmHash && e.phase!=='done') e=await advance(e,{readClient,consensus,journal,polls:1});
      if(e.evmHash) {
        try { e=await enrollEntry(e,{journal,api}); } catch(error){ e={...e,enrollmentError:error.message}; }
      }
      let background=null;
      if(e.enrollmentRecorded) background=await fetch(`${api}/v1/one-tx-watches/${e.evmHash}`).then(r=>r.json()).catch(()=>({state:'service offline'}));
      const project=e.createdAddress || (e.project!=='deploy'?e.project:null);
      const window=e.txId && !e.verdict?.final ? await readFinalityWindow(readClient,e.txId).catch(()=>({available:false})) : null;
      const jobs=project ? await fetch(`${api}/v1/projects/${project}`).then(r=>r.json()).catch(()=>null) : null;
      if(e.createdAddress) $('project').value=e.createdAddress;
      out.push({step:e.label,evmHash:e.evmHash,genLayerId:e.txId,project,consensus:e.verdict?.label || e.phase,estimatedWait:window?windowLabel(window):null,backgroundTracking:e.enrollmentRecorded?'recorded':'not yet recorded; keep page open',enrollmentError:e.enrollmentError,background,jobs:jobs?.jobs,possiblySent:e.possiblySent});
    }
    if(out.length) $('progress').textContent=text(out);
  } finally{refreshing=false;}
}
for(const [id,fn] of [['connect',()=>connect(false)],['preview',preview],['create',create],['load-project',loadProject],['submit',submit]]) $(id).onclick=()=>fn().catch(e=>message(e.message));
for(const id of ['worker','sources','milestones','client-email','terms']) $(id).addEventListener('input',()=>{$('create').disabled=true;prepared=null;});
window.ethereum?.on?.('accountsChanged',()=>{account=null;prepared=null;$('create').disabled=true;$('account').textContent='Account changed. Reconnect before sending.';});
window.ethereum?.on?.('chainChanged',()=>{account=null;prepared=null;$('create').disabled=true;message('Network changed. Reconnect to Bradbury.');});
window.addEventListener('beforeunload',e=>{if(busy || journal.list().some(x=>x.enrollment && x.evmHash && !x.enrollmentRecorded)){e.preventDefault();e.returnValue='';}});
info().catch(e=>message(e.message));
refresh().catch(e=>message(e.message));
setInterval(()=>refresh().catch(e=>message(e.message)),15000);

$('project').addEventListener('input',()=>{workerPreview=null;$('worker-accept').checked=false;});

if(window.ethereum) connect(true).catch(e=>message(e.message));
