/** Local display clock only: no polling, wallet access or transaction sending. */
export function countdownLabel(window,elapsedSeconds=0) {
  if(!window?.available)return 'Network timing unavailable. Use Check status to retry.';
  const deadline=Number(window.deadline),current=Number(window.current);
  if(!Number.isSafeInteger(deadline)||!Number.isSafeInteger(current)||deadline<=0)return 'Consensus in progress; the network has not set a finalization deadline yet.';
  const remaining=Math.max(0,deadline-current-Math.floor(Math.max(0,elapsedSeconds)));
  if(!remaining)return 'Network window elapsed; awaiting FINALIZED. Use Check status. This is not a success confirmation.';
  const hours=Math.floor(remaining/3600),minutes=Math.floor(remaining%3600/60),seconds=remaining%60;
  const end=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(deadline*1000));
  return `Network window: ${hours?hours+'h ':''}${minutes}m ${String(seconds).padStart(2,'0')}s remaining · ends ${end} Istanbul. Based on the last chain check; finalization may follow later.`;
}
export function mountFinalityCountdown(element,window,{now=()=>globalThis.performance?.now?.() ?? Date.now(),schedule=setTimeout,cancel=clearTimeout}={}) {
  let stopped=false,timer=null;const started=now();
  const tick=()=>{
    if(stopped)return;
    element.textContent=countdownLabel(window,(now()-started)/1000);
    const remaining=Number(window?.deadline)-Number(window?.current)-(now()-started)/1000;
    if(window?.available && remaining>0){timer=schedule(tick,1000);timer?.unref?.();}
  };
  tick();
  return ()=>{stopped=true;if(timer!==null)cancel(timer);};
}
