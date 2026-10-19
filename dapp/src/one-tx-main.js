import {mountSimpleForms} from './workspace/simple-forms.js';
import { createWalletSession } from './workspace/one-tx-wallet.js';
import { createClient } from 'genlayer-js';
import { boundedRead, mountProjectTracking } from './workspace/one-tx-tracking.js';
import { ensureBradbury } from './workspace/one-tx-network.js';
import { testnetBradbury as chain } from 'genlayer-js/chains';
import { readFinalityWindow, windowLabel } from './workspace/auto-tracker.js';
import { loadArtifact } from './workspace/artifact.js';
import { ONE_TX_ARTIFACT, prepareOneTx, prepareWorker, enrollEntry, recoveryWindow, recoveryLabel, verifyRecoveryWindow, recoveryCheckText } from './workspace/one-tx.js';
import { createGuardedProvider } from './workspace/guard.js';
import { createJournal } from './workspace/journal.js';
import { browserStorage } from './workspace/storage.js';
import { sendTracked, advance, releaseIfNeverForwarded, checkPossiblySent } from './workspace/sender.js';

const $ = id => document.getElementById(id);
function showPanel(name) {
  const label=$('page-label');if(label)label.textContent={tracking:'My projects',client:'Create project',worker:'Deliver work'}[name] || 'My projects';
  for(const panel of document.querySelectorAll('[data-panel]')) panel.hidden=panel.dataset.panel!==name;
  for(const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-pressed',String(tab.dataset.tab===name));
}
for(const tab of document.querySelectorAll('[data-tab]')) tab.onclick=()=>showPanel(tab.dataset.tab);
let expectedWorker=null;
function workerWalletStatus() {
  const short=account ? `${account.slice(0,6)}…${account.slice(-4)}` : '';
  for(const [id,disconnected] of [['connect','Connect wallet'],['worker-connect','Connect worker wallet']]) {
    $(id).textContent=account?(id==='connect'?`${short} · Disconnect`:'Disconnect'):disconnected;
    $(id).title=account?`Disconnect ${account} from this app`:disconnected;
    $(id).setAttribute('aria-label',$(id).title);
    $(id).disabled=busy || connecting;
  }
  $('header-change-account').hidden=!account;
  $('header-change-account').disabled=busy || connecting || actionBusy;
  $('change-account').hidden=!account;
  $('change-account').disabled=busy || connecting || actionBusy;
  $('account').textContent=account?`${account} · Bradbury · chain ID 4221`:'Wallet disconnected';
  $('worker-wallet-status').textContent=!account ? 'Connect MetaMask using the assigned worker account.' : expectedWorker && account.toLowerCase()!==expectedWorker.toLowerCase() ? `Wrong account. Use Change account and choose ${expectedWorker}. Nothing was sent.` : expectedWorker ? `Worker account ready · ${short}` : `Connected · ${short}. Read the project terms to check your role.`;
  const recorded=journal.list({network:'testnetBradbury'}).some(e=>e.functionName==='submit_once' && e.project?.toLowerCase()===$('project').value.trim().toLowerCase() && e.enrollment?.role==='worker' && !['not-sent','abandoned'].includes(e.phase) && (e.phase!=='done' || e.verdict?.ok));
  if(!actionBusy)$('submit').textContent=recorded?'Submission recorded · use Check status':'Submit evidence + authorize · one transaction';
  $('submit').disabled=recorded || busy || actionBusy || !account || !expectedWorker || account.toLowerCase()!==expectedWorker.toLowerCase() || !workerPreview || !$('worker-accept').checked || !writeHealth.ok;
  $('create').disabled=busy || actionBusy || !account || !prepared || !$('terms').checked || !writeHealth.ok;
  $('preview').disabled=busy || actionBusy || !writeHealth.ok;
  $('load-project').disabled=busy || actionBusy;
}

const localHost=['127.0.0.1','localhost','[::1]'].includes(window.location.hostname);
const api = (import.meta.env.VITE_AUTOMATION_URL || (localHost?'http://127.0.0.1:8790':'/api')).replace(/\/$/,'');
const readClient = createClient({chain});
const storage = browserStorage();
const journal = createJournal(storage);
const consensus = chain.consensusMainContract;
const tracking = mountProjectTracking({root:$('project-tracking'),journal,storage,client:readClient,api,onRefresh:()=>{if(busy || actionBusy)throw new Error('Finish the current wallet or form action first.');return refresh();},onSelect:address=>{
  if(busy || actionBusy){message('Finish the current action before changing project.');return;}
  $('project').value=address;invalidateWorker();
  showPanel('worker');
  $('worker-form').scrollIntoView({behavior:'smooth'});
  runAction('load-project',loadProject);
}});
tracking.update(journal.list({network:'testnetBradbury'}));
let account, guard, client, prepared, code, workerPreview, busy=false, refreshing=false,actionBusy=false,connecting=false;
let workerReadRevision=0,formRevision=0;
const simpleForms=mountSimpleForms(document);
let writeHealth=journal.health();
const wallet=createWalletSession({provider:window.ethereum,storage,ensureNetwork:ensureBradbury,onChange:value=>{
  account=value;guard=value?createGuardedProvider({provider:window.ethereum,chainId:4221,consensus}):null;
  client=value?createClient({chain,account:value,provider:guard}):null;
  prepared=null;simpleForms.clearPreview();formRevision++;$('worker-accept').checked=false;workerWalletStatus();
}});
function assertWallet(identity) {
  if(!identity.account || account?.toLowerCase()!==identity.account.toLowerCase() || wallet.revision!==identity.revision)throw new Error('Wallet account or network changed during preparation. Review the form again; nothing was sent.');
}
const identity=()=>({account,revision:wallet.revision});
function invalidateWorker(){workerReadRevision++;workerPreview=null;expectedWorker=null;$('worker-summary').replaceChildren();$('worker-terms').textContent='';$('worker-accept').checked=false;workerWalletStatus();}

const text = x => JSON.stringify(x,(_k,v)=>typeof v==='bigint'?v.toString():v,2);
const message = value => {for(const id of ['message','worker-message','client-message'])$(id).textContent=value;};
async function fetchJson(url,options={}) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`Background service HTTP ${response.status}.`);
  return response.json();
}
async function info(requireSending=false) {
  const i = await fetchJson(`${api}/v1/info`);
  if (i.chainId!==4221 || !i.oneTransactionEnrollment) throw new Error('Start the matching one-transaction service first.');
  $('service').textContent=i.sendingEnabled ? `Background service online · ${i.mailTransport==='smtp'?'Email delivery configured':'Email delivery not configured'}` : 'Tracking only: the service has no active sender. Configure its dedicated operator before testing automatic continuation.';
  if (requireSending && !i.sendingEnabled) throw new Error('The operator is in tracking-only mode. Enable and fund its dedicated account first; otherwise later steps cannot be automatic.');
  return i;
}
async function connect(passive=false,select=false) {
  if(connecting){if(passive)return null;throw new Error('A MetaMask account request is already open.');}
  connecting=true;workerWalletStatus();
  try {
    const connected=await wallet.connect({passive,select});
    if(!connected && !passive)throw new Error('Wallet not connected. Choose an account and retry.');
    if(connected && !passive)message('Connected to Bradbury (4221).');
    return connected;
  } finally {connecting=false;workerWalletStatus();}
}
async function toggleWallet(select=false){
  if(busy || actionBusy)throw new Error('Finish the current action first.');
  if(account){wallet.disconnect();message('Wallet disconnected from this app. Project tracking and the background service continue.');}
  else await connect(false,select);
}
async function runAction(id,fn) {
  if(actionBusy || busy){message('An action is already in progress.');return;}
  actionBusy=true;workerWalletStatus();
  const button=$(id),label=button.textContent;button.textContent='Please wait…';
  try{await fn();}catch(error){message(error.shortMessage || error.message || 'Action failed.');}
  finally{actionBusy=false;button.textContent=label;workerWalletStatus();}
}

const form = () => ({worker:$('worker').value,email:$('client-email').value,allowedSources:$('sources').value,milestones:JSON.parse($('milestones').value),renderMode:'text',maxRevisions:1,recoveryHours:$('recovery-hours').value.trim(),registry:'',continueAfterRefund:false});
const formKey=()=>text(form());
async function preview() {
  message('Checking wallet and background service…');
  if (!account) await connect();
  const who=identity();const revision=formRevision;const snapshot=formKey();
  await info(true);
  assertWallet(who);
  if (!$('terms').checked) throw new Error('Accept the one-review project terms before previewing.');
  message('Checking the pinned contract artifact…');
  code=await loadArtifact({artifact:ONE_TX_ARTIFACT});
  const f=form();
  message('Reading chain time and estimating gas; nothing is being sent…');
  const candidate=await boundedRead(prepareOneTx(f,code,{chain,account:who.account,readClient}),30000);
  assertWallet(who);
  if(revision!==formRevision || snapshot!==formKey())throw new Error('Project terms changed during estimation. Preview the current form again.');
  prepared={...candidate,formKey:snapshot,account:who.account};
  $('preview-result').textContent=text({principalWei:prepared.value,gasLimit:prepared.gas,worker:f.worker,reviewAttemptsPerMilestone:1,automationExpires:new Date(prepared.expires*1000).toISOString(),clientScopes:'review and recover',evidenceRecovery:prepared.recovery.label,evidenceRecoverySeconds:prepared.recovery.seconds,network:'Bradbury 4221',emailCommitment:prepared.args.at(-1),emailCommitmentSalted:true,milestones:prepared.verified.milestones});
  simpleForms.showPreview(prepared,f);
  $('create').disabled=false;
  $('message').textContent='Preview ready. No transaction has been sent.';
}
async function send(request,who) {
  assertWallet(who);
  await info(true);
  assertWallet(who);
  if (busy) throw new Error('A wallet action is already open.');
  const pending=journal.list({network:'testnetBradbury',account}).find(e=>e.enrollment?.role===request.enrollment.role && !['done','not-sent'].includes(e.phase) && (request.kind==='deploy' || e.project?.toLowerCase()===request.project?.toLowerCase()));
  if(pending) throw new Error('Your original transaction is still tracked. It will not be sent again; see Background progress.');
  busy=true;workerWalletStatus();
  try {
    const e=await sendTracked({...request,chainId:4221,network:'testnetBradbury',account},{client,guard,journal,readClient,consensus,polls:1,sdkGraceMs:0,onUpdate:e=>{ $('progress').textContent=text(e); }});
    if(e.persistError)throw new Error(`Transaction sent: ${e.evmHash}. Its local record could not be saved. Keep this page open and preserve this hash. ${e.persistError}`);
    if(e.verdict?.final && !e.verdict.ok)throw new Error(`Transaction finalized without successful execution: ${e.verdict.label}. Inspect its receipt before retrying.`);
    const enrolled=await boundedRead(enrollEntry(e,{journal,api}),15000);
    if(!enrolled?.enrollmentRecorded)throw new Error(`Transaction ${e.evmHash} is saved locally but background tracking is not recorded yet. Use Check status; do not resend.`);
    showPanel('tracking');
    message('Background tracking recorded. You can close the browser; the online service will continue after finality. Confirm your email using its verification message.');
  } finally {busy=false;workerWalletStatus();await refresh().catch(e=>message(`Transaction tracking needs a retry: ${e.message}. Use Check status; do not resend.`));}
}
async function create() {
  if (!prepared || prepared.formKey!==formKey() || prepared.account!==account || !$('terms').checked) throw new Error('Preview these exact terms first.');
  // Re-estimate fresh, so the value, gas and validUntil shown at the wallet
  // boundary come from the same new request; never fallback to an unfunded deploy.
  const who=identity(),key=formKey(),revision=formRevision;
  const f=form();const p=await boundedRead(prepareOneTx(f,code,{chain,account:who.account,readClient,emailSalt:prepared.emailSalt}),30000);
  assertWallet(who);
  if(key!==formKey() || revision!==formRevision || !$('terms').checked)throw new Error('Terms changed before sending. Preview them again.');
  await send({kind:'deploy',label:'Create, fund and authorize',code,constructorArgs:p.args,value:p.value,minGas:p.gas,maxGas:16777216n,fundedDeploy:p.call,expectedRecoverySeconds:p.recovery.seconds,assertCurrent:()=>{assertWallet(who);if(key!==formKey() || revision!==formRevision || !$('terms').checked)throw new Error('Project terms changed. Preview them again; nothing was sent.');},enrollment:{role:'client',email:f.email.trim().toLowerCase(),emailSalt:p.emailSalt}},who);
  $('create').disabled=true;prepared=null;
}
async function loadProject() {
  invalidateWorker();const revision=workerReadRevision;
  const project=$('project').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(project)) throw new Error('Enter the new project address.');
  const read=(functionName,args=[])=>boundedRead(readClient.readContract({address:project,functionName,args,transactionHashVariant:'latest-final'}));
  const [parties,auth,recoverySeconds]=await Promise.all([read('parties'),read('get_one_tx_authorizations'),read('get_evidence_recovery_seconds')]);
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
  if(revision!==workerReadRevision || project.toLowerCase()!==$('project').value.trim().toLowerCase())return;
  if(parties.project_status!=='ACTIVE' || Number(auth.deliveries_committed)!==0)throw new Error('This project is not awaiting its first worker submission. Check its current status.');
  expectedWorker=parties.worker;
  workerWalletStatus();
  $('worker-summary').replaceChildren();
  const recoveryNote=document.createElement('p');recoveryNote.textContent=`Evidence recovery window: ${recoveryLabel(recoverySeconds)}. Fixed by the client at creation.`;$('worker-summary').append(recoveryNote);
  for(const m of milestones) {
    const card=document.createElement('div');card.className='milestone-card';
    const title=document.createElement('h3');title.textContent=`Milestone ${m.index+1} · ${m.amountWei} wei`;
    const spec=document.createElement('p');spec.textContent=m.spec;
    card.append(title,spec);$('worker-summary').append(card);
  }
  simpleForms.setDeliveries(milestones,project.toLowerCase());
  workerPreview=project.toLowerCase();
  message('Project terms loaded. Connect the assigned worker, accept the terms and submit your evidence once.');
  $('worker-terms').textContent=text({parties,milestones,reviewAttemptsPerMilestone:1,evidenceRecovery:recoveryLabel(recoverySeconds),evidenceRecoverySeconds:String(recoverySeconds),technicalAuthorizationDays:30});
  $('worker-accept').checked=false;workerWalletStatus();
}
async function submit() {
  if (!account) await connect();
  const project=$('project').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(project)) throw new Error('Enter the new project address.');
  if(workerPreview!==project.toLowerCase() || !$('worker-accept').checked) throw new Error('Read this project and accept its terms first.');
  if(account.toLowerCase()!==expectedWorker?.toLowerCase()) throw new Error(`Select the assigned worker ${expectedWorker} in MetaMask, then click Connect worker wallet.`);
  const email=$('worker-email').value.trim().toLowerCase();
  const who=identity(),termsRevision=workerReadRevision,deliveryText=$('deliveries').value;
  const p=await boundedRead(prepareWorker({readClient,project,account:who.account,email,deliveries:JSON.parse(deliveryText)}),30000);
  assertWallet(who);
  if(termsRevision!==workerReadRevision || project!==$('project').value.trim() || email!==$('worker-email').value.trim().toLowerCase() || deliveryText!==$('deliveries').value || !$('worker-accept').checked)throw new Error('Delivery form changed during preparation. Review it and submit again; nothing was sent.');
  await send({kind:'call',label:'Submit all evidence and authorize',project,functionName:'submit_once',args:p.args,value:0n,maxGas:3000000n,assertCurrent:()=>{assertWallet(who);if(termsRevision!==workerReadRevision || project!==$('project').value.trim() || deliveryText!==$('deliveries').value || email!==$('worker-email').value.trim().toLowerCase() || !$('worker-accept').checked)throw new Error('Delivery terms changed before the wallet prompt. Nothing was sent.');},enrollment:{role:'worker',email,emailSalt:p.emailSalt}},who);
}
async function refresh() {
  if (refreshing || busy) return;refreshing=true;
  try {
    const entries=journal.list({network:'testnetBradbury'}).filter(e=>e.enrollment);
    const out=[],alerts=[];
    for(let e of entries) {
      try {
      if(e.phase==='prompting' && !e.forwarded) e=releaseIfNeverForwarded(e,{journal}).entry || e;
      if(e.phase==='prompting' && e.forwardedAt && !e.evmHash) {
        const result=await boundedRead(checkPossiblySent(e,{readClient,consensus,journal}));
        e=result.entry;
      }
      if(e.evmHash && e.phase!=='done') e=await boundedRead(advance(e,{readClient,consensus,journal,polls:1}));
      e=await verifyRecoveryWindow(e,{readClient:{readContract:a=>boundedRead(readClient.readContract(a),15000)},journal});
      const recoveryWindowCheck=recoveryCheckText(e);
      if(['mismatch','read-error'].includes(e.recoveryCheck?.state))alerts.push(recoveryWindowCheck);
      if(e.evmHash) {
        try { e=await boundedRead(enrollEntry(e,{journal,api}),15000); } catch(error){ e={...e,enrollmentError:error.message}; }
      }
      let background=null;
      if(e.enrollmentRecorded) background=await fetchJson(`${api}/v1/one-tx-watches/${e.evmHash}`).catch(()=>({state:'service offline'}));
      const project=e.createdAddress || (e.project!=='deploy'?e.project:null);
      const window=e.txId && !e.verdict?.final ? await boundedRead(readFinalityWindow(readClient,e.txId)).catch(()=>({available:false})) : null;
      const jobs=project ? await fetchJson(`${api}/v1/projects/${project}`).catch(()=>null) : null;

      out.push({step:e.label,evmHash:e.evmHash,genLayerId:e.txId,project,consensus:e.verdict?.label || e.phase,estimatedWait:window?windowLabel(window):null,backgroundTracking:e.enrollmentRecorded?'recorded':'not yet recorded; keep page open',enrollmentError:e.enrollmentError,background,jobs:jobs?.jobs,possiblySent:e.possiblySent,recoveryWindow:recoveryWindowCheck});
      }catch(error){out.push({step:e.label,evmHash:e.evmHash,error:error.message,retry:'Use Check status; do not resend.'});}
    }
    if(out.length) $('progress').textContent=text(out);
    if(alerts.length) message(alerts.join('\n'));
  } finally{refreshing=false;tracking.update(journal.list({network:'testnetBradbury'}));await tracking.refresh();}
}
for(const [id,fn] of [['connect',()=>toggleWallet()],['worker-connect',()=>toggleWallet(true)]]) $(id).onclick=()=>fn().catch(e=>message(e.message));
for(const id of ['change-account','header-change-account']) $(id).onclick=()=>{if(!busy && !actionBusy)connect(false,true).catch(e=>message(e.message));};
for(const [id,fn] of [['preview',preview],['create',create],['load-project',loadProject],['submit',submit]]) $(id).onclick=()=>runAction(id,fn);
function showRecovery(){const r=recoveryWindow($('recovery-hours').value);$('aside-recovery').textContent=r.ok?r.label:'72–720 hours';$('recovery-hours').setAttribute('aria-invalid',String(!r.ok));}
$('recovery-hours').addEventListener('input',showRecovery);showRecovery();
for(const id of ['worker','sources','milestones','client-email','terms','recovery-hours']) $(id).addEventListener('input',()=>{formRevision++;prepared=null;simpleForms.clearPreview();workerWalletStatus();});
for(const id of ['worker-accept','worker-email','deliveries']) $(id).addEventListener('input',workerWalletStatus);
for(const event of ['accountsChanged','chainChanged','disconnect'])window.ethereum?.on?.(event,()=>{
  if(connecting && event!=='disconnect')return;
  wallet.invalidate();
  if(event==='disconnect'){message('Wallet connection lost. Reconnect when ready.');return;}
  if(!busy)connect(true).catch(e=>message(e.message));
});
window.addEventListener('beforeunload',e=>{if(busy || journal.list().some(x=>x.enrollment && x.evmHash && !x.enrollmentRecorded)){e.preventDefault();e.returnValue='';}});
info().catch(e=>message(e.message));
refresh().catch(e=>message(e.message));
// UI updates are manual. The background operator continues independently.

$('project').addEventListener('input',invalidateWorker);
workerWalletStatus();
if(!writeHealth.ok)message(writeHealth.error || writeHealth.reason || 'Browser journal unavailable. Writes are disabled; read-only tracking remains available.');

if(window.ethereum) connect(true).catch(e=>message(e.message));
