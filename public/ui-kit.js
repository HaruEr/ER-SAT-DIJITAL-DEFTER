(root => {
  const activeToasts = new Set();
  const layerStack = [];
  const FOCUSABLE = 'a[href]:not([tabindex^="-"]), button:not([disabled]):not([tabindex^="-"]), input:not([disabled]):not([type="hidden"]):not([tabindex^="-"]), select:not([disabled]):not([tabindex^="-"]), textarea:not([disabled]):not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';
  let layerSeq = 0;
  const pushedLayerIds = new Set();
  const historyLayerStack = [];
  let pendingUnwindSteps = 0;
  let unwindMicrotaskScheduled = false;
  let unwindInFlight = false;
  let unwindSafetyTimer = null;
  const consumedPopstateEvents = new WeakSet();

  function scheduleHistoryUnwind() {
    if (unwindMicrotaskScheduled || pendingUnwindSteps <= 0) return;
    unwindMicrotaskScheduled = true;
    const schedule = typeof queueMicrotask === 'function' ? queueMicrotask : fn => Promise.resolve().then(fn);
    schedule(() => {
      unwindMicrotaskScheduled = false;
      flushHistoryUnwind();
    });
  }

  function flushDeferredHistoryPushes() {
    for (const entry of historyLayerStack) {
      if (entry.closed || entry.historyPushed || !entry.deferredHistoryPush) continue;
      entry.deferredHistoryPush = false;
      if (typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
        try {
          const baseState = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
          window.history.pushState({ ...baseState, defterLayerId: entry.layerId }, '', window.location?.href || '');
          if (window.history.state?.defterLayerId === entry.layerId) {
            entry.historyPushed = true;
            pushedLayerIds.add(entry.layerId);
          }
        } catch {}
      }
    }
  }

  function unwindClosedTail() {
    let steps = 0;
    while (historyLayerStack.length > 0 && historyLayerStack[historyLayerStack.length - 1].closed) {
      const popped = historyLayerStack.pop();
      if (popped.historyPushed) {
        popped.historyPushed = false;
        steps++;
      }
    }
    if (steps > 0) {
      pendingUnwindSteps += steps;
      scheduleHistoryUnwind();
    }
  }

  function flushHistoryUnwind() {
    if (unwindInFlight || pendingUnwindSteps <= 0) return;
    const steps = pendingUnwindSteps;
    pendingUnwindSteps = 0;
    if (typeof window === 'undefined' || !window.history) {
      flushDeferredHistoryPushes();
      return;
    }
    const activeId = window.history.state?.defterLayerId;
    if (!activeId || !pushedLayerIds.has(activeId)) {
      flushDeferredHistoryPushes();
      return;
    }
    const canBack = steps === 1 && typeof window.history.back === 'function';
    const canGo = steps > 1 && typeof window.history.go === 'function';
    if (!canBack && !canGo) {
      flushDeferredHistoryPushes();
      return;
    }
    unwindInFlight = true;
    if (unwindSafetyTimer) clearTimeout(unwindSafetyTimer);
    unwindSafetyTimer = setTimeout(() => {
      unwindSafetyTimer = null;
      if (!unwindInFlight) return;
      unwindInFlight = false;
      if (pendingUnwindSteps > 0) scheduleHistoryUnwind();
      else flushDeferredHistoryPushes();
    }, 250);
    try {
      if (steps === 1) window.history.back();
      else window.history.go(-steps);
    } catch {
      if (unwindSafetyTimer) { clearTimeout(unwindSafetyTimer); unwindSafetyTimer = null; }
      unwindInFlight = false;
      flushDeferredHistoryPushes();
    }
  }

  function handleWindowPopstate(event) {
    if (unwindInFlight) {
      if (unwindSafetyTimer) { clearTimeout(unwindSafetyTimer); unwindSafetyTimer = null; }
      unwindInFlight = false;
      event?.stopImmediatePropagation?.();
      if (pendingUnwindSteps > 0) scheduleHistoryUnwind();
      else flushDeferredHistoryPushes();
      return;
    }
    if (layerStack.length > 0) {
      if (event && typeof event === 'object') consumedPopstateEvents.add(event);
      const top = topLayer();
      const hadPushed = Boolean(top?.historyPushed);
      const hasUnderlyingLayer = layerStack.length > 1;
      if (hadPushed || (top?.external && hasUnderlyingLayer)) {
        event?.stopImmediatePropagation?.();
      }
      top?.close('popstate');
      unwindClosedTail();
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', handleWindowPopstate, true);
  }

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
    return [...container.querySelectorAll(FOCUSABLE)].filter(el => {
      if (el.hidden || el.closest('[hidden]') || el.classList?.contains('defter-combobox-native')) return false;
      const tabAttr = el.getAttribute('tabindex');
      if (tabAttr !== null && Number(tabAttr) < 0) return false;
      if (typeof el.tabIndex === 'number' && el.tabIndex < 0) return false;
      return true;
    });
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

  function openLayer({ kind = 'modal', title = '', subtitle = '', content = '', size = 'md', closeOnBackdrop = false, closeOnEsc = true, syncHistory = true, trigger = null, onClose = null } = {}) {
    if (typeof document === 'undefined' || !document.body) return null;
    const prevTop = topLayer();
    const returnTarget = trigger || document.activeElement;

    const dialog = document.createElement('dialog');
    dialog.className = `defter-dialog defter-${kind} defter-dialog--${size}`;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const headingId = `defter-dialog-title-${++layerSeq}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    const layerId = headingId;
    const entry = { dialog, closeOnEsc, closeOnBackdrop, returnTarget, layerId, closed: false, historyPushed: false, deferredHistoryPush: false, close: null };

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
      entry.closed = true;
      const wasTop = layerStack[layerStack.length - 1] === entry;
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

      const currentTop = topLayer();
      if (currentTop && currentTop.dialog && currentTop.dialog.isConnected) {
        currentTop.dialog.removeAttribute('aria-hidden');
      }
      if (layerStack.length === 0) setBackgroundInert(false);

      if (entry.deferredHistoryPush) {
        entry.deferredHistoryPush = false;
      }
      const hIdx = historyLayerStack.indexOf(entry);
      if (reason === 'popstate') {
        if (hIdx !== -1) historyLayerStack.splice(hIdx, 1);
        entry.historyPushed = false;
      } else if (syncHistory && entry.historyPushed) {
        unwindClosedTail();
      } else if (hIdx !== -1 && !entry.historyPushed) {
        historyLayerStack.splice(hIdx, 1);
      }

      if ((wasTop || layerStack.length === 0) && returnTarget && typeof returnTarget.focus === 'function' && returnTarget.isConnected) {
        returnTarget.focus({ preventScroll: true });
      }
      onClose?.(reason);
    }

    entry.close = close;
    if (prevTop) prevTop.dialog.setAttribute('aria-hidden', 'true');
    setBackgroundInert(true);
    layerStack.push(entry);
    if (syncHistory && typeof window !== 'undefined' && window.history && typeof window.history.pushState === 'function') {
      try {
        const baseState = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
        if (pendingUnwindSteps === 1 && !unwindInFlight && typeof window.history.replaceState === 'function' && pushedLayerIds.has(baseState.defterLayerId)) {
          pendingUnwindSteps--;
          window.history.replaceState({ ...baseState, defterLayerId: layerId }, '', window.location?.href || '');
          if (window.history.state?.defterLayerId === layerId) {
            entry.historyPushed = true;
            pushedLayerIds.add(layerId);
            historyLayerStack.push(entry);
          }
        } else if (pendingUnwindSteps > 0 || unwindInFlight) {
          entry.deferredHistoryPush = true;
          historyLayerStack.push(entry);
        } else {
          window.history.pushState({ ...baseState, defterLayerId: layerId }, '', window.location?.href || '');
          if (window.history.state?.defterLayerId === layerId) {
            entry.historyPushed = true;
            pushedLayerIds.add(layerId);
            historyLayerStack.push(entry);
          }
        }
      } catch {}
    }
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
      layer?.dialog?.setAttribute('data-critical-modal', 'true');

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

  let activePopover = null;

  function closePopover(restoreFocus = false) {
    if (!activePopover) return;
    const { pop, anchor, onDocDown, onKeyDown, onClose } = activePopover;
    activePopover = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    pop.remove();
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    onClose?.();
  }

  function openPopover(anchorEl, { title = '', content = '', onClose = null } = {}) {
    if (typeof document === 'undefined' || !document.body || !anchorEl) return null;
    if (activePopover?.anchor === anchorEl) {
      closePopover(true);
      return null;
    }
    closePopover(false);

    const pop = document.createElement('div');
    pop.className = 'defter-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-modal', 'false');
    const titleId = `defter-pop-title-${Date.now()}`;
    if (title) pop.setAttribute('aria-labelledby', titleId);

    const head = document.createElement('div');
    head.className = 'defter-popover-head';
    if (title) {
      const strong = document.createElement('strong');
      strong.id = titleId;
      strong.textContent = title;
      head.append(strong);
    }
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'defter-popover-close';
    closeBtn.setAttribute('aria-label', 'Bilgi kutusunu kapat');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => closePopover(true));
    head.append(closeBtn);

    const body = document.createElement('div');
    body.className = 'defter-popover-body';
    if (typeof content === 'string') body.innerHTML = content;
    else if (content instanceof Node) body.append(content);

    pop.append(head, body);
    document.body.append(pop);
    anchorEl.setAttribute('aria-expanded', 'true');

    // Position and clamp within viewport bounds
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
    const rect = anchorEl.getBoundingClientRect?.() || { left: 16, right: 120, top: 16, bottom: 48 };
    const popRect = pop.getBoundingClientRect?.() || { width: 280, height: 140 };
    const popW = popRect.width || 280;
    const popH = popRect.height || 140;
    const left = Math.max(8, Math.min(rect.left, vw - popW - 8));
    const top = rect.bottom + 8 + popH <= vh - 8 ? rect.bottom + 8 : Math.max(8, rect.top - popH - 8);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;

    const onDocDown = event => {
      if (!pop.contains(event.target) && !anchorEl.contains(event.target)) closePopover(false);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePopover(true);
      }
    };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKeyDown, true);

    activePopover = { pop, anchor: anchorEl, onDocDown, onKeyDown, onClose };
    closeBtn.focus({ preventScroll: true });
    return { element: pop, close: () => closePopover(true) };
  }

  function renderSkeleton(container, { variant = 'list', rows = 4, label = 'İçerik yükleniyor' } = {}) {
    if (!container) return null;
    const wrap = document.createElement('div');
    wrap.className = `defter-skeleton defter-skeleton--${variant}`;
    wrap.setAttribute('aria-busy', 'true');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', label);
    const count = Math.max(1, Math.min(10, Number(rows) || 4));
    for (let i = 0; i < count; i++) {
      const line = document.createElement('div');
      line.className = 'defter-skeleton-line';
      wrap.append(line);
    }
    container.replaceChildren(wrap);
    return wrap;
  }

  function registerOverlay({ dialog = null, close = null } = {}) {
    if (typeof document === 'undefined' || !document.body) {
      return { prevTop: null, release: () => {} };
    }
    closePopover(false);
    const prevTop = topLayer();
    if (prevTop && prevTop.dialog) prevTop.dialog.setAttribute('aria-hidden', 'true');
    setBackgroundInert(true);
    const entry = {
      dialog,
      close: reason => close?.(reason),
      external: true,
      historyPushed: false,
      deferredHistoryPush: false,
      closed: false
    };
    layerStack.push(entry);
    if (dialog && dialog.style) {
      dialog.style.zIndex = String(Math.max(140, 100 + layerStack.length * 2));
    }
    let released = false;
    function release() {
      if (released) return;
      released = true;
      entry.closed = true;
      const idx = layerStack.indexOf(entry);
      if (idx !== -1) layerStack.splice(idx, 1);
      if (prevTop && prevTop.dialog && prevTop.dialog.isConnected && (prevTop === topLayer() || !layerStack.includes(prevTop))) {
        prevTop.dialog.removeAttribute('aria-hidden');
      }
      const nextTop = topLayer();
      if (nextTop && nextTop.dialog && nextTop.dialog.isConnected) {
        nextTop.dialog.removeAttribute('aria-hidden');
      }
      if (layerStack.length === 0) setBackgroundInert(false);
    }
    return { prevTop, release };
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
    openPopover,
    closePopover,
    renderSkeleton,
    registerOverlay,
    wasPopstateConsumed: event => Boolean(event && consumedPopstateEvents.has(event)),
    getLayerCount: () => layerStack.length,
    topLayer: () => topLayer(),
    closeTopLayer: (reason = 'programmatic') => {
      const top = topLayer();
      if (!top) return false;
      top.close(reason);
      return true;
    }
  };
  root.DefterUI = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterUI = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
