/** Ordinary inputs adapt to the existing validated request format. No chain calls. */
export function mountSimpleForms(doc) {
  const $=id=>doc.getElementById(id);
  const make=(tag,text)=>{const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const notify=e=>e.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true}));
  const milestones=$('milestones'),deliveries=$('deliveries');
  let formRows=[],deliveryRows=[],deliveryProject=null;
  function field(parent,title,value,{multiline=false,placeholder='',numeric=false}={}){
    const label=make('label',title),input=make(multiline?'textarea':'input');
    input.value=value ?? '';input.placeholder=placeholder;
    if(numeric)input.inputMode='numeric';
    label.append(input);parent.append(label);return input;
  }
  function saveMilestones(){milestones.value=JSON.stringify(formRows.map(r=>({spec:r.spec.value,amount:r.amount.value,deliveryDays:r.days.value})));notify(milestones);}
  function drawMilestones(values){
    const root=$('milestone-builder');if(!root)return;root.replaceChildren();formRows=[];
    for(const [i,value] of values.entries()){
      const card=make('div');card.className='milestone-editor';
      const heading=make('div');heading.className='editor-heading';heading.append(make('h4',`Milestone ${i+1}`));
      const remove=make('button','Remove');remove.type='button';remove.className='text-button';remove.disabled=values.length===1;
      remove.onclick=()=>{const next=readMilestones();next.splice(i,1);drawMilestones(next);saveMilestones();};heading.append(remove);card.append(heading);
      const spec=field(card,'What must be delivered?',value.spec,{multiline:true,placeholder:'Describe the deliverable and how it will be accepted.'});
      const row=make('div');row.className='row';card.append(row);
      const amount=field(row,'Amount · wei',value.amount,{numeric:true,placeholder:'1'});
      const days=field(row,'Delivery window · days',value.deliveryDays ?? '1',{numeric:true,placeholder:'1'});
      for(const input of [spec,amount,days])input.addEventListener('input',saveMilestones);
      formRows.push({spec,amount,days});root.append(card);
    }
    const add=make('button','+ Add milestone');add.type='button';add.className='button-quiet';add.disabled=values.length>=10;
    add.onclick=()=>{drawMilestones([...readMilestones(),{spec:'',amount:'1',deliveryDays:'1'}]);saveMilestones();};root.append(add);
  }
  const readMilestones=()=>formRows.map(r=>({spec:r.spec.value,amount:r.amount.value,deliveryDays:r.days.value}));
  try{drawMilestones(JSON.parse(milestones.value));}catch{drawMilestones([{spec:'',amount:'1',deliveryDays:'1'}]);}
  function saveDeliveries(){deliveries.value=JSON.stringify(deliveryRows.map(r=>({url:r.url.value.trim(),notes:r.notes.value})));notify(deliveries);}
  function setDeliveries(terms,project){
    const root=$('delivery-builder');if(!root)return;
    let previous=[];if(deliveryProject===project)try{previous=JSON.parse(deliveries.value);}catch{}
    deliveryProject=project;
    root.replaceChildren();deliveryRows=[];
    for(const [i,m] of terms.entries()){
      const card=make('div');card.className='milestone-editor';card.append(make('h4',`Milestone ${i+1} · evidence`));
      const url=field(card,'Immutable evidence URL',previous[i]?.url || '',{placeholder:'https://raw.githubusercontent.com/owner/repo/full-commit/file.txt'});
      url.type='url';url.spellcheck=false;
      const notes=field(card,'Notes · optional',previous[i]?.notes || '',{multiline:true,placeholder:'Context to help the reviewer. Maximum 500 characters.'});notes.maxLength=500;
      for(const input of [url,notes])input.addEventListener('input',saveDeliveries);
      deliveryRows.push({url,notes});root.append(card);
    }
    saveDeliveries();
  }
  $('delivery-builder')?.append(make('p','Read the project terms above to prepare its evidence fields.'));
  function showPreview(p,f){
    const root=$('preview-summary');if(!root)return;
    root.replaceChildren();root.hidden=false;root.append(make('h3','Ready for your review'));
    const grid=make('div');grid.className='preview-grid';
    for(const [label,value] of [['Total principal',`${p.value} wei`],['Gas limit',String(p.gas)],['Worker',f.worker],['Evidence recovery',p.recovery?.label || ''],['Network','Bradbury · 4221']]){
      const cell=make('div');cell.append(make('span',label),make('strong',value));grid.append(cell);
    }
    root.append(grid,make('p','No transaction has been sent. Verify the terms, amount and account before approving in your wallet.'));
  }
  return {setDeliveries,showPreview,clearPreview(){const root=$('preview-summary');if(root)root.hidden=true;}};
}
