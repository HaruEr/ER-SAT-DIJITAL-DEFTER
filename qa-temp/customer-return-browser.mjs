import assert from 'node:assert/strict';

export async function verifyReturnCredit({evaluate,until,screenshot,viewport}) {
  const netCredit = process.argv.includes('--net-credit');
  const value = netCredit ? '60' : '40', action = netCredit ? 'grantCredit' : 'reduceDebt';
  await evaluate(`(async()=>{
    const api=DefterSession.api, state=await api('/api/state');
    const send=(id,revision,command)=>api('/api/command',{id,revision,command:{date:state.date,...command}});
    await send('buyer',state.revision,{type:'account',name:'Sentetik iade müşterisi',opening:'0',unit:'TL',partyType:'customer'});
    await send('credit-sale',state.revision+1,{type:'sale',counterpartyType:'customer',counterpartyId:'cari-buyer',items:[{accountId:'ceyrek',quantity:'1',value:'100'}],received:[],given:[],credits:[{accountId:'cari-buyer',quantity:'100',valueTL:'100'}]});
    document.querySelector('#refresh').click();
  })()`);
  await until("document.body.getAttribute('aria-busy') === 'false'");
  await evaluate("document.querySelector('[data-view=journal]').click()");
  await until("document.querySelector('#return-form-credit-sale')");
  await evaluate(`(()=>{
    const f=document.querySelector('#return-form-credit-sale');
    f.closest('details').open=true;
    const set=(field,value)=>{field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));};
    set(f.querySelector('[data-return-quantity]'),'1');
    set(f.querySelector('[data-return-value]'),'${value}');
    f.elements.${action}Quantity.closest('details').open=true;
    set(f.elements.${action}Quantity,'${value}');
    set(f.elements.note,'Sentetik açık borçtan düşme');
    f.requestSubmit();
  })()`);
  await until("document.querySelector('#return-form-credit-sale [data-confirm-return]')");
  await evaluate("document.querySelector('[data-return-review]').scrollIntoView({block:'center'})");
  await screenshot('customer-return-1440.png');
  await viewport(390);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await evaluate("document.querySelector('[data-return-review]').scrollIntoView({block:'center'})");
  await screenshot('customer-return-390.png');
  await evaluate("document.querySelector('[data-confirm-return]').click()");
  await until("DefterSession.api('/api/state').then(s=>s.revision===4)");
  const proof=await evaluate("DefterSession.api('/api/state').then(s=>({stock:s.balances.ceyrek,cash:s.balances.nakit,claim:s.balances['cari-buyer'],action:s.journal.at(-1).meta.customerConsideration[0].action}))");
  assert.deepEqual(proof,{stock:2,cash:0,claim:netCredit?4000:6000,action});
  await viewport(1440);
  console.log(action+' of '+value+' TL leaves '+proof.claim/100+' TL net debt, zero cash change PASS');
}
