const $ = id => document.getElementById(id);
const { api, store, clear, updateActor, current } = window.DefterSession;
let setup = false;
let setupStep = 1;
let wizard = null;
const PIN_LENGTH = 6;

const digitsOnly = input => {
  if (!input) return;
  input.addEventListener('input', () => {
    const cleaned = input.value.replace(/\D+/g, '').slice(0, PIN_LENGTH);
    if (input.value !== cleaned) input.value = cleaned;
  });
};
[$('password'), $('pin-confirm'), $('force-current-pin'), $('force-new-pin'), $('force-confirm-pin')].forEach(digitsOnly);

if (sessionStorage.getItem('defter-restore-complete') === '1') {
  sessionStorage.removeItem('defter-restore-complete');
  $('feedback').textContent = 'Yedek doğrulanarak geri yüklendi. Devam etmek için yeniden giriş yapın.';
}

function buildWizard() {
  if (wizard) return wizard;
  const form = $('login');
  const pinLabel = $('pin-label');
  const confirmLabel = $('pin-confirm-label');
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
  confirmLabel.after(meter);

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
  $('name').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !setup || setupStep !== 1 || event.isComposing) return;
    event.preventDefault();
    if ($('password').value.length === PIN_LENGTH) form.requestSubmit(); else goToStep(2);
  });
  back.addEventListener('click', () => goToStep(1));
  $('password').addEventListener('input', updateMeter);
  wizard = { progress, count, next, back, meter, meterText, pinLabel, confirmLabel };
  return wizard;
}

function updateMeter() {
  if (!wizard) return;
  const length = $('password').value.length;
  const ratio = Math.min(1, length / PIN_LENGTH);
  wizard.meter.style.setProperty('--password-progress', String(ratio));
  wizard.meter.classList.toggle('is-complete', length === PIN_LENGTH);
  wizard.meterText.textContent = length === PIN_LENGTH ? `${length} / ${PIN_LENGTH} hane · hazır` : `${length} / ${PIN_LENGTH} hane`;
}

function applySetupStep(direction = '') {
  const form = $('login');
  if (!setup) {
    delete form.dataset.setupStep;
    delete form.dataset.setupDir;
    if (wizard) {
      wizard.progress.hidden = wizard.next.hidden = wizard.back.hidden = wizard.meter.hidden = true;
      wizard.pinLabel.hidden = false;
      $('submit').hidden = false;
    }
    $('pin-confirm-label').hidden = true;
    $('pin-confirm').required = false;
    $('password').removeAttribute('aria-describedby');
    return;
  }
  const w = buildWizard();
  form.dataset.setupStep = String(setupStep);
  if (direction) form.dataset.setupDir = direction; else delete form.dataset.setupDir;
  w.progress.hidden = false;
  w.count.textContent = `Adım ${setupStep} / 2 · ${setupStep === 1 ? 'İşletme sahibi' : 'Yönetici PIN'}`;
  w.progress.style.setProperty('--setup-progress', String(setupStep / 2));
  $('name-label').hidden = setupStep !== 1;
  w.next.hidden = setupStep !== 1;
  w.pinLabel.hidden = setupStep !== 2;
  w.confirmLabel.hidden = setupStep !== 2;
  $('pin-confirm').required = setupStep === 2;
  w.meter.hidden = setupStep !== 2;
  w.back.hidden = setupStep !== 2;
  $('submit').hidden = setupStep !== 2;
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

function showForcePinChange(actor, prefilledTempPin = '') {
  $('heading').textContent = 'Yeni 6 Haneli PIN Belirleyin';
  $('login').hidden = true;
  $('force-pin-change').hidden = false;
  $('force-pin-note').textContent = `${actor.name} · Geçici PIN ile giriş yaptınız. Devam etmeden önce kendi 6 haneli PIN kodunuzu belirleyin.`;
  $('force-current-pin').value = prefilledTempPin;
  $('force-new-pin').value = '';
  $('force-confirm-pin').value = '';
  (prefilledTempPin ? $('force-new-pin') : $('force-current-pin')).focus();
}

async function load() {
  const existing = current();
  if (existing && existing.expiresAt > Date.now() && existing.actor?.mustChangePin) {
    try {
      const actor = await api('/api/auth/session');
      if (actor?.mustChangePin) {
        updateActor(actor);
        showForcePinChange(actor);
        return;
      }
      if (actor) {
        updateActor(actor);
        location.replace(actor.role === 'owner' ? '/owner' : '/checkout');
        return;
      }
    } catch { clear(); }
  }
  const data = await api('/api/auth/users');
  setup = data.setup;
  $('force-pin-change').hidden = true;
  $('heading').textContent = setup ? 'İşletme sahibi hesabını oluştur' : 'Oturum aç';
  $('submit').textContent = setup ? 'Hesabı oluştur ve giriş yap' : 'Oturum aç';
  $('name-label').hidden = $('help').hidden = !setup;
  $('select-label').hidden = setup;
  $('name').required = setup;
  $('user').required = !setup;
  $('password').autocomplete = setup ? 'new-password' : 'current-password';
  applySetupStep();
  $('login').hidden = false;
  (setup ? (setupStep === 2 ? $('password') : $('name')) : $('user')).focus();
}

$('login').addEventListener('submit', async event => {
  event.preventDefault();
  if (setup && setupStep === 1 && !$('password').value) { goToStep(2); return; }
  const typedName = (setup ? $('name').value : $('user').value).trim();
  if (!typedName) {
    $('feedback').textContent = 'Kullanıcı adını girin.';
    (setup ? $('name') : $('user')).focus();
    return;
  }
  const pin = $('password').value.trim();
  if (!/^\d{6}$/.test(pin)) {
    $('feedback').textContent = 'PIN kodu tam 6 haneli rakamdan oluşmalı.';
    $('password').focus();
    return;
  }
  if (setup && $('pin-confirm').value.trim() && $('pin-confirm').value.trim() !== pin) {
    $('feedback').textContent = 'Girilen iki PIN kodu birbiriyle eşleşmiyor.';
    $('pin-confirm').focus();
    return;
  }
  $('submit').disabled = true;
  $('feedback').textContent = '';
  try {
    if (current()) await api('/api/auth/logout', {}).catch(() => {});
    const session = await api('/api/auth/' + (setup ? 'setup' : 'login'), {
      name: typedName, pin
    });
    store(session);
    if (session.actor?.mustChangePin) {
      showForcePinChange(session.actor, pin);
      return;
    }
    location.replace(session.actor.role === 'owner' ? '/owner' : '/checkout');
  } catch (error) {
    $('feedback').textContent = error.message;
    await load().catch(() => {});
  } finally {
    $('password').value = '';
    $('pin-confirm').value = '';
    $('submit').disabled = false;
    updateMeter();
  }
});

$('force-pin-change').addEventListener('submit', async event => {
  event.preventDefault();
  const currentPin = $('force-current-pin').value.trim();
  const newPin = $('force-new-pin').value.trim();
  const confirmPin = $('force-confirm-pin').value.trim();
  if (!/^\d{6}$/.test(currentPin) || !/^\d{6}$/.test(newPin)) {
    $('feedback').textContent = 'PIN kodları tam 6 haneli rakamdan oluşmalı.';
    return;
  }
  if (newPin !== confirmPin) {
    $('feedback').textContent = 'Yeni PIN ve tekrarı eşleşmiyor.';
    $('force-confirm-pin').focus();
    return;
  }
  if (newPin === currentPin) {
    $('feedback').textContent = 'Yeni PIN geçici PIN ile aynı olamaz.';
    $('force-new-pin').focus();
    return;
  }
  $('force-pin-submit').disabled = true;
  $('feedback').textContent = '';
  try {
    const res = await api('/api/auth/change-pin', { currentPin, newPin });
    updateActor(res.actor);
    location.replace(res.actor.role === 'owner' ? '/owner' : '/checkout');
  } catch (error) {
    $('feedback').textContent = error.message;
  } finally {
    $('force-pin-submit').disabled = false;
  }
});

$('force-pin-cancel').addEventListener('click', async () => {
  try { await api('/api/auth/logout', {}); } catch {}
  clear();
  $('feedback').textContent = '';
  await load().catch(error => { $('feedback').textContent = error.message; });
});

load().catch(error => { $('feedback').textContent = error.message; });
