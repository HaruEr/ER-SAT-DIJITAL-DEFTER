const $ = id => document.getElementById(id);
const { api, store, current } = window.DefterSession;
let setup = false;
if (sessionStorage.getItem('defter-restore-complete') === '1') {
  sessionStorage.removeItem('defter-restore-complete');
  $('feedback').textContent = 'Yedek doğrulanarak geri yüklendi. Devam etmek için yeniden giriş yapın.';
}
async function load() {
  const data = await api('/api/auth/users');
  setup = data.setup;
  $('heading').textContent = setup ? 'İşletme sahibi hesabını oluştur' : 'Oturum aç';
  $('submit').textContent = setup ? 'Hesabı oluştur ve giriş yap' : 'Oturum aç';
  $('name-label').hidden = $('help').hidden = !setup;
  $('select-label').hidden = setup;
  $('name').required = setup;
  $('password').autocomplete = setup ? 'new-password' : 'current-password';
  $('user').replaceChildren(...data.users.map(user => new Option(user.name, user.id)));
  $('login').hidden = false;
  (setup ? $('name') : $('user')).focus();
}
$('login').addEventListener('submit', async event => {
  event.preventDefault();
  $('submit').disabled = true;
  $('feedback').textContent = '';
  try {
    if (current()) await api('/api/auth/logout', {}).catch(() => {});
    const session = await api('/api/auth/' + (setup ? 'setup' : 'login'), {
      id: $('user').value, name: $('name').value, password: $('password').value
    });
    store(session);
    location.replace(session.actor.role === 'owner' ? '/owner' : '/checkout');
  } catch (error) {
    $('feedback').textContent = error.message;
    await load().catch(() => {});
  } finally { $('password').value = ''; $('submit').disabled = false; }
});
load().catch(error => { $('feedback').textContent = error.message; });
