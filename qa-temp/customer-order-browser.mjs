import assert from 'node:assert/strict';

// Called by the normal local editor browser fixture after owner login.
export async function verifyCustomerOrders({ evaluate, until, screenshot, viewport }) {
  await evaluate(`(async () => {
    const s = await DefterSession.api('/api/state');
    await DefterSession.api('/api/command', {id:'customer', revision:s.revision, command:{date:s.date,type:'account',name:'Sentetik sipariş müşterisi',unit:'TL',partyType:'customer',opening:'0'}});
    document.querySelector('#refresh').click();
  })()`);
  await until("document.body.getAttribute('aria-busy') === 'false'");
  await evaluate("document.querySelector('[data-view=accounts]').click();document.querySelector('[data-account-detail=\"cari-customer\"]').click()");
  await until("document.querySelector('[data-order-action=customerOrder]')");
  await evaluate("const f=document.querySelector('[data-order-action=customerOrder]');f.elements.description.value='Bir çeyrek altın';f.requestSubmit()");
  await until("document.querySelector('[data-order-action=orderAdvance]')");
  await evaluate("const deposit=document.querySelector('[data-order-action=orderAdvance]');deposit.elements.amountTL.value='50';deposit.elements.accountId.value='nakit';deposit.requestSubmit()");
  await until("document.querySelector('[data-order-action=orderRefund]')");
  await evaluate("document.querySelector('.customer-orders').scrollIntoView({block:'start'})");
  await screenshot('orders-1440.png');
  await viewport(390);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await evaluate("document.querySelector('.customer-orders').scrollIntoView({block:'start'})");
  await screenshot('orders-390.png');
  await evaluate("document.querySelector('[data-order-sale]').click()");
  await until("document.querySelector('[data-advance-id]')");
  await evaluate(`(() => {
    const set = (q,value,event) => {const el=document.querySelector(q); el.value=value; el.dispatchEvent(new Event(event,{bubbles:true}));};
    set('[data-item-field=accountId]','ceyrek','change');
    set('[data-item-field=quantity]','1','input');
    set('[data-item-field=value]','50','input');
    set('[data-advance-id]','50','input');
    document.querySelector('[data-view=accounts]').click();
    document.querySelector('[data-view=transaction]').click();
  })()`);
  await until("document.querySelector('[data-advance-id]')?.value === '50' && document.querySelector('#trade-order')?.value");
  await evaluate("document.querySelector('#sale-form').requestSubmit()");
  await until("DefterSession.api('/api/state').then(s => s.customerOrders?.[0]?.status === 'fulfilled')");
  const proof=await evaluate("DefterSession.api('/api/state?view=compact').then(s=>({cash:s.balances.nakit,stock:s.balances.ceyrek,revenue:s.overview.revenue,applied:s.customerOrders[0].advances[0].appliedTL}))");
  assert.deepEqual(proof,{cash:5000,stock:2,revenue:5000,applied:5000});
  await viewport(1440);
  console.log('Customer card order, 50 TL advance, full advance settlement on one 50 TL sale, zero second cash movement PASS');
}
