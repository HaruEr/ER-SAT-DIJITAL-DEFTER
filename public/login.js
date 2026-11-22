const $ = id => document.getElementById(id);
const { api, store, current } = window.DefterSession;
let setup = false;
// First-run setup is a two-step wizard (GUI redesign Faz 5): 1) owner name, 2) password.
// Same form, same fields, same /api/auth/setup call; steps only show/hide existing fields.
let setupStep = 1;
let wizard = null;
const MIN_PASSWORD = 15;
if (sessionStorage.getItem('defter-restore-complete') === '1') {
  sessionStorage.removeItem('defter-restore-complete');
  $('feedback').textContent = 'Yedek doğrulanarak geri yüklendi. Devam etmek için yeniden giriş yapın.';
}
function buildWizard() {
  if (wizard) return wizard;
  const form = $('login');
  const passwordLabel = $('password').closest('label');
  const progress = document.createElement('div');
  progress.className = 'setup-progress';
  const count = document.createElement('span');
  count.className = 'setup-count';
  const track = document.createElement('span');
  track.className = 'setup-track';
  track.setAttribute('aria-hidden', 'true');
  track.append(document.createElement('i'));
  progress.append(count, track);
  form.prepend(progress);

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'button';
  next.id = 'setup-next';
  next.textContent = 'Devam et';
  $('name-label').after(next);

  const meter = document.createElement('div');
  meter.className = 'password-meter';
  const meterTrack = document.createElement('span');
  meterTrack.className = 'password-meter-track';
  meterTrack.setAttribute('aria-hidden', 'true');
  meterTrack.append(document.createElement('i'));
  const meterText = document.createElement('small');
  meterText.id = 'password-count';
  meter.append(meterTrack, meterText);
  passwordLabel.after(meter);

  const actions = document.createElement('div');
  actions.className = 'setup-actions';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'button secondary';
  back.id = 'setup-back';
  back.textContent = 'Geri';
  $('submit').before(actions);
  actions.append(back, $('submit'));

  next.addEventListener('click', () => goToStep(2));
  // Enter in the name field: the hidden (required, still empty) password would make the browser
  // reject the submit before our handler runs, so step forward here instead.
  $('name').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !setup || setupStep !== 1 || event.isComposing) return;
    event.preventDefault();
    if ($('password').value) form.requestSubmit(); else goToStep(2);
  });
  back.addEventListener('click', () => goToStep(1));
  $('password').addEventListener('input', updateMeter);
  wizard = { progress, count, next, back, meter, meterText, passwordLabel };
  return wizard;
}
function updateMeter() {
  if (!wizard) return;
  const length = $('password').value.length;
  const ratio = Math.min(1, length / MIN_PASSWORD);
  wizard.meter.style.setProperty('--password-progress', String(ratio));
  wizard.meter.classList.toggle('is-complete', length >= MIN_PASSWORD);
  wizard.meterText.textContent = length >= MIN_PASSWORD ? `${length} karakter · yeterli` : `${length} / ${MIN_PASSWORD} karakter`;
}
function applySetupStep(direction = '') {
  const form = $('login');
  if (!setup) {
    delete form.dataset.setupStep;
    delete form.dataset.setupDir;
    if (wizard) {
      wizard.progress.hidden = wizard.next.hidden = wizard.back.hidden = wizard.meter.hidden = true;
      wizard.passwordLabel.hidden = false;
      $('submit').hidden = false;
    }
    $('password').removeAttribute('minlength');
    $('password').removeAttribute('aria-describedby');
    return;
  }
  const w = buildWizard();
  form.dataset.setupStep = String(setupStep);
  if (direction) form.dataset.setupDir = direction; else delete form.dataset.setupDir;
  w.progress.hidden = false;
  w.count.textContent = `Adım ${setupStep} / 2 · ${setupStep === 1 ? 'İşletme sahibi' : 'Parola'}`;
  w.progress.style.setProperty('--setup-progress', String(setupStep / 2));
  $('name-label').hidden = setupStep !== 1;
  w.next.hidden = setupStep !== 1;
  w.passwordLabel.hidden = setupStep !== 2;
  w.meter.hidden = setupStep !== 2;
  w.back.hidden = setupStep !== 2;
  $('submit').hidden = setupStep !== 2;
  $('password').minLength = MIN_PASSWORD;
  $('password').setAttribute('aria-describedby', 'password-count');
  updateMeter();
}
function goToStep(step) {
  if (!setup || step === setupStep) return;
  if (step === 2 && !$('name').reportValidity()) return;
  const direction = step > setupStep ? 'forward' : 'back';
  setupStep = step;
  applySetupStep(direction);
  (step === 2 ? $('password') : $('name')).focus();
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
  applySetupStep();
  $('login').hidden = false;
  (setup ? (setupStep === 2 ? $('password') : $('name')) : $('user')).focus();
}
$('login').addEventListener('submit', async event => {
  event.preventDefault();
  // Enter in the name field moves to the password step. A password that is already filled
  // (password manager, automation) submits directly, exactly as before the wizard.
  if (setup && setupStep === 1 && !$('password').value) { goToStep(2); return; }
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
  } finally { $('password').value = ''; $('submit').disabled = false; updateMeter(); }
});
load().catch(error => { $('feedback').textContent = error.message; });
