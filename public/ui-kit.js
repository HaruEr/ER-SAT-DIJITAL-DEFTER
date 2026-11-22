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

  // ── Motion (GUI redesign Faz 2) ─────────────────────────────────────────
  // Layers keep their synchronous close contract (dialog closed + removed immediately,
  // focus/history/inert restored). The exit animation is played by an inert visual copy
  // ("ghost") that is removed when the animation ends. No ghost is made when motion is
  // reduced or the environment cannot animate (JSDOM, very old browsers).
  function motionAllowed() {
    if (typeof document === 'undefined' || !document.body || typeof Element === 'undefined') return false;
    if (typeof Element.prototype.animate !== 'function') return false;
    const prefs = root.DefterPrefs;
    if (prefs && typeof prefs.motionReduced === 'function') return !prefs.motionReduced();
    try { return !root.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
  }

  function motionToken(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    } catch { return fallback; }
  }

  function motionMs(name, fallback) {
    const raw = motionToken(name, `${fallback}ms`);
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) return fallback;
    return /ms$/.test(raw) ? num : /s$/.test(raw) ? num * 1000 : num;
  }

  const EXIT_FRAMES = {
    modal: scale => [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${scale})` }],
    drawer: () => [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }],
    sheet: () => [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }],
    popover: () => [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-4px)' }],
    toast: () => [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(calc(100% + 24px))' }]
  };

  // The ghost lives in a shadow root so no document query (app code, tests) can ever find its
  // cloned fields, ids, data-* hooks or classes. Its styles are a one-time constructed copy of the
  // page's own stylesheets, with :root selectors mapped to the shadow host (which mirrors
  // data-theme/data-motion). Constructed stylesheets are CSSOM, not inline styles, so CSP holds.
  let ghostSheet = null;
  let ghostSheetKey = '';
  function ghostStyleSheet() {
    if (typeof CSSStyleSheet !== 'function' || typeof ShadowRoot === 'undefined' || !('adoptedStyleSheets' in ShadowRoot.prototype)) return null;
    const sheets = [...document.styleSheets];
    const key = sheets.map(sheet => sheet.href || 'inline').join('|');
    if (ghostSheet && key === ghostSheetKey) return ghostSheet;
    let text = '';
    for (const sheet of sheets) {
      try { for (const rule of sheet.cssRules) text += `${rule.cssText}\n`; } catch {}
    }
    text = text.replace(/:root(\[[^\]]*\])/g, ':host($1)').replace(/:root\b/g, ':host');
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      ghostSheet = sheet;
      ghostSheetKey = key;
      return sheet;
    } catch { return null; }
  }

  // Build the ghost stylesheet while a layer is open and the browser is idle, so the first
  // close does not pay for it.
  let ghostWarmupScheduled = false;
  function warmGhostStyles() {
    if (ghostSheet || ghostWarmupScheduled || !motionAllowed()) return;
    ghostWarmupScheduled = true;
    const run = () => { ghostWarmupScheduled = false; ghostStyleSheet(); };
    if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(run, { timeout: 1000 });
    else setTimeout(run, 200);
  }

  function animateExit(el, kind = 'modal', { backdrop = false } = {}) {
    if (!el || !el.isConnected || !motionAllowed()) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const duration = motionMs('--dur-fast', 150);
    if (duration <= 0) return null;
    const easing = motionToken('--ease-in', 'ease-in');
    const styles = ghostStyleSheet();
    if (!styles) return null;

    const host = document.createElement('div');
    host.className = 'defter-ghost-host';
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('inert', '');
    for (const attr of ['data-theme', 'data-motion']) {
      const value = document.documentElement.getAttribute(attr);
      if (value !== null) host.setAttribute(attr, value);
    }
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.adoptedStyleSheets = [styles];

    const ghost = document.createElement('div');
    ghost.className = `${el.className} defter-ghost defter-ghost--${kind}`;
    for (const child of el.childNodes) ghost.append(child.cloneNode(true));
    // Belt and braces: even inside the shadow root the copy carries no ids or form names.
    for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
    for (const node of ghost.querySelectorAll('[name]')) node.removeAttribute('name');
    const s = ghost.style;
    s.position = 'fixed';
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    s.margin = '0';
    s.maxWidth = 'none';
    s.maxHeight = 'none';
    s.zIndex = '1000';
    s.pointerEvents = 'none';

    let scrim = null;
    if (backdrop) {
      scrim = document.createElement('div');
      scrim.className = backdrop === 'plain' ? 'defter-ghost-backdrop defter-ghost-backdrop--plain' : 'defter-ghost-backdrop';
      shadow.append(scrim);
    }
    shadow.append(ghost);
    document.body.append(host);

    // Keep scrolled regions (dialog body, palette list) where the user left them.
    const source = el.querySelectorAll('*');
    const copy = ghost.querySelectorAll('*');
    for (let i = 0; i < source.length && i < copy.length; i++) {
      if (source[i].scrollTop > 0) copy[i].scrollTop = source[i].scrollTop;
    }

    const frames = (EXIT_FRAMES[kind] || EXIT_FRAMES.modal)(motionToken('--exit-scale', '0.98'));
    let removed = false;
    const cleanup = () => {
      if (removed) return;
      removed = true;
      host.remove();
    };
    try {
      const animation = ghost.animate(frames, { duration, easing, fill: 'forwards' });
      scrim?.animate([{ opacity: 1 }, { opacity: 0 }], { duration, easing, fill: 'forwards' });
      animation.finished.then(cleanup, cleanup);
    } catch {
      cleanup();
      return null;
    }
    setTimeout(cleanup, duration + 250);
    return host;
  }

  // ── Critical confirmations (GUI redesign Faz 4) ────────────────────────
  // A confirm button that has just appeared ignores *user* activation (pointer, touch or keyboard,
  // i.e. trusted events) for a short arming window. This stops the second click of a double-click,
  // or a held/repeated Enter, from landing on the confirm button the first press revealed.
  // Programmatic .click()/requestSubmit() (untrusted) is never blocked. The window is a safety
  // rule, not motion, so it also applies when animations are reduced.
  const CONFIRM_ARM_MS = 300;
  function guardConfirm(button, { ms = CONFIRM_ARM_MS } = {}) {
    if (!button || button.dataset.confirmGuard === 'armed') return button;
    button.dataset.confirmGuard = 'armed';
    const armedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    button.classList.add('is-arming');
    button.setAttribute('aria-disabled', 'true');
    const release = () => {
      button.classList.remove('is-arming');
      button.removeAttribute('aria-disabled');
    };
    setTimeout(release, ms);
    button.addEventListener('click', event => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (event.isTrusted && now - armedAt < ms) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    return button;
  }

  function shake(el) {
    if (!el || !motionAllowed()) return;
    try {
      el.animate([
        { transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' },
        { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }
      ], { duration: 320, easing: 'ease-in-out' });
    } catch {}
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function criticalIcon(danger) {
    const wrap = document.createElement('span');
    wrap.className = `defter-critical-icon${danger ? ' is-danger' : ''}`;
    wrap.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    // Warning triangle with exclamation mark (same stroke style as the navigation icons).
    path.setAttribute('d', danger ? 'M12 3 2 20h20L12 3Zm0 6v5m0 3v.01' : 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v5m0 3v.01');
    svg.append(path);
    wrap.append(svg);
    return wrap;
  }

  // ── Guided steps (GUI redesign Faz 5) ──────────────────────────────────
  // Decorates an existing `.stepper-bar` without touching its step logic: the owner of the form
  // keeps toggling `.is-active` / aria-current on [data-step-target] tabs and [data-step-panel]
  // panels exactly as before. A MutationObserver on the tabs updates a progress line and an
  // "Adım n / N" label, and slides the newly shown panel in from the direction of travel.
  // The added meta row is aria-hidden: aria-current="step" already announces the step.
  function enhanceStepper(bar, scope = bar?.parentElement) {
    if (!bar || bar.dataset.stepperEnhanced === 'true' || typeof MutationObserver !== 'function') return null;
    const tabs = [...bar.querySelectorAll('[data-step-target]')];
    if (!tabs.length) return null;
    bar.dataset.stepperEnhanced = 'true';
    const meta = document.createElement('div');
    meta.className = 'stepper-meta';
    meta.setAttribute('aria-hidden', 'true');
    const count = document.createElement('span');
    count.className = 'stepper-count';
    const track = document.createElement('span');
    track.className = 'stepper-progress';
    track.append(document.createElement('i'));
    meta.append(count, track);
    bar.prepend(meta);

    const activeIndex = () => Math.max(0, tabs.findIndex(tab => tab.classList.contains('is-active')));
    let current = activeIndex();
    const render = animate => {
      const index = activeIndex();
      count.textContent = `Adım ${index + 1} / ${tabs.length}`;
      bar.style.setProperty('--step-progress', String((index + 1) / tabs.length));
      if (animate && index !== current && motionAllowed()) {
        const panel = scope?.querySelector?.(`[data-step-panel="${tabs[index].dataset.stepTarget}"]`);
        if (panel && getComputedStyle(panel).display !== 'none') {
          const shift = index > current ? 16 : -16;
          try {
            panel.animate([{ opacity: 0, transform: `translateX(${shift}px)` }, { opacity: 1, transform: 'translateX(0)' }],
              { duration: motionMs('--dur-slow', 250), easing: motionToken('--ease-out', 'ease-out') });
          } catch {}
        }
      }
      current = index;
    };
    render(false);
    const observer = new MutationObserver(() => render(true));
    for (const tab of tabs) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
    return { refresh: () => render(false), disconnect: () => observer.disconnect() };
  }

  // ── Micro-interactions (GUI redesign Faz 6) ────────────────────────────
  // View change: the new content rises 10px and fades in. Opacity/transform only, so numbers
  // are never re-laid-out or counted; nothing is delayed (focus and input are immediate).
  function animateEnter(el) {
    if (!el || !motionAllowed()) return null;
    try {
      return el.animate([{ opacity: 0, transform: `translateY(${motionToken('--enter-shift', '10px')})` }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 200, easing: motionToken('--ease-out', 'ease-out') });
    } catch { return null; }
  }

  // Sidebar: one gold indicator slides behind the active item instead of the highlight jumping.
  // The navigation owner keeps toggling `.active` on its buttons; a MutationObserver moves the
  // indicator. CSS shows it only for the desktop sidebar (the phone strip keeps its own style).
  function enhanceNav(nav) {
    if (!nav || nav.dataset.navIndicator === 'true' || typeof MutationObserver !== 'function') return null;
    const buttons = [...nav.querySelectorAll('[data-view]')];
    if (!buttons.length) return null;
    nav.dataset.navIndicator = 'true';
    const indicator = document.createElement('span');
    indicator.className = 'nav-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    nav.prepend(indicator);
    let placed = false;
    const place = () => {
      const active = buttons.find(button => button.classList.contains('active'));
      if (!active || !active.offsetParent) { indicator.classList.remove('is-visible'); return; }
      const navBox = nav.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      indicator.style.setProperty('--nav-x', `${box.left - navBox.left + nav.scrollLeft}px`);
      indicator.style.setProperty('--nav-y', `${box.top - navBox.top + nav.scrollTop}px`);
      indicator.style.setProperty('--nav-w', `${box.width}px`);
      indicator.style.setProperty('--nav-h', `${box.height}px`);
      if (!placed) {
        // First placement must not slide in from the top-left corner.
        indicator.classList.add('no-transition');
        indicator.classList.add('is-visible');
        void indicator.offsetWidth;
        indicator.classList.remove('no-transition');
        placed = true;
      } else {
        indicator.classList.add('is-visible');
      }
    };
    place();
    const observer = new MutationObserver(place);
    for (const button of buttons) observer.observe(button, { attributes: true, attributeFilter: ['class'] });
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        indicator.classList.add('no-transition');
        place();
        requestAnimationFrame(() => indicator.classList.remove('no-transition'));
      });
      resizeObserver.observe(nav);
    }
    return { refresh: place, disconnect: () => { observer.disconnect(); resizeObserver?.disconnect(); } };
  }

  // ── Settings, sound, top bar (GUI redesign Faz 7) ──────────────────────
  // Short two-note confirmation chime made with Web Audio (no sound file, CSP-safe).
  // Plays only when the "Ses" preference is on, unless `force` (the settings preview button).
  let audioContext = null;
  function playChime({ force = false } = {}) {
    const prefs = root.DefterPrefs;
    if (!force && prefs && typeof prefs.getSound === 'function' && !prefs.getSound()) return false;
    const AudioCtx = root.AudioContext || root.webkitAudioContext;
    if (typeof AudioCtx !== 'function') return false;
    try {
      audioContext ||= new AudioCtx();
      if (audioContext.state === 'suspended') audioContext.resume?.();
      const now = audioContext.currentTime;
      for (const [frequency, start] of [[1318.5, 0], [1760, 0.09]]) {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + start);
        gain.gain.exponentialRampToValueAtTime(0.12, now + start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.16);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(now + start);
        osc.stop(now + start + 0.18);
      }
      return true;
    } catch { return false; }
  }

  function switchRow({ id, label, hint = '', checked = false, onChange, extra = null }) {
    const row = document.createElement('div');
    row.className = 'defter-setting';
    const text = document.createElement('label');
    text.className = 'defter-setting-text';
    text.htmlFor = id;
    const strong = document.createElement('strong');
    strong.textContent = label;
    text.append(strong);
    if (hint) {
      const small = document.createElement('small');
      small.id = `${id}-hint`;
      small.textContent = hint;
      text.append(small);
    }
    const toggle = document.createElement('span');
    toggle.className = 'defter-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.checked = Boolean(checked);
    if (hint) input.setAttribute('aria-describedby', `${id}-hint`);
    const track = document.createElement('span');
    track.className = 'defter-switch-track';
    track.setAttribute('aria-hidden', 'true');
    toggle.append(input, track);
    input.addEventListener('change', () => onChange?.(input.checked, input));
    row.append(text, toggle);
    if (extra) row.append(extra);
    return { row, input };
  }

  // A sale or purchase was recorded: check-mark toast plus the confirmation chime (if enabled).
  // Never blocks: the toast is passive and the sound is fire-and-forget.
  function celebrate(message, { announce = true } = {}) {
    const handle = toast(message, { kind: 'success', icon: 'check', announce });
    playChime();
    return handle;
  }

  // Settings flyout opened from the gear button ([data-settings-trigger]). Rows appear only for
  // controls the current page has; theme and sidebar rows drive the page's own buttons so there is
  // a single source of truth (#theme-toggle, #sidebar-collapse).
  function openSettings(anchor) {
    if (!anchor || typeof document === 'undefined') return null;
    const prefs = root.DefterPrefs;
    const body = document.createElement('div');
    body.className = 'defter-settings-list';
    const themeButton = document.getElementById('theme-toggle');
    if (themeButton) {
      body.append(switchRow({
        id: 'setting-theme', label: 'Gece modu', hint: 'Koyu renkler. Üstteki ay / güneş butonuyla da değişir.',
        checked: document.documentElement.dataset.theme === 'dark',
        onChange: (on, input) => {
          if ((document.documentElement.dataset.theme === 'dark') !== on) themeButton.click();
          input.checked = document.documentElement.dataset.theme === 'dark';
        }
      }).row);
    }
    if (prefs) {
      let systemReduced = false;
      try { systemReduced = Boolean(root.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch {}
      body.append(switchRow({
        id: 'setting-motion', label: 'Animasyonları azalt',
        hint: systemReduced ? 'Bilgisayarınızın sistem ayarı hareketi zaten azaltıyor; bu anahtar kapalıyken de animasyonlar azaltılmış kalır.' : 'Pencere, menü ve geçiş hareketlerini kapatır. Güvenlik beklemeleri sürer.',
        checked: prefs.getMotion() === 'reduced',
        onChange: on => prefs.setMotion(on ? 'reduced' : 'full')
      }).row);
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'button text compact defter-setting-preview';
      preview.textContent = 'Sesi dinle';
      preview.addEventListener('click', () => playChime({ force: true }));
      body.append(switchRow({
        id: 'setting-sound', label: 'Onay sesi',
        hint: 'Satış ve alış kaydedilince kısa bir ses çalar.',
        checked: prefs.getSound(),
        onChange: on => prefs.setSound(on),
        extra: preview
      }).row);
    }
    let wide = false;
    try { wide = Boolean(root.matchMedia?.('(min-width: 901px)').matches); } catch {}
    if (prefs && typeof prefs.getTopbarSticky === 'function' && document.querySelector('.topbar') && wide) {
      body.append(switchRow({
        id: 'setting-topbar', label: 'Üst barı sabit tut', hint: 'Sayfa kaydırılırken tarih, çalışma alanı ve düğmeler üstte kalır.',
        checked: prefs.getTopbarSticky(),
        onChange: on => {
          prefs.setTopbarSticky(on);
          document.querySelector('.topbar')?.classList.toggle('is-scrolled', on && (root.scrollY || 0) > 4);
        }
      }).row);
    }
    const collapse = document.getElementById('sidebar-collapse');
    if (collapse && collapse.offsetParent !== null) {
      body.append(switchRow({
        id: 'setting-sidebar', label: 'Kenar menüsünü daralt', hint: 'Menüde yalnızca ikonlar görünür; çalışma alanı genişler.',
        checked: Boolean(document.querySelector('.shell.sidebar-collapsed')),
        onChange: (on, input) => {
          if (Boolean(document.querySelector('.shell.sidebar-collapsed')) !== on) collapse.click();
          input.checked = Boolean(document.querySelector('.shell.sidebar-collapsed'));
        }
      }).row);
    }
    const note = document.createElement('p');
    note.className = 'defter-settings-note';
    note.textContent = 'Bu ayarlar yalnızca bu bilgisayarda ve bu tarayıcıda saklanır.';
    body.append(note);
    return openPopover(anchor, { title: 'Ayarlar', content: body, className: 'defter-settings' });
  }

  // Top bar: sticky on wide screens (CSS); turns to glass once the page scrolls, and publishes its
  // height as --topbar-h so other sticky panels and scroll-padding can sit below it.
  function enhanceTopbar(bar) {
    if (!bar || bar.dataset.topbarEnhanced === 'true') return null;
    bar.dataset.topbarEnhanced = 'true';
    const sync = () => bar.classList.toggle('is-scrolled', (root.scrollY || 0) > 4);
    const measure = () => document.documentElement.style.setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
    root.addEventListener?.('scroll', sync, { passive: true });
    sync();
    measure();
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(bar);
    return { sync, measure };
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', event => {
      const trigger = event.target?.closest?.('[data-settings-trigger]');
      if (!trigger) return;
      event.preventDefault();
      openSettings(trigger);
    });
    const initTopbar = () => enhanceTopbar(document.querySelector('.topbar'));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTopbar, { once: true });
    else initTopbar();
  }

  // ── Bottom sheet (GUI redesign Faz 3) ──────────────────────────────────
  // At phone width drawers are bottom sheets (motion.css). The header is the drag handle:
  // pulling it down moves the sheet with the finger; releasing past 30% of its height or with a
  // downward flick (> 0.5 px/ms over the last 100 ms) closes it, otherwise it springs back.
  // Escape and the close button keep working; dragging never starts on a control.
  const SHEET_QUERY = '(max-width: 700px)';
  const SHEET_CLOSE_RATIO = 0.3;
  const SHEET_FLICK_VELOCITY = 0.5;
  function sheetMode() {
    try { return Boolean(root.matchMedia?.(SHEET_QUERY).matches); } catch { return false; }
  }

  function attachSheetDrag(dialog, handle, requestClose) {
    if (!dialog || !handle || typeof root.matchMedia !== 'function') return;
    let drag = null;
    const settleBack = dy => {
      dialog.style.removeProperty('transform');
      if (!dy || !motionAllowed()) return;
      try {
        dialog.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
          { duration: motionMs('--dur-base', 220), easing: motionToken('--ease-spring', 'ease-out') });
      } catch {}
    };
    const end = () => {
      dialog.classList.remove('is-dragging');
      try { if (drag) handle.releasePointerCapture?.(drag.id); } catch {}
      drag = null;
    };
    handle.addEventListener('pointerdown', event => {
      if (drag || !sheetMode() || !dialog.open || (event.button ?? 0) !== 0) return;
      if (event.target?.closest?.('button, a, input, select, textarea, [contenteditable]')) return;
      drag = { id: event.pointerId, startY: event.clientY, dy: 0, height: dialog.getBoundingClientRect().height || 1, samples: [[event.timeStamp, event.clientY]] };
      try { handle.setPointerCapture?.(event.pointerId); } catch {}
      dialog.classList.add('is-dragging');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.dy = Math.max(0, event.clientY - drag.startY);
      drag.samples.push([event.timeStamp, event.clientY]);
      while (drag.samples.length > 2 && event.timeStamp - drag.samples[0][0] > 100) drag.samples.shift();
      if (drag.dy > 0) dialog.style.transform = `translateY(${drag.dy}px)`;
      else dialog.style.removeProperty('transform');
    });
    handle.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const { dy, height, samples } = drag;
      const [t0, y0] = samples[0];
      const elapsed = event.timeStamp - t0;
      const velocity = elapsed > 0 ? (event.clientY - y0) / elapsed : (event.clientY > y0 ? Infinity : 0);
      end();
      if (dy > height * SHEET_CLOSE_RATIO || (dy > 8 && velocity > SHEET_FLICK_VELOCITY)) {
        // Keep the dragged offset: the exit ghost starts exactly where the finger let go.
        requestClose('swipe');
        return;
      }
      settleBack(dy);
    });
    handle.addEventListener('pointercancel', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const { dy } = drag;
      end();
      settleBack(dy);
    });
  }

  // FLIP: siblings that move because an element left glide to their new place.
  function glideSiblings(container, leaving) {
    if (!container || !motionAllowed()) return () => {};
    const items = [...container.children].filter(node => node !== leaving);
    const before = new Map(items.map(node => [node, node.getBoundingClientRect().top]));
    return () => {
      const duration = motionMs('--dur-base', 220);
      const easing = motionToken('--ease-out', 'ease-out');
      for (const node of items) {
        if (!node.isConnected) continue;
        const delta = before.get(node) - node.getBoundingClientRect().top;
        if (Math.abs(delta) < 1) continue;
        try { node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration, easing }); } catch {}
      }
    };
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

  // icon: 'check' draws a check mark (GUI Faz 9). announce: false keeps the toast visual only when the
  // page already announces the same text in its own live region (avoids a double announcement).
  function toast(message, { kind = 'success', durationMs = 4000, label = '', icon = '', announce = true } = {}) {
    const text = String(message ?? '').trim();
    if (!text) return null;
    const region = ensureToastRegion();
    if (!region) return null;

    const item = document.createElement('div');
    item.className = `defter-toast defter-toast--${['success', 'info', 'warning'].includes(kind) ? kind : 'info'}`;
    if (announce) item.setAttribute('role', 'status');
    else item.setAttribute('aria-hidden', 'true');
    if (label) item.setAttribute('aria-label', label);
    let iconEl = null;
    if (icon === 'check') {
      iconEl = document.createElement('span');
      iconEl.className = 'defter-toast-icon';
      iconEl.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '10');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm7.5 12.5 3 3 6-7');
      path.setAttribute('pathLength', '1');
      svg.append(circle, path);
      iconEl.append(svg);
    }

    const body = document.createElement('span');
    body.className = 'defter-toast-body';
    body.textContent = text;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'defter-toast-close';
    closeBtn.setAttribute('aria-label', 'Bildirimi kapat');
    closeBtn.textContent = '×';

    // Remaining-time bar; restarts with the timer after a hover/focus pause.
    let progress = null;
    if (durationMs > 0) {
      progress = document.createElement('span');
      progress.className = 'defter-toast-progress';
      progress.setAttribute('aria-hidden', 'true');
      item.style.setProperty('--toast-duration', `${durationMs}ms`);
    }

    let timer = null;
    let dismissed = false;
    const dismiss = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      activeToasts.delete(dismiss);
      if (dismissed) return;
      dismissed = true;
      const glide = item.isConnected ? glideSiblings(item.parentElement, item) : () => {};
      animateExit(item, 'toast');
      item.remove();
      glide();
    };

    const armTimer = () => {
      if (durationMs > 0 && !timer) {
        timer = setTimeout(dismiss, durationMs);
        if (progress) {
          item.classList.remove('is-paused');
          const fresh = progress.cloneNode(false);
          progress.replaceWith(fresh);
          progress = fresh;
        }
      }
    };
    const pauseTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      item.classList.add('is-paused');
    };

    closeBtn.addEventListener('click', dismiss);
    item.addEventListener('mouseenter', pauseTimer);
    item.addEventListener('mouseleave', armTimer);
    item.addEventListener('focusin', pauseTimer);
    item.addEventListener('focusout', armTimer);

    if (iconEl) item.append(iconEl);
    item.append(body, closeBtn);
    if (progress) item.append(progress);
    region.append(item);
    activeToasts.add(dismiss);
    armTimer();
    warmGhostStyles();
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
      animateExit(dialog, kind === 'drawer' ? (sheetMode() ? 'sheet' : 'drawer') : 'modal', { backdrop: layerStack.length === 0 });
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
    if (kind === 'drawer') attachSheetDrag(dialog, header, close);

    const initialFocus = focusableIn(body)[0] || closeBtn;
    initialFocus?.focus?.({ preventScroll: true });
    warmGhostStyles();

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
      if (layer?.dialog) {
        layer.dialog.classList.add(danger ? 'defter-dialog--danger' : 'defter-dialog--caution');
        layer.dialog.querySelector('.defter-dialog-head')?.prepend(criticalIcon(danger));
      }
      guardConfirm(confirmBtn);
      // The browser's own required-field check runs before submit; shake on it too.
      reasonInput?.addEventListener('invalid', () => shake(layer?.dialog));

      cancelBtn.addEventListener('click', () => layer?.close('cancel'));
      wrap.addEventListener('submit', event => {
        event.preventDefault();
        if (requireReason && reasonInput && !reasonInput.value.trim()) {
          showFieldError(reasonInput, 'Gerekçe yazın.');
          reasonInput.focus();
          shake(layer?.dialog);
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
    animateExit(pop, 'popover');
    pop.remove();
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    onClose?.();
  }

  function openPopover(anchorEl, { title = '', content = '', onClose = null, className = '' } = {}) {
    if (typeof document === 'undefined' || !document.body || !anchorEl) return null;
    if (activePopover?.anchor === anchorEl) {
      closePopover(true);
      return null;
    }
    closePopover(false);

    const pop = document.createElement('div');
    // Extra classes are applied before measuring so a wider variant is positioned correctly.
    pop.className = className ? `defter-popover ${className}` : 'defter-popover';
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
    // Layout size (offsetWidth/Height) ignores the opening flyout transform (scale 0.97), which
    // getBoundingClientRect would include and so let a wide popover overflow the right edge.
    const popRect = pop.getBoundingClientRect?.() || { width: 280, height: 140 };
    const popW = pop.offsetWidth || popRect.width || 280;
    const popH = pop.offsetHeight || popRect.height || 140;
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
    warmGhostStyles();
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
    warmGhostStyles();
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
    animateExit,
    guardConfirm,
    shake,
    enhanceStepper,
    enhanceNav,
    animateEnter,
    openSettings,
    playChime,
    celebrate,
    enhanceTopbar,
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
