(root => {
  const activeToasts = new Set();

  function ensureToastRegion() {
    if (typeof document === 'undefined' || !document.body) return null;
    let region = document.getElementById('defter-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'defter-toast-region';
      region.className = 'defter-toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      document.body.append(region);
    }
    return region;
  }

  function toast(message, { kind = 'success', durationMs = 4000, label = '' } = {}) {
    const text = String(message ?? '').trim();
    if (!text) return null;
    const region = ensureToastRegion();
    if (!region) return null;

    const item = document.createElement('div');
    item.className = `defter-toast defter-toast--${['success', 'info', 'warning'].includes(kind) ? kind : 'info'}`;
    item.setAttribute('role', 'status');
    if (label) item.setAttribute('aria-label', label);

    const body = document.createElement('span');
    body.className = 'defter-toast-body';
    body.textContent = text;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'defter-toast-close';
    closeBtn.setAttribute('aria-label', 'Bildirimi kapat');
    closeBtn.textContent = '×';

    let timer = null;
    const dismiss = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      activeToasts.delete(dismiss);
      item.remove();
    };

    const armTimer = () => {
      if (durationMs > 0 && !timer) timer = setTimeout(dismiss, durationMs);
    };
    const pauseTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    closeBtn.addEventListener('click', dismiss);
    item.addEventListener('mouseenter', pauseTimer);
    item.addEventListener('mouseleave', armTimer);
    item.addEventListener('focusin', pauseTimer);
    item.addEventListener('focusout', armTimer);

    item.append(body, closeBtn);
    region.append(item);
    activeToasts.add(dismiss);
    armTimer();
    return { element: item, dismiss };
  }

  function clearToasts() {
    for (const dismiss of [...activeToasts]) dismiss();
  }

  function showBanner(targetEl, message, { kind = 'error', focus = false } = {}) {
    if (!targetEl) return;
    const isAlert = kind === 'error' || kind === 'critical';
    targetEl.setAttribute('role', isAlert ? 'alert' : 'status');
    targetEl.setAttribute('aria-live', isAlert ? 'assertive' : 'polite');
    targetEl.setAttribute('aria-atomic', 'true');
    targetEl.textContent = String(message ?? '');
    targetEl.className = `notice${isAlert ? ' error' : kind === 'warning' ? ' warning' : ''}`;
    targetEl.hidden = false;
    if (focus && typeof document !== 'undefined' && !document.activeElement?.closest('form')) {
      targetEl.tabIndex = -1;
      targetEl.focus({ preventScroll: true });
      targetEl.scrollIntoView?.({ block: 'nearest' });
    }
  }

  function clearBanner(targetEl) {
    if (!targetEl) return;
    targetEl.hidden = true;
    targetEl.textContent = '';
    targetEl.className = 'notice';
    targetEl.removeAttribute('tabindex');
  }

  function clearFieldError(control) {
    if (!control) return;
    control.removeAttribute('aria-invalid');
    const id = control.id || '';
    const errId = id ? `${id}-error` : '';
    const container = control.closest('label.field, .field, td, div') || control.parentElement;
    const errEl = (errId && typeof document !== 'undefined' && document.getElementById(errId)) || container?.querySelector(':scope > small.field-error');
    if (errEl) {
      if (errId && id) {
        const described = (control.getAttribute('aria-describedby') || '')
          .split(' ')
          .filter(token => token && token !== errId);
        if (described.length) control.setAttribute('aria-describedby', described.join(' '));
        else control.removeAttribute('aria-describedby');
      }
      errEl.remove();
    }
  }

  function showFieldError(control, message) {
    if (!control) return;
    clearFieldError(control);
    const text = String(message ?? '').trim();
    if (!text) return;
    control.setAttribute('aria-invalid', 'true');
    const container = control.closest('label.field, .field, td, div') || control.parentElement;
    if (!container) return;
    const errEl = document.createElement('small');
    errEl.className = 'field-error';
    errEl.setAttribute('role', 'alert');
    if (control.id) {
      errEl.id = `${control.id}-error`;
      const described = [...new Set([...(control.getAttribute('aria-describedby') || '').split(' ').filter(Boolean), errEl.id])];
      control.setAttribute('aria-describedby', described.join(' '));
    }
    errEl.textContent = text;
    container.append(errEl);
  }

  const exportsObj = {
    toast,
    clearToasts,
    showBanner,
    clearBanner,
    showFieldError,
    clearFieldError
  };
  root.DefterUI = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterUI = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
