const { api, current, updateActor } = window.DefterSession;
const status = document.querySelector('#status');
const disableForm = document.querySelector('#disable');
let disableTrigger = null;
let knownIds = null;

const notify = (msg, kind = 'success') => {
  if (window.DefterUI?.toast) { window.DefterUI.toast(msg, { kind }); status.textContent = ''; }
  else status.textContent = msg;
};

const bindDigitsOnly = root => {
  for (const input of root.querySelectorAll('.pin-input')) {
    input.addEventListener('input', () => {
      const cleaned = input.value.replace(/\D+/g, '').slice(0, 6);
      if (input.value !== cleaned) input.value = cleaned;
    });
  }
};
bindDigitsOnly(document);

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

function openPinModal({ title, subtitle, fields, submitLabel, onSubmit, trigger }) {
  const form = document.createElement('form');
  form.className = 'pin-modal-form';
  form.innerHTML =
    fields.map(f =>
      `<label><span>${f.label}</span><input name="${f.name}" class="pin-input" type="password" inputmode="numeric" required maxlength="6" pattern="[0-9]{6}" autocomplete="${f.autocomplete || 'new-password'}" placeholder="••••••"></label>`
    ).join('') +
    `<p role="alert" data-modal-error hidden></p>` +
    `<div class="form-actions"><button type="button" class="button secondary" data-modal-cancel>İptal</button><button type="submit" class="button">${submitLabel}</button></div>`;
  bindDigitsOnly(form);
  const errEl = form.querySelector('[data-modal-error]');
  const layer = window.DefterUI?.openModal?.({
    title,
    subtitle,
    content: form,
    size: 'sm',
    closeOnBackdrop: true,
    trigger
  });
  form.querySelector('[data-modal-cancel]')?.addEventListener('click', () => layer?.close?.('cancel'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    errEl.hidden = true;
    errEl.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await onSubmit(data);
      layer?.close?.('submit');
    } catch (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      notify(error.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  form.querySelector('input')?.focus();
}

function openResetEmployeePinModal(user, trigger) {
  openPinModal({
    title: 'Çalışan PIN Sıfırla',
    subtitle: `${user.name} · Yeni geçici 6 haneli PIN belirleyin`,
    fields: [
      { name: 'newPin', label: 'Yeni geçici 6 haneli PIN' },
      { name: 'confirmPin', label: 'Yeni geçici PIN (Tekrar)' }
    ],
    submitLabel: "PIN'i sıfırla",
    trigger,
    onSubmit: async ({ newPin, confirmPin }) => {
      if (!/^\d{6}$/.test(newPin)) throw new Error('PIN kodu tam 6 haneli rakamdan oluşmalı.');
      if (newPin !== confirmPin) throw new Error('Girilen iki PIN kodu birbiriyle eşleşmiyor.');
      await api('/api/auth/reset-pin', { id: user.id, newPin });
      notify(`${user.name} için geçici PIN tanımlandı; aktif oturumları kapatıldı.`, 'success');
    }
  });
}

function openRenameModal(user, trigger) {
  const form = document.createElement('form');
  form.className = 'pin-modal-form';
  form.innerHTML =
    `<label><span>Yeni kullanıcı adı</span><input name="name" type="text" required maxlength="100" autocomplete="off"></label>` +
    `<p role="alert" data-modal-error hidden></p>` +
    `<div class="form-actions"><button type="button" class="button secondary" data-modal-cancel>İptal</button><button type="submit" class="button">Adı kaydet</button></div>`;
  const input = form.querySelector('input[name="name"]');
  input.value = user.name || '';
  const errEl = form.querySelector('[data-modal-error]');
  const layer = window.DefterUI?.openModal?.({
    title: user.id === current()?.actor?.id ? 'Yönetici Adını Düzenle' : 'Kullanıcı Adını Düzenle',
    subtitle: `Mevcut ad: ${user.name}`,
    content: form,
    size: 'sm',
    closeOnBackdrop: true,
    trigger
  });
  form.querySelector('[data-modal-cancel]')?.addEventListener('click', () => layer?.close?.('cancel'));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    errEl.hidden = true;
    errEl.textContent = '';
    const nextName = input.value.trim();
    if (!nextName) { errEl.textContent = 'Geçerli bir kullanıcı adı girin.'; errEl.hidden = false; return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api('/api/auth/rename', { id: user.id, name: nextName });
      if (user.id === current()?.actor?.id && res.user) {
        updateActor(res.user);
        const label = document.querySelector('#session-name');
        if (label) label.textContent = res.user.name;
      }
      layer?.close?.('submit');
      await refresh();
      notify(`Kullanıcı adı "${nextName}" olarak güncellendi.`, 'success');
    } catch (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      notify(error.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  input.focus();
  input.select();
}

document.querySelector('#owner-rename-btn')?.addEventListener('click', event => {
  const actor = current()?.actor;
  if (actor) openRenameModal(actor, event.currentTarget);
});

document.querySelector('#owner-change-pin')?.addEventListener('click', event => {
  openPinModal({
    title: 'Yönetici PIN Değiştir',
    subtitle: 'Eski 6 haneli PIN kodunuzu doğrulayarak yeni PIN belirleyin',
    fields: [
      { name: 'currentPin', label: 'Mevcut 6 haneli PIN', autocomplete: 'current-password' },
      { name: 'newPin', label: 'Yeni 6 haneli PIN' },
      { name: 'confirmPin', label: 'Yeni 6 haneli PIN (Tekrar)' }
    ],
    submitLabel: "PIN'i güncelle",
    trigger: event.currentTarget,
    onSubmit: async ({ currentPin, newPin, confirmPin }) => {
      if (!/^\d{6}$/.test(currentPin) || !/^\d{6}$/.test(newPin)) throw new Error('PIN kodları tam 6 haneli rakamdan oluşmalı.');
      if (newPin !== confirmPin) throw new Error('Yeni PIN ve tekrarı eşleşmiyor.');
      await api('/api/auth/change-pin', { currentPin, newPin });
      notify('Yönetici PIN kodunuz güncellendi.', 'success');
    }
  });
});

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

    const actions = document.createElement('div');
    actions.className = 'employee-card-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'button secondary compact';
    renameBtn.textContent = 'Adı Düzenle';
    renameBtn.setAttribute('aria-label', `${user.name} için adı düzenle`);
    renameBtn.addEventListener('click', () => openRenameModal(user, renameBtn));

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'button secondary compact';
    resetBtn.textContent = 'PIN Sıfırla';
    resetBtn.setAttribute('aria-label', `${user.name} için PIN sıfırla`);
    resetBtn.addEventListener('click', () => openResetEmployeePinModal(user, resetBtn));

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
    actions.append(renameBtn, resetBtn, button);
    item.append(avatar, text, actions);
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
    if (!disable) {
      if (!/^\d{6}$/.test(String(data.pin || ''))) {
        notify('PIN kodu tam 6 haneli rakamdan oluşmalı.', 'error');
        return;
      }
      if (data.pin !== data.pinConfirm) {
        notify('Geçici PIN ve tekrarı eşleşmiyor.', 'error');
        return;
      }
    }
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
      const payload = disable ? { id: data.id } : { name: data.name, pin: data.pin };
      await api('/api/auth/' + (disable ? 'disable' : 'employees'), payload);
      if (disable) {
        const card = [...list.children].find(item => item.dataset.employeeId === String(data.id));
        if (card) window.DefterUI?.animateExit?.(card, 'toast');
      }
      form.reset();
      await refresh();
      notify(disable ? 'Çalışanın erişimi kapatıldı.' : 'Çalışan hesabı oluşturuldu. İlk girişte yeni PIN belirleyecektir.', 'success');
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

window.addEventListener('popstate', () => {
  if (window.DefterUI?.getLayerCount?.() > 0) window.DefterUI.closeTopLayer('popstate');
});
if (current()) refresh().catch(error => { status.textContent = error.message; });
