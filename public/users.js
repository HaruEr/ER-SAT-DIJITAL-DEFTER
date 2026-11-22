const { api, current } = window.DefterSession;
const status = document.querySelector('#status');
// GUI redesign Faz 8: employees are listed as cards. Each card's "Erişimi kapat" drives the existing
// #disable form (same confirmation dialog, same /api/auth/disable call); the select form stays in
// the page for that purpose but is visually replaced by the list.
const disableForm = document.querySelector('#disable');
let disableTrigger = null;
let knownIds = null;
const section = document.createElement('section');
section.className = 'employee-section';
section.setAttribute('aria-labelledby', 'employee-list-title');
const sectionTitle = document.createElement('h2');
sectionTitle.id = 'employee-list-title';
sectionTitle.textContent = 'Çalışanlar';
const list = document.createElement('ul');
list.id = 'employee-list';
list.className = 'employee-list';
section.append(sectionTitle, list);
document.querySelector('#employee')?.before(section);
disableForm?.classList.add('is-list-backed');
function initials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toLocaleUpperCase('tr-TR') || '?';
}
function renderEmployees(employees) {
  const fresh = knownIds ? employees.filter(user => !knownIds.has(user.id)).map(user => user.id) : [];
  knownIds = new Set(employees.map(user => user.id));
  if (!employees.length) {
    const empty = document.createElement('li');
    empty.className = 'employee-empty';
    empty.textContent = 'Henüz çalışan hesabı yok. Aşağıdan ekleyebilirsiniz.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...employees.map(user => {
    const item = document.createElement('li');
    item.className = `employee-card${fresh.includes(user.id) ? ' is-new' : ''}`;
    item.dataset.employeeId = user.id;
    const avatar = document.createElement('span');
    avatar.className = 'employee-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = initials(user.name);
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = user.name;
    const role = document.createElement('small');
    role.textContent = 'Çalışan · tezgâh erişimi';
    text.append(name, role);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary compact';
    button.textContent = 'Erişimi kapat';
    button.setAttribute('aria-label', `${user.name} için erişimi kapat`);
    button.addEventListener('click', () => {
      disableTrigger = button;
      disableForm.querySelector('select').value = user.id;
      disableForm.requestSubmit();
    });
    item.append(avatar, text, button);
    return item;
  }));
}
async function refresh() {
  const result = await api('/api/auth/users');
  const employees = result.users.filter(user => user.id !== current().actor.id);
  document.querySelector('#disable select').replaceChildren(...employees.map(user => new Option(user.name, user.id)));
  document.querySelector('#disable').hidden = !employees.length;
  renderEmployees(employees);
}
for (const form of document.querySelectorAll('form')) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const disable = form.getAttribute('id') === 'disable';
    const trigger = disable ? (disableTrigger || form.querySelector('button')) : null;
    disableTrigger = null;
    if (disable) {
      const ok = window.DefterUI?.confirmCritical
        ? (await window.DefterUI.confirmCritical({
            title: 'Çalışan erişimini kapat',
            impactText: 'Seçili çalışanın aktif oturumları sonlandırılır ve yeni giriş yapamaz.',
            confirmLabel: 'Erişimi kapat',
            danger: true,
            trigger
          })).confirmed
        : confirm('Seçili çalışanın erişimi kapatılsın mı?');
      if (!ok) return;
    }
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/' + (disable ? 'disable' : 'employees'), data);
      if (disable) {
        const card = [...list.children].find(item => item.dataset.employeeId === String(data.id));
        if (card) window.DefterUI?.animateExit?.(card, 'toast');
      }
      form.reset();
      await refresh();
      const msg = disable ? 'Çalışanın erişimi kapatıldı.' : 'Çalışan hesabı oluşturuldu.';
      if (window.DefterUI?.toast) { window.DefterUI.toast(msg, { kind: 'success' }); status.textContent = ''; }
      else status.textContent = msg;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
window.addEventListener('popstate', () => {
  if (window.DefterUI?.getLayerCount?.() > 0) window.DefterUI.closeTopLayer('popstate');
});
if (current()) refresh().catch(error => { status.textContent = error.message; });
