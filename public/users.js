const { api, current } = window.DefterSession;
const status = document.querySelector('#status');
async function refresh() {
  const result = await api('/api/auth/users');
  const employees = result.users.filter(user => user.id !== current().actor.id);
  document.querySelector('#disable select').replaceChildren(...employees.map(user => new Option(user.name, user.id)));
  document.querySelector('#disable').hidden = !employees.length;
}
for (const form of document.querySelectorAll('form')) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const disable = form.id === 'disable';
    if (disable && !confirm('Seçili çalışanın erişimi kapatılsın mı?')) return;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/auth/' + (disable ? 'disable' : 'employees'), data);
      form.reset();
      await refresh();
      status.textContent = disable ? 'Çalışanın erişimi kapatıldı.' : 'Çalışan hesabı oluşturuldu.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
refresh().catch(error => { status.textContent = error.message; });
