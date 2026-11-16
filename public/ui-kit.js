(root => {
  const activeToasts = new Set();
  const layerStack = [];
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  function focusableIn(container) {
    if (!container) return [];
    return [...container.querySelectorAll(FOCUSABLE)].filter(el => !el.hidden && !el.closest('[hidden]'));
  }

  function setBackgroundInert(active) {
    if (typeof document === 'undefined') return;
    for (const selector of ['.shell', '.access-card', 'main']) {
      const el = document.querySelector(selector);
      if (!el || el.closest('.defter-dialog')) continue;
      if (active) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
    }
  }

  function topLayer() {
    return layerStack[layerStack.length - 1] || null;
  }

  function openLayer({ kind = 'modal', title = '', subtitle = '', content = '', size = 'md', closeOnBackdrop = false, closeOnEsc = true, trigger = null, onClose = null } = {}) {
    if (typeof document === 'undefined' || !document.body) return null;
    const prevTop = topLayer();
    const returnTarget = trigger || document.activeElement;

    const dialog = document.createElement('dialog');
    dialog.className = `defter-dialog defter-${kind} defter-dialog--${size}`;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const headingId = `defter-dialog-title-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dialog.setAttribute('aria-labelledby', headingId);

    const header = document.createElement('header');
    header.className = 'defter-dialog-head';
    const titleWrap = document.createElement('div');
    const h2 = document.createElement('h2');
    h2.id = headingId;
    h2.textContent = title;
    titleWrap.append(h2);
    if (subtitle) {
      const sub = document.createElement('p');
      sub.className = 'defter-dialog-subtitle';
      sub.textContent = subtitle;
      titleWrap.append(sub);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'defter-dialog-close';
    closeBtn.setAttribute('aria-label', 'Pencereyi kapat');
    closeBtn.textContent = '×';
    header.append(titleWrap, closeBtn);

    const body = document.createElement('div');
    body.className = 'defter-dialog-body';
    if (typeof content === 'string') body.innerHTML = content;
    else if (content instanceof Node) body.append(content);

    dialog.append(header, body);

    let closed = false;
    const entry = { dialog, closeOnEsc, closeOnBackdrop, returnTarget, close: null };

    const handleKeydown = event => {
      if (topLayer() !== entry) return;
      if (event.key === 'Escape') {
        if (closeOnEsc) {
          event.preventDefault();
          event.stopPropagation();
          close('escape');
        }
        return;
      }
      if (event.key === 'Tab') {
        const items = focusableIn(dialog);
        if (!items.length) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    const handleCancel = event => {
      event.preventDefault();
      if (topLayer() === entry && closeOnEsc) close('escape');
    };

    const handleClick = event => {
      if (topLayer() !== entry) return;
      if (closeOnBackdrop && event.target === dialog) close('backdrop');
    };

    function close(reason = 'programmatic') {
      if (closed) return;
      closed = true;
      const idx = layerStack.indexOf(entry);
      if (idx !== -1) layerStack.splice(idx, 1);
      dialog.removeEventListener('keydown', handleKeydown);
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('click', handleClick);
      if (typeof dialog.close === 'function' && dialog.open) {
        try { dialog.close(); } catch {}
      }
      dialog.removeAttribute('open');
      dialog.remove();

      if (prevTop && prevTop.dialog.isConnected) {
        prevTop.dialog.removeAttribute('aria-hidden');
      }
      if (layerStack.length === 0) setBackgroundInert(false);

      if (returnTarget && typeof returnTarget.focus === 'function' && returnTarget.isConnected) {
        returnTarget.focus({ preventScroll: true });
      }
      onClose?.(reason);
    }

    entry.close = close;
    if (prevTop) prevTop.dialog.setAttribute('aria-hidden', 'true');
    setBackgroundInert(true);
    layerStack.push(entry);
    dialog.style.zIndex = String(100 + layerStack.length * 2);
    document.body.append(dialog);

    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    } else {
      dialog.setAttribute('open', '');
    }

    dialog.addEventListener('keydown', handleKeydown);
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('click', handleClick);
    closeBtn.addEventListener('click', () => close('close-button'));

    const initialFocus = focusableIn(body)[0] || closeBtn;
    initialFocus?.focus?.({ preventScroll: true });

    return { dialog, body, close };
  }

  function openModal(options = {}) {
    return openLayer({ ...options, kind: 'modal', closeOnBackdrop: options.closeOnBackdrop ?? false });
  }

  function openDrawer(options = {}) {
    return openLayer({ ...options, kind: 'drawer', closeOnBackdrop: options.closeOnBackdrop ?? true });
  }

  function confirmCritical({ title = 'İşlemi onaylayın', impactText = '', summaryHtml = '', confirmLabel = 'Onayla', cancelLabel = 'Vazgeç', danger = true, requireReason = false, reasonLabel = 'Gerekçe', trigger = null } = {}) {
    return new Promise(resolve => {
      let settled = false;
      const done = payload => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };

      const wrap = document.createElement('form');
      wrap.className = 'defter-confirm-form';
      if (impactText) {
        const p = document.createElement('p');
        p.className = 'defter-confirm-impact';
        p.textContent = impactText;
        wrap.append(p);
      }
      if (summaryHtml) {
        const box = document.createElement('div');
        box.className = 'info neutral';
        box.innerHTML = summaryHtml;
        wrap.append(box);
      }
      let reasonInput = null;
      if (requireReason) {
        const lbl = document.createElement('label');
        lbl.className = 'field';
        const span = document.createElement('span');
        span.textContent = reasonLabel;
        reasonInput = document.createElement('input');
        reasonInput.name = 'reason';
        reasonInput.required = true;
        reasonInput.maxLength = 160;
        lbl.append(span, reasonInput);
        wrap.append(lbl);
      }
      const actions = document.createElement('div');
      actions.className = 'defter-dialog-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'button secondary';
      cancelBtn.textContent = cancelLabel;
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'submit';
      confirmBtn.className = `button${danger ? ' danger' : ''}`;
      confirmBtn.textContent = confirmLabel;
      actions.append(cancelBtn, confirmBtn);
      wrap.append(actions);

      const layer = openModal({
        title,
        content: wrap,
        size: 'sm',
        closeOnBackdrop: false,
        closeOnEsc: true,
        trigger,
        onClose: () => done({ confirmed: false })
      });

      cancelBtn.addEventListener('click', () => layer?.close('cancel'));
      wrap.addEventListener('submit', event => {
        event.preventDefault();
        if (requireReason && reasonInput && !reasonInput.value.trim()) {
          showFieldError(reasonInput, 'Gerekçe yazın.');
          reasonInput.focus();
          return;
        }
        const reason = reasonInput ? reasonInput.value.trim() : undefined;
        done({ confirmed: true, ...(reason !== undefined ? { reason } : {}) });
        layer?.close('confirmed');
      });
    });
  }

  const exportsObj = {
    toast,
    clearToasts,
    showBanner,
    clearBanner,
    showFieldError,
    clearFieldError,
    openModal,
    openDrawer,
    confirmCritical,
    getLayerCount: () => layerStack.length
  };
  root.DefterUI = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterUI = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
