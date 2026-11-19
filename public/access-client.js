// Per-tab authorization keeps separate local editor ports and users isolated.
(() => {
  const key = 'defter-session';
  const themeKey = 'defter-theme';
  function applySharedTheme(theme) {
    const selected = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = selected;
    const button = document.querySelector('#theme-toggle');
    if (button) {
      button.textContent = selected === 'dark' ? 'Gündüz modu' : 'Gece modu';
      button.setAttribute('aria-pressed', String(selected === 'dark'));
      button.setAttribute('aria-label', selected === 'dark' ? 'Gündüz moduna geç' : 'Gece moduna geç');
    }
    try { localStorage.setItem(themeKey, selected); } catch {}
  }
  applySharedTheme((() => { try { return localStorage.getItem(themeKey); } catch { return null; } })() || 'light');
  function current() {
    try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
  }
  function clear() {
    sessionStorage.removeItem(key);
    for (const name of Object.keys(sessionStorage)) {
      if (name.startsWith('defter-pending-') || name.startsWith('defter-sale-retry-') || name.startsWith('defter-draft:v1:')) sessionStorage.removeItem(name);
    }
    if (window.DefterDraftStore && typeof window.DefterDraftStore.clearSession === 'function') {
      try { window.DefterDraftStore.clearSession(); } catch {}
    }
  }
  function lock() {
    clear();
    document.body.hidden = true;
    location.replace('/');
  }
  async function api(path, body) {
    const session = current();
    const headers = session ? { Authorization: 'Bearer ' + session.token } : {};
    const options = { headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      Object.assign(options, { method: 'POST', body: JSON.stringify(body) });
    }
    const response = await fetch(path, options);
    const data = await response.json();
    if (response.status === 401 && session && location.pathname !== '/') lock();
    if (!response.ok) {
      const error = new Error(data.error || 'İstek tamamlanamadı.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function store(session) {
    clear();
    sessionStorage.setItem(key, JSON.stringify(session));
  }
  function finishRestore() {
    sessionStorage.setItem('defter-restore-complete','1');
    lock();
  }
  window.DefterSession = { current, clear, lock, api, store, finishRestore, applyTheme: applySharedTheme };
  if (location.pathname !== '/owner') {
    document.querySelector('#theme-toggle')?.addEventListener('click', () => {
      applySharedTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  }
  if (location.pathname === '/') return;
  const session = current();
  const expected = location.pathname === '/checkout' ? 'employee' : 'owner';
  if (!session || session.expiresAt <= Date.now() || session.actor?.role !== expected) { lock(); return; }
  async function verify() {
    try {
      const actor = await api('/api/auth/session');
      if (actor.role !== expected || actor.id !== session.actor.id) return lock();
      const label = document.querySelector('#session-name');
      if (label) label.textContent = actor.name;
    } catch { lock(); }
  }
  void verify();
  setTimeout(lock, Math.max(0, session.expiresAt - Date.now()));
  window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void verify(); });
  document.querySelector('#logout')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await api('/api/auth/logout', {}); } finally { lock(); }
  });
  document.addEventListener('click', async event => {
    const anchor = event.target.closest('a[download][href^="/api/"]');
    if (!anchor) return;
    event.preventDefault();
    const source = new URL(anchor.href);
    try {
      const result = await api('/api/download-ticket' + source.search, { operation: source.pathname.slice(5) });
      const link = document.createElement('a');
      link.href = result.url;
      link.download = '';
      link.click();
    } catch (error) {
      if (window.DefterUI?.toast) window.DefterUI.toast(error.message, { kind: 'warning', durationMs: 5000 });
      else window.alert(error.message);
    }
  });
})();
