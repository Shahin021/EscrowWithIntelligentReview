import {readFinalityWindow} from './auto-tracker.js';
import {mountFinalityCountdown} from './finality-countdown.js';
/** Read-only project tracking. The journal supplies identifiers and submitted
 * terms; finalized contract reads and service receipts supply current status. */
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const lower = x => String(x || '').toLowerCase();
export function savedProjects(entries) {
  const groups = new Map();
  for (const e of entries.filter(e => e.enrollment)) {
    const address = e.createdAddress || (addressPattern.test(e.project || '') ? e.project : null);
    const key = address ? lower(address) : `deployment:${e.evmHash || e.id}`;
    let row = groups.get(key);
    if (!row) { row={key,address,entries:[],updatedAt:0};groups.set(key,row); }
    row.entries.push(e);row.updatedAt=Math.max(row.updatedAt,Number(e.updatedAt || e.createdAt || 0));
  }
  return [...groups.values()].map(row => {
    const deploy=row.entries.find(e=>e.kind==='deploy');
    let terms=null;
    if(deploy) {try {const a=deploy.args || [];terms={worker:a[0],milestones:JSON.parse(a[1]),allowedSources:a[2],principalWei:String(deploy.value ?? ''),reviewAttempts:a[4],authorizationExpiresAt:a[8]};}catch{/* unreadable journal terms never become invented terms */}}
    return {...row,id:(deploy || row.entries[0]).id,terms,title:terms?.milestones?.[0]?.spec || row.address || 'Deployment awaiting address'};
  }).sort((a,b)=>b.updatedAt-a.updatedAt);
}
/** Colors describe the checked state, not an inferred payment verdict. */
export function projectIndicator(row, observation) {
  const milestones=observation?.chain?.milestones || [];
  if(milestones.some(m=>['REJECTED_FINAL','REJECTED','REJECTED_PENDING_APPEAL'].includes(m.status)))return {tone:'rejected',label:'Evidence rejected'};
  if(milestones.some(m=>['EVIDENCE_UNAVAILABLE','REVIEW_STALLED'].includes(m.status)))return {tone:'problem',label:'Evidence needs attention'};
  const jobs=observation?.service?.jobs || [];
  if(observation?.readError || jobs.some(j=>j.lastError || ['failed','conflict'].includes(j.state)))return {tone:'problem',label:'Needs attention'};
  const entries=row.entries || [];
  if(entries.some(e=>e.phase==='done' && e.verdict?.ok===false))return {tone:'problem',label:'Transaction failed'};
  if(entries.some(e=>!['done','not-sent','abandoned'].includes(e.phase)) || jobs.some(j=>!j.terminal && !['done','failed'].includes(j.state)))return {tone:'pending',label:'Awaiting confirmation'};
  if(milestones.length && milestones.every(m=>m.status==='RELEASED'))return {tone:'success',label:'Payment released'};
  if(milestones.length && milestones.every(m=>m.status==='REFUNDED'))return {tone:'problem',label:'Refunded'};
  if(milestones.some(m=>m.status==='APPROVED'))return {tone:'success',label:'Evidence approved'};
  if(milestones.some(m=>['UNDER_REVIEW','UNDER_APPEAL','REFUND_PENDING','PAYMENT_PENDING'].includes(m.status)))return {tone:'pending',label:'Processing'};
  if(observation?.chain)return {tone:'neutral',label:observation.chain.parties.project_status==='ACTIVE'?'Ready for delivery':observation.chain.parties.project_status};
  if(entries.length && entries.every(e=>e.phase==='done' && e.verdict?.ok===true))return {tone:'neutral',label:'Transactions confirmed · check project'};
  return {tone:'neutral',label:'Not checked'};
}
export async function readTrackedProject(client,address) {
  if(!addressPattern.test(address || ''))throw new Error('Enter a valid project address.');
  const read=(functionName,args=[])=>client.readContract({address,functionName,args,transactionHashVariant:'latest-final'});
  const [parties,accounting]=await Promise.all([read('parties'),read('get_accounting')]);
  if(parties.interface_id!=='genlayer.milestone-escrow.v2')throw new Error('Unsupported escrow interface.');
  const count=Number(parties.milestone_count);
  if(!Number.isInteger(count)||count<1||count>10)throw new Error('Unexpected milestone count.');
  const milestones=await Promise.all(Array.from({length:count},async(_,i)=>{
    const [status,amount,spec]=await Promise.all([read('get_milestone_status',[i]),read('get_milestone_amount',[i]),read('get_milestone_spec',[i])]);
    return {index:i,status,amountWei:String(amount),spec};
  }));
  const [balance,authorization]=await Promise.all([
    client.getBalance({address}).then(String).catch(()=>null),
    read('get_one_tx_authorizations').catch(()=>null),
  ]);
  return {parties,accounting,milestones,balance,authorization};
}
export async function boundedRead(promise,ms=20000) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Read timed out; automatic tracking will retry.')),ms);})]);}
  finally{clearTimeout(timer);}
}
export function mountProjectTracking({root,journal,storage,client,api,onSelect=()=>{},onRefresh=null,fetchImpl=fetch}) {
  const doc=root.ownerDocument;
  const node=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const title=node('div');title.className='project-heading';const projectCount=node('span','0 saved');projectCount.className='project-count';title.append(node('h2','My projects'),projectCount);
  const note=node('p','Follow saved projects from this browser. Use Check status for the latest state; tracking never opens your wallet.');
  const list=node('div');list.className='project-list';const detail=node('div');detail.className='project-detail';
  const manualLabel=node('label','Track another project address (read only)');const manual=node('input');manual.placeholder='0x…';
  const open=node('button','Track address');const refresh=node('button','Check status');
  const status=node('p');status.setAttribute('role','status');
  const lookup=node('details');lookup.className='project-lookup-details';lookup.append(node('summary','Track a different address'),manualLabel,manual,open);const toolbar=node('div');toolbar.className='project-toolbar';toolbar.append(refresh,status);root.replaceChildren(title,note,list,lookup,toolbar,detail);
  const observations=new Map();
  let countdowns=[],clockTargets=[];
  const stopClocks=()=>{for(const stop of countdowns)stop();countdowns=[];clockTargets=[];};
  function clockLine(txId){
    if(!/^0x[0-9a-fA-F]{64}$/.test(txId || ''))return null;
    const line=node('p','Reading network finalization window…');line.className='finality-countdown';clockTargets.push({line,txId});return line;
  }
  async function fillClocks(current,address){
    const reads=new Map();
    await Promise.all(clockTargets.map(async({line,txId})=>{
      if(!reads.has(txId))reads.set(txId,boundedRead(readFinalityWindow(client,txId)).catch(()=>({available:false})));
      const window=await reads.get(txId);
      if(current!==revision || lower(chosen()?.address)!==lower(address) || !line.isConnected)return;
      countdowns.push(mountFinalityCountdown(line,window));
    }));
  }
  let selected=storage.readJson('escrow-one-tx:selected-project',null);let rows=[];let revision=0;let loading=false;let dirty=false;
  const save=()=>storage.writeJson('escrow-one-tx:selected-project',selected);
  const chosen=()=>rows.find(r=>r.id===selected?.id) || (selected?.address?{address:selected.address,id:null,entries:[],terms:null,title:selected.address}:null);
  const link=(text,hash,evm=false)=>{
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash || ''))return node('span',`${text}: not available yet`);
    const a=node('a',text);a.href=`${evm?'https://zksync-os-testnet-genlayer.explorer.zksync.dev':'https://explorer-bradbury.genlayer.com'}/tx/${hash}`;a.target='_blank';a.rel='noopener noreferrer';return a;
  };
  function draw() {
    list.replaceChildren();
    projectCount.textContent=`${rows.length} saved`;
    if(!rows.length){const empty=node('div');empty.className='empty-state';empty.append(node('h3','Your next agreement starts here'),node('p','Create a funded project, or track an existing contract using its address. Projects submitted from this browser will appear here.'));const start=node('button','Create your first project →');start.onclick=()=>doc.querySelector('[data-tab=client]')?.click();empty.append(start);list.append(empty);}
    for(const row of rows){
      const indicator=projectIndicator(row,observations.get(lower(row.address)));
      const b=node('button');const state=node('span',`${row.id===selected?.id?'Selected · ':''}${indicator.label}`);state.className='choice-state';const caption=node('span',String(row.title).slice(0,90));caption.className='choice-title';const address=node('span',row.address?`${row.address.slice(0,8)}…${row.address.slice(-6)}`:'Deployment pending');address.className='choice-address';b.append(state,caption,address);
      b.className=`project-choice status-${indicator.tone}`;b.setAttribute('aria-pressed',String(row.id===selected?.id));
      b.style.display='block';b.style.width='100%';b.style.textAlign='left';b.style.overflowWrap='anywhere';
      b.onclick=()=>{selected={id:row.id,address:row.address};save();draw();showSaved(row);load();};list.append(b);
    }
  }
  function showSaved(row) {
    stopClocks();
    detail.replaceChildren();
    detail.append(node('h3',row.address || 'Deployment — waiting for a project address'));
    if(row.address){const copy=node('button','Copy contract address');copy.className='copy-action';copy.onclick=()=>globalThis.navigator?.clipboard?.writeText(row.address).catch(()=>{status.textContent=row.address;});detail.append(copy);}
    for(const e of row.entries){
      const line=node('p',`${e.enrollment.role} · ${e.account} · ${e.verdict?.label || e.lastStatus || (e.possiblySent?'Possibly sent — not resending':e.phase)}`);
      line.className='receipt-line';line.append(node('br'),link('EVM receipt',e.evmHash),node('span',' · '),link('GenLayer receipt',e.txId));detail.append(line);
      if(!e.verdict?.final){const clock=clockLine(e.txId);if(clock)detail.append(clock);}
      if(e.functionName==='submit_once') {
        try {const evidence=JSON.parse(e.args[0]);const d=node('details');d.append(node('summary','Submitted worker evidence — saved in this browser'),node('pre',JSON.stringify(evidence,null,2)));detail.append(d);}catch{/* keep the receipt even if saved evidence is unreadable */}
      }
    }
    if(row.terms){const d=node('details');d.append(node('summary','Original submitted form — saved in this browser'),node('pre',JSON.stringify(row.terms,null,2)));detail.append(d);}
  }
  async function load() {
    if(loading){dirty=true;return;}loading=true;const current=++revision;const row=chosen();
    try {
      if(!row){status.textContent='Select a saved project, or paste its address.';detail.replaceChildren();return;}
      status.textContent='Checking finalized state and the background service…';
      if(!row.address){showSaved(row);status.textContent='The transaction is saved. Its contract address has not been recovered yet; automatic tracking continues.';return;}
      const [chainResult,serviceResult]=await Promise.allSettled([
        boundedRead(readTrackedProject(client,row.address)),
        boundedRead(fetchImpl(`${api}/v1/projects/${row.address}`).then(async r=>{if(!r.ok)throw new Error(`Service HTTP ${r.status}`);return r.json();})),
      ]);
      if(current!==revision || chosen()?.address?.toLowerCase()!==row.address.toLowerCase())return;
      observations.set(lower(row.address),{chain:chainResult.status==='fulfilled'?chainResult.value:null,service:serviceResult.status==='fulfilled'?serviceResult.value:null,readError:chainResult.status==='rejected' || serviceResult.status==='rejected'});
      draw();
      showSaved(row);
      if(chainResult.status==='fulfilled'){
        const s=chainResult.value;
        const jobs=serviceResult.status==='fulfilled'?(serviceResult.value.jobs || []):[];
        if(s.parties.project_status==='CLOSED' && jobs.some(j=>j.step==='close_project' && j.state==='done') && jobs.every(j=>j.state==='done')){const banner=node('div');banner.className='completion-banner';banner.append(node('h3','Project complete'),node('p','The project is closed. Every recorded background step finalized with successful execution.'));detail.append(banner);}
        detail.append(node('h3',`Finalized project state: ${s.parties.project_status}`));
        const metrics=node('div');metrics.className='metrics';
        for(const [label,value] of [['Funded',s.parties.total_funded],['Locked',s.accounting.locked],['Released',s.parties.total_released],['Refunded',s.parties.total_refunded]]){const card=node('div');card.className='metric';card.append(node('span',label),node('strong',`${value ?? 'Unavailable'}${value==null?'':' wei'}`));metrics.append(card);}detail.append(metrics);
        const ledger=node('details');ledger.append(node('summary','Full accounting'),node('pre',JSON.stringify({requiredWei:s.parties.total_required,fundedWei:s.parties.total_funded,releasedWei:s.parties.total_released,refundedWei:s.parties.total_refunded,lockedWei:s.accounting.locked,depositCreditWei:s.accounting.deposit_credit_held,queuedWei:s.accounting.queued_out,inflightWei:s.accounting.inflight_out,nativeBalanceWei:s.balance},null,2)));detail.append(ledger);
        for(const m of s.milestones){const card=node('div');card.className='milestone-card';card.append(node('h3',`Milestone ${m.index+1} · ${m.status} · ${m.amountWei} wei`),node('p',m.spec));detail.append(card);}
        const worker=node('button','Continue to delivery →');worker.className='worker-callout';
        worker.disabled=s.parties.project_status!=='ACTIVE' || s.authorization?.interface!=='genlayer.escrow-one-tx.v1' || Number(s.authorization.deliveries_committed)!==0;
        worker.hidden=worker.disabled;
        worker.onclick=()=>{onSelect(row.address);status.textContent='Worker form selected. Switch to the worker wallet, read its terms and submit once.';};detail.append(worker);if(!worker.disabled)detail.append(node('p','Open the delivery form, choose the assigned worker account and submit once.'));
        status.textContent='Finalized state checked. Click Check status whenever you want an update.';
      } else {
        status.textContent=`Finalized state unavailable: ${String(chainResult.reason?.shortMessage || chainResult.reason?.message || chainResult.reason).slice(0,280)}. This is not a success or failure verdict; tracking will retry.`;
      }
      if(serviceResult.status==='fulfilled') {
        const s=serviceResult.value;detail.append(node('h3','Background service'));
        detail.append(node('p',s.sendingEnabled?`Operator enabled · ${s.operator}`:'Operator is tracking only; automatic sends are disabled.'));
        for(const c of s.consents || []) detail.append(node('p',`${c.role} authorization · ${c.active?'active':'inactive'} · email ${c.emailVerified?'verified':'not verified'}`));
        if(!(s.jobs || []).length)detail.append(node('p','No technical jobs recorded yet. Deployment enrollment or the worker submission may still be pending.'));
        for(const job of s.jobs || []){
          const line=node('p',`${job.step} · ${job.status || job.state}${job.eta?' · '+job.eta:''}${job.lastError?' · '+job.lastError:''}`);
          line.className='job-line';
          if(job.glTxId)line.append(node('span',' · '),link('Receipt',job.glTxId));detail.append(line);
          if(job.glTxId && !job.terminal && !['done','failed'].includes(job.state)){const clock=clockLine(job.glTxId);if(clock)detail.append(clock);}
        }
      } else detail.append(node('p',`Background service unavailable: ${serviceResult.reason.message}. On-chain state is displayed independently.`));
      await fillClocks(current,row.address);
    } finally{loading=false;if(dirty){dirty=false;load();}}
  }
  open.onclick=()=>{const address=manual.value.trim();if(!addressPattern.test(address)){status.textContent='Enter a valid 20-byte 0x project address.';return;}const saved=rows.find(r=>lower(r.address)===lower(address));selected={id:saved?.id || null,address};save();draw();showSaved(chosen());load();};
  refresh.onclick=async()=>{refresh.disabled=true;status.textContent='Checking latest transaction and project status…';try{await (onRefresh ? onRefresh() : load());}catch(error){status.textContent=`Status check failed: ${error.message}. Click Check status to retry.`;}finally{refresh.disabled=false;}};
  return {
    update(entries){rows=savedProjects(entries);if(!selected && rows.length){selected={id:rows[0].id,address:rows[0].address};save();}const row=rows.find(r=>r.id===selected?.id);if(row && row.address!==selected.address){selected={id:row.id,address:row.address};save();}draw();},
    refresh:load,
  };
}
