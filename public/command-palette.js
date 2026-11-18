(root => {
  const DEFAULT_MAX_RESULTS = 24;
  const HARD_MAX_RESULTS = 25;
  const DEFAULT_MAX_PER_GROUP = 8;
  const DEFAULT_DEBOUNCE_MS = 150;
  const DEFAULT_GROUP_ORDER = ['actions', 'navigation', 'records', 'commands'];
  const DEFAULT_EMPTY_MESSAGE = 'Eşleşen komut veya kayıt bulunamadı.';
  const DEFAULT_ERROR_MESSAGE = 'Arama sırasında bir hata oluştu. Tekrar deneyin.';
  const DEFAULT_PLACEHOLDER = 'Ekran, kayıt veya komut ara…';
  const DEFAULT_TITLE = 'Hızlı Komut Paleti';
  const DEFAULT_BLOCKED_REASON = 'İşlem devam ederken komut paleti açılamaz.';

  const doc = root.document || (typeof document !== 'undefined' ? document : null);
  const win = root.window || root;

  const ASCII_RE = /^[\x00-\x7f]*$/;
  const COMBINING_RE = /[\u0300-\u036f]/g;
  const WHITESPACE_RE = /\s+/g;
  const FOCUSABLE_SELECTOR = 'a[href]:not([tabindex^="-"]), button:not([disabled]):not([tabindex^="-"]), input:not([disabled]):not([type="hidden"]):not([tabindex^="-"]), select:not([disabled]):not([tabindex^="-"]), textarea:not([disabled]):not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';

  const itemRecordCache = new WeakMap();
  let instanceSeq = 0;
  let providerSeq = 0;

  function fallbackNormalize(text) {
    if (text === null || text === undefined) return '';
    const raw = String(text);
    const len = raw.length;
    if (!len) return '';
    if (ASCII_RE.test(raw)) {
      return raw.toLowerCase().replace(WHITESPACE_RE, ' ').trim();
    }
    let out = '';
    let prevSpace = true;
    let runStart = 0;
    for (let i = 0; i < len; i++) {
      const code = raw.charCodeAt(i);
      if (code < 128) {
        if (code === 32 || (code >= 9 && code <= 13)) {
          if (runStart < i) out += raw.slice(runStart, i);
          if (!prevSpace) {
            out += ' ';
            prevSpace = true;
          }
          runStart = i + 1;
          continue;
        }
        prevSpace = false;
        if (code >= 65 && code <= 90) {
          if (runStart < i) out += raw.slice(runStart, i);
          out += String.fromCharCode(code + 32);
          runStart = i + 1;
        }
        continue;
      }
      if (runStart < i) out += raw.slice(runStart, i);
      prevSpace = false;
      let mapped = '';
      switch (code) {
        case 0x00c2:
        case 0x00e2:
          mapped = 'a';
          break;
        case 0x00c7:
        case 0x00e7:
          mapped = 'c';
          break;
        case 0x00ce:
        case 0x00ee:
          mapped = 'i';
          break;
        case 0x00d6:
        case 0x00f6:
          mapped = 'o';
          break;
        case 0x00db:
        case 0x00fb:
        case 0x00dc:
        case 0x00fc:
          mapped = 'u';
          break;
        case 0x011e:
        case 0x011f:
          mapped = 'g';
          break;
        case 0x0130:
        case 0x0131:
          mapped = 'i';
          break;
        case 0x015e:
        case 0x015f:
          mapped = 's';
          break;
        default:
          return raw
            .toLocaleLowerCase('tr-TR')
            .normalize('NFD')
            .replace(COMBINING_RE, '')
            .replace(/ı/g, 'i')
            .replace(WHITESPACE_RE, ' ')
            .trim();
      }
      out += mapped;
      runStart = i + 1;
    }
    if (runStart < len) out += raw.slice(runStart);
    if (out.length > 0 && prevSpace) return out.slice(0, out.length - 1);
    return out;
  }

  function normHelper() {
    const helper = root.DefterSearchNorm || (typeof globalThis !== 'undefined' ? globalThis.DefterSearchNorm : null);
    if (helper && typeof helper.normalizeSearch === 'function') return helper;
    return {
      normalizeSearch: fallbackNormalize,
      tokenizeSearch: text => {
        const norm = fallbackNormalize(text);
        return norm ? norm.split(' ') : [];
      }
    };
  }

  function getUI() {
    return root.DefterUI || (typeof globalThis !== 'undefined' ? globalThis.DefterUI : null);
  }

  function formatCount(n) {
    try {
      return new Intl.NumberFormat('tr-TR').format(n);
    } catch {
      return String(n);
    }
  }

  function clampMaxResults(val) {
    const num = Number(val);
    if (!Number.isFinite(num) || num < 1) return DEFAULT_MAX_RESULTS;
    return Math.min(HARD_MAX_RESULTS, Math.floor(num));
  }

  function isThenable(value) {
    return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function');
  }

  const config = {
    maxResults: DEFAULT_MAX_RESULTS,
    maxPerGroup: DEFAULT_MAX_PER_GROUP,
    groupOrder: [...DEFAULT_GROUP_ORDER],
    debounceMs: DEFAULT_DEBOUNCE_MS,
    isBlocked: null,
    onBlocked: null,
    onOpen: null,
    onClose: null,
    onError: null,
    emptyMessage: DEFAULT_EMPTY_MESSAGE,
    errorMessage: DEFAULT_ERROR_MESSAGE,
    placeholder: DEFAULT_PLACEHOLDER,
    title: DEFAULT_TITLE
  };

  let providers = [];
  let listenersAttached = false;
  let destroyed = false;
  let openState = false;
  let returnTarget = null;
  let overlayHandle = null;
  let standaloneOverlayCleanup = null;

  let dialogEl = null;
  let inputEl = null;
  let clearBtn = null;
  let closeBtn = null;
  let statusEl = null;
  let errorEl = null;
  let listEl = null;
  let emptyEl = null;

  let renderedItems = [];
  let optionButtons = [];
  let activeIndex = -1;

  let debounceTimer = null;
  let activeController = null;
  let asyncSeq = 0;

  let lastSyncResult = {
    items: [],
    totalCount: 0,
    matchCount: 0
  };
  let lastAsyncResult = {
    items: [],
    totalCount: 0,
    matchCount: 0,
    loading: false,
    errorMessage: ''
  };

  function normalizeItem(rawItem, defaults = {}) {
    if (rawItem === null || rawItem === undefined) return null;
    if (typeof rawItem !== 'object') {
      const id = String(rawItem);
      return {
        id,
        title: id,
        subtitle: '',
        group: defaults.group || 'commands',
        groupLabel: defaults.groupLabel || 'Komutlar',
        keywords: '',
        shortcutHint: '',
        badge: '',
        disabled: false,
        disabledReason: '',
        restoreFocus: false,
        when: null,
        action: null,
        raw: rawItem
      };
    }
    const id = String(rawItem.id ?? rawItem.value ?? '');
    const title = String(rawItem.title ?? rawItem.label ?? rawItem.name ?? id);
    const subtitle = rawItem.subtitle
      ? String(rawItem.subtitle)
      : (rawItem.disambiguationLabel
        ? String(rawItem.disambiguationLabel)
        : (rawItem.description ? String(rawItem.description) : ''));
    const group = rawItem.group ? String(rawItem.group) : (defaults.group || 'commands');
    const groupLabel = rawItem.groupLabel ? String(rawItem.groupLabel) : (defaults.groupLabel || 'Komutlar');
    const keywords = Array.isArray(rawItem.keywords)
      ? rawItem.keywords.filter(Boolean).join(' ')
      : (rawItem.keywords ? String(rawItem.keywords) : '');
    const shortcutHint = rawItem.shortcutHint
      ? String(rawItem.shortcutHint)
      : (rawItem.shortcut ? String(rawItem.shortcut) : '');
    const badge = rawItem.badge
      ? String(rawItem.badge)
      : (rawItem.unit ? String(rawItem.unit) : '');
    const disabled = Boolean(rawItem.disabled || rawItem.retired);
    const disabledReason = rawItem.disabledReason
      ? String(rawItem.disabledReason)
      : (rawItem.retired ? 'Pasif' : (disabled ? 'Kullanılamaz' : ''));
    const restoreFocus = rawItem.restoreFocus === true;
    const when = typeof rawItem.when === 'function' ? rawItem.when : null;
    const action = typeof rawItem.action === 'function'
      ? rawItem.action
      : (typeof rawItem.onSelect === 'function' ? rawItem.onSelect : null);
    return {
      id,
      title,
      subtitle,
      group,
      groupLabel,
      keywords,
      shortcutHint,
      badge,
      disabled,
      disabledReason,
      restoreFocus,
      when,
      action,
      raw: rawItem
    };
  }

  function buildIndexRecord(rawItem, defaults, normalizeSearch) {
    const item = normalizeItem(rawItem, defaults);
    if (!item) return null;
    const raw = item.raw;
    if (raw && typeof raw === 'object') {
      const cached = itemRecordCache.get(raw);
      if (
        cached &&
        cached.id === item.id &&
        cached.title === item.title &&
        cached.subtitle === item.subtitle &&
        cached.keywords === item.keywords &&
        cached.badge === item.badge &&
        cached.group === item.group &&
        cached.groupLabel === item.groupLabel &&
        cached.disabled === item.disabled
      ) {
        return {
          ...cached,
          item,
          when: item.when,
          action: item.action
        };
      }
    }

    const idNorm = normalizeSearch(item.id);
    const titleNorm = normalizeSearch(item.title);
    const parts = [];
    if (idNorm) parts.push(idNorm);
    if (titleNorm) parts.push(titleNorm);
    if (item.subtitle) {
      const subNorm = normalizeSearch(item.subtitle);
      if (subNorm) parts.push(subNorm);
    }
    if (item.keywords) {
      const kwNorm = normalizeSearch(item.keywords);
      if (kwNorm) parts.push(kwNorm);
    }
    if (item.badge) {
      const badgeNorm = normalizeSearch(item.badge);
      if (badgeNorm) parts.push(badgeNorm);
    }
    if (item.groupLabel) {
      const glNorm = normalizeSearch(item.groupLabel);
      if (glNorm) parts.push(glNorm);
    }
    const searchBlob = parts.join(' ');
    const rec = {
      item,
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      keywords: item.keywords,
      badge: item.badge,
      group: item.group,
      groupLabel: item.groupLabel,
      disabled: item.disabled,
      when: item.when,
      action: item.action,
      idNorm,
      titleNorm,
      searchBlob
    };
    if (raw && typeof raw === 'object') {
      itemRecordCache.set(raw, rec);
    }
    return rec;
  }

  function getIndexedRecords(rawList, provider) {
    if (!Array.isArray(rawList)) return { records: [], hasWhen: false };
    const { normalizeSearch } = normHelper();
    const defaults = { group: provider.group, groupLabel: provider.groupLabel };
    const records = new Array(rawList.length);
    let len = 0;
    let hasWhen = false;
    for (let i = 0; i < rawList.length; i++) {
      const rec = buildIndexRecord(rawList[i], defaults, normalizeSearch);
      if (!rec) continue;
      if (rec.when) hasWhen = true;
      records[len++] = rec;
    }
    if (len !== records.length) records.length = len;
    return { records, hasWhen };
  }

  function extractResultPayload(result) {
    if (Array.isArray(result)) {
      return { items: result, total: result.length };
    }
    if (result && typeof result === 'object' && Array.isArray(result.items)) {
      const total = Number.isFinite(Number(result.total)) ? Number(result.total) : result.items.length;
      return { items: result.items, total };
    }
    return { items: [], total: 0 };
  }

  function evaluateBlockState() {
    if (!doc || !doc.body) {
      return { blocked: true, reason: DEFAULT_BLOCKED_REASON };
    }
    if (doc.body.hidden) {
      return { blocked: true, reason: 'Oturum kilitli.' };
    }
    if (
      doc.body.getAttribute('aria-busy') === 'true' ||
      doc.documentElement?.getAttribute('aria-busy') === 'true'
    ) {
      return { blocked: true, reason: DEFAULT_BLOCKED_REASON };
    }
    if (doc.querySelector('[data-busy="true"]')) {
      return { blocked: true, reason: DEFAULT_BLOCKED_REASON };
    }
    if (doc.querySelector('#lock-screen:not([hidden])')) {
      return { blocked: true, reason: 'Oturum kilitli.' };
    }
    if (doc.querySelector('#retry-bar:not([hidden]), #pending-panel:not([hidden]), [data-pending-blocking]')) {
      return { blocked: true, reason: 'Önce sonucu belirsiz son isteği doğrulayın.' };
    }
    if (doc.querySelector('[data-command-palette-blocked]')) {
      return { blocked: true, reason: DEFAULT_BLOCKED_REASON };
    }
    if (doc.querySelector('dialog.defter-modal[open] .defter-confirm-form, dialog[open][data-critical-modal="true"]')) {
      return { blocked: true, reason: 'Önce açık onay penceresini tamamlayın.' };
    }
    if (typeof config.isBlocked === 'function') {
      try {
        const res = config.isBlocked();
        if (res && typeof res === 'object') {
          if (res.blocked) {
            return { blocked: true, reason: res.reason ? String(res.reason) : DEFAULT_BLOCKED_REASON };
          }
        } else if (res) {
          return { blocked: true, reason: DEFAULT_BLOCKED_REASON };
        }
      } catch {
        return { blocked: true, reason: DEFAULT_BLOCKED_REASON };
      }
    }
    return { blocked: false, reason: '' };
  }

  function notifyBlocked(reason, context) {
    const msg = reason || DEFAULT_BLOCKED_REASON;
    if (typeof config.onBlocked === 'function') {
      try {
        config.onBlocked(msg, context);
        return;
      } catch {}
    }
    const ui = getUI();
    if (ui && typeof ui.toast === 'function') {
      ui.toast(msg, { kind: 'warning' });
    }
  }

  function syncTriggerExpanded(expanded) {
    if (!doc) return;
    const triggers = doc.querySelectorAll('[data-command-palette-trigger]');
    for (let i = 0; i < triggers.length; i++) {
      triggers[i].setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  }

  function cancelAsyncPending() {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (activeController) {
      try { activeController.abort(); } catch {}
      activeController = null;
    }
    asyncSeq++;
  }

  function focusableInDialog(container) {
    if (!container) return [];
    const candidates = container.querySelectorAll(FOCUSABLE_SELECTOR);
    const list = [];
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.hidden || el.closest('[hidden]')) continue;
      const tabAttr = el.getAttribute('tabindex');
      if (tabAttr !== null && Number(tabAttr) < 0) continue;
      if (typeof el.tabIndex === 'number' && el.tabIndex < 0) continue;
      list.push(el);
    }
    return list;
  }

  function groupItemsForRender(items) {
    const groupsMap = new Map();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = item.group || 'commands';
      let bucket = groupsMap.get(key);
      if (!bucket) {
        bucket = {
          key,
          label: item.groupLabel || key,
          items: []
        };
        groupsMap.set(key, bucket);
      }
      bucket.items.push(item);
    }
    const ordered = [];
    const seen = new Set();
    for (let i = 0; i < config.groupOrder.length; i++) {
      const key = config.groupOrder[i];
      const g = groupsMap.get(key);
      if (g) {
        ordered.push(g);
        seen.add(key);
      }
    }
    for (const [key, g] of groupsMap.entries()) {
      if (!seen.has(key)) ordered.push(g);
    }
    return ordered;
  }

  function firstEnabledIndex() {
    for (let i = 0; i < renderedItems.length; i++) {
      if (!renderedItems[i].disabled) return i;
    }
    return -1;
  }

  function lastEnabledIndex() {
    for (let i = renderedItems.length - 1; i >= 0; i--) {
      if (!renderedItems[i].disabled) return i;
    }
    return -1;
  }

  function stepEnabledIndex(from, direction) {
    if (!renderedItems.length) return -1;
    if (from < 0) return direction > 0 ? firstEnabledIndex() : lastEnabledIndex();
    let idx = from + direction;
    while (idx >= 0 && idx < renderedItems.length) {
      if (!renderedItems[idx].disabled) return idx;
      idx += direction;
    }
    return from >= 0 && !renderedItems[from]?.disabled ? from : -1;
  }

  function updateActiveOption(nextIndex) {
    if (activeIndex >= 0 && activeIndex < optionButtons.length) {
      const prevBtn = optionButtons[activeIndex];
      prevBtn.classList.remove('is-active');
      prevBtn.setAttribute('aria-selected', 'false');
    }
    activeIndex = nextIndex;
    if (activeIndex >= 0 && activeIndex < optionButtons.length && !renderedItems[activeIndex]?.disabled) {
      const btn = optionButtons[activeIndex];
      btn.classList.add('is-active');
      btn.setAttribute('aria-selected', 'true');
      inputEl?.setAttribute('aria-activedescendant', btn.id);
      if (typeof btn.scrollIntoView === 'function') {
        try { btn.scrollIntoView({ block: 'nearest' }); } catch {}
      }
    } else {
      activeIndex = -1;
      inputEl?.removeAttribute('aria-activedescendant');
    }
  }

  function executeItem(item) {
    if (!item || item.disabled) return;
    const blockState = evaluateBlockState();
    if (blockState.blocked) {
      if (errorEl) {
        errorEl.textContent = blockState.reason || DEFAULT_BLOCKED_REASON;
        errorEl.hidden = false;
      }
      notifyBlocked(blockState.reason, { source: 'execute', trigger: returnTarget });
      return;
    }
    const fn = item.action;
    const query = inputEl ? inputEl.value : '';
    const trig = returnTarget;
    close({ restoreFocus: item.restoreFocus === true, reason: 'execute' });
    if (typeof fn !== 'function') return;
    try {
      const res = fn({
        item: item.raw !== undefined ? item.raw : item,
        command: item,
        query,
        trigger: trig
      });
      if (res && typeof res.catch === 'function') {
        res.catch(err => {
          config.onError?.(err);
        });
      }
    } catch (err) {
      config.onError?.(err);
    }
  }

  function buildOptionElement(item, index, uid) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'defter-command-palette-option';
    btn.id = `${uid}-opt-${index}`;
    btn.setAttribute('role', 'option');
    btn.tabIndex = -1;
    btn.setAttribute('data-command-id', item.id);
    btn.setAttribute('data-command-group', item.group);
    btn.setAttribute('aria-selected', 'false');
    if (item.disabled) btn.setAttribute('aria-disabled', 'true');

    const mainRow = doc.createElement('span');
    mainRow.className = 'defter-command-palette-option-main';

    const titleEl = doc.createElement('span');
    titleEl.className = 'defter-command-palette-label';
    titleEl.textContent = item.title;
    mainRow.append(titleEl);

    if (item.badge || item.disabled || item.shortcutHint) {
      const badges = doc.createElement('span');
      badges.className = 'defter-command-palette-badges';
      if (item.badge) {
        const badgeEl = doc.createElement('span');
        badgeEl.className = 'defter-command-palette-badge';
        badgeEl.textContent = item.badge;
        badges.append(badgeEl);
      }
      if (item.disabled) {
        const disEl = doc.createElement('span');
        disEl.className = 'defter-command-palette-badge defter-command-palette-badge--disabled';
        disEl.textContent = item.disabledReason || 'Kullanılamaz';
        badges.append(disEl);
      }
      if (item.shortcutHint) {
        const kbdEl = doc.createElement('kbd');
        kbdEl.className = 'defter-command-palette-shortcut';
        kbdEl.textContent = item.shortcutHint;
        badges.append(kbdEl);
      }
      mainRow.append(badges);
    }

    btn.append(mainRow);

    if (item.subtitle) {
      const metaEl = doc.createElement('span');
      metaEl.className = 'defter-command-palette-meta';
      metaEl.textContent = item.subtitle;
      btn.append(metaEl);
    }

    btn.addEventListener('mousedown', event => {
      event.preventDefault();
    });
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (item.disabled) return;
      executeItem(item);
    });

    return btn;
  }

  function renderPaletteState() {
    if (!openState || !listEl || !statusEl || !emptyEl || !errorEl || !inputEl) return;

    const combinedItems = [];
    const seenKeys = new Set();
    const maxRes = clampMaxResults(config.maxResults);

    for (let i = 0; i < lastSyncResult.items.length && combinedItems.length < maxRes; i++) {
      const it = lastSyncResult.items[i];
      const dedupeKey = `${it.group}::${it.id}`;
      if (!seenKeys.has(dedupeKey)) {
        seenKeys.add(dedupeKey);
        combinedItems.push(it);
      }
    }
    for (let i = 0; i < lastAsyncResult.items.length && combinedItems.length < maxRes; i++) {
      const it = lastAsyncResult.items[i];
      const dedupeKey = `${it.group}::${it.id}`;
      if (!seenKeys.has(dedupeKey)) {
        seenKeys.add(dedupeKey);
        combinedItems.push(it);
      }
    }

    const totalSearchable = lastSyncResult.totalCount + lastAsyncResult.totalCount;
    const totalMatches = lastSyncResult.matchCount + lastAsyncResult.matchCount;
    const groups = groupItemsForRender(combinedItems);

    const frag = doc.createDocumentFragment();
    const nextRendered = [];
    const nextButtons = [];
    const uid = dialogEl?.id || 'defter-cp';

    let flatIdx = 0;
    for (let g = 0; g < groups.length; g++) {
      const groupObj = groups[g];
      const groupEl = doc.createElement('div');
      groupEl.className = 'defter-command-palette-group';
      groupEl.setAttribute('role', 'group');
      groupEl.setAttribute('aria-label', groupObj.label);

      const labelEl = doc.createElement('div');
      labelEl.className = 'defter-command-palette-group-label';
      labelEl.setAttribute('aria-hidden', 'true');
      labelEl.textContent = groupObj.label;
      groupEl.append(labelEl);

      for (let j = 0; j < groupObj.items.length; j++) {
        const item = groupObj.items[j];
        const btn = buildOptionElement(item, flatIdx++, uid);
        groupEl.append(btn);
        nextRendered.push(item);
        nextButtons.push(btn);
      }
      frag.append(groupEl);
    }

    renderedItems = nextRendered;
    optionButtons = nextButtons;
    activeIndex = -1;
    listEl.replaceChildren(frag);

    if (lastAsyncResult.errorMessage) {
      errorEl.textContent = lastAsyncResult.errorMessage;
      errorEl.hidden = false;
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    const hasResults = nextRendered.length > 0;
    inputEl.setAttribute('aria-expanded', 'true');

    if (hasResults) {
      emptyEl.hidden = true;
      emptyEl.textContent = '';
      const qTrim = inputEl.value.trim();
      const baseText = `${formatCount(nextRendered.length)} / ${formatCount(totalSearchable)} kayıt`;
      let statusText = qTrim && totalMatches > nextRendered.length
        ? `${baseText} (${formatCount(totalMatches)} eşleşme)`
        : baseText;
      if (lastAsyncResult.loading) statusText += ' · Aranıyor…';
      statusEl.textContent = statusText;
      updateActiveOption(firstEnabledIndex());
    } else {
      inputEl.removeAttribute('aria-activedescendant');
      if (lastAsyncResult.loading) {
        emptyEl.hidden = true;
        emptyEl.textContent = '';
        statusEl.textContent = 'Aranıyor…';
      } else if (lastAsyncResult.errorMessage) {
        emptyEl.hidden = true;
        emptyEl.textContent = '';
        statusEl.textContent = lastAsyncResult.errorMessage;
      } else {
        emptyEl.hidden = false;
        emptyEl.textContent = config.emptyMessage || DEFAULT_EMPTY_MESSAGE;
        statusEl.textContent = totalSearchable > 0
          ? `Sonuç bulunamadı (${formatCount(totalSearchable)} kayıt tarandı)`
          : (config.emptyMessage || DEFAULT_EMPTY_MESSAGE);
      }
    }
  }

  function runSyncProviders(rawQuery, qNorm, tokens) {
    const maxRes = clampMaxResults(config.maxResults);
    const syncProviders = [];
    const searchSyncCandidates = [];

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      if (p.when && !p.when()) continue;
      if (Array.isArray(p.items) || typeof p.getItems === 'function') {
        syncProviders.push(p);
      }
      if (typeof p.search === 'function') {
        searchSyncCandidates.push(p);
      }
    }

    let totalCount = 0;
    let matchCount = 0;
    const isEmptyQuery = tokens.length === 0;

    if (isEmptyQuery) {
      const collected = [];
      const singleSync = syncProviders.length === 1;
      for (let pIdx = 0; pIdx < syncProviders.length; pIdx++) {
        const p = syncProviders[pIdx];
        const rawList = typeof p.getItems === 'function'
          ? extractResultPayload(p.getItems({ query: '', normalizedQuery: '', tokens: [], limit: maxRes })).items
          : p.items;
        const { records, hasWhen } = getIndexedRecords(rawList, p);
        const sliceCap = p.maxItems !== null
          ? p.maxItems
          : (singleSync ? maxRes : Math.max(1, Number(config.maxPerGroup) || DEFAULT_MAX_PER_GROUP));

        if (!hasWhen) {
          totalCount += records.length;
          matchCount += records.length;
          const take = Math.min(sliceCap, records.length, maxRes - collected.length);
          for (let i = 0; i < take; i++) {
            collected.push(records[i].item);
          }
        } else {
          let taken = 0;
          for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            if (rec.when && !rec.when()) continue;
            totalCount++;
            matchCount++;
            if (taken < sliceCap && collected.length < maxRes) {
              collected.push(rec.item);
              taken++;
            }
          }
        }
      }
      return { items: collected, totalCount, matchCount, searchSyncCandidates };
    }

    const singleToken = tokens.length === 1;
    const token0 = tokens[0];
    const exactBucket = [];
    const prefixBucket = [];
    const otherBucket = [];

    for (let pIdx = 0; pIdx < syncProviders.length; pIdx++) {
      const p = syncProviders[pIdx];
      const rawList = typeof p.getItems === 'function'
        ? extractResultPayload(p.getItems({ query: rawQuery, normalizedQuery: qNorm, tokens, limit: maxRes })).items
        : p.items;
      const { records, hasWhen } = getIndexedRecords(rawList, p);
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (hasWhen && rec.when && !rec.when()) continue;
        totalCount++;
        let matched = rec.id === rawQuery;
        if (!matched) {
          if (singleToken) {
            matched = rec.searchBlob.includes(token0);
          } else {
            matched = true;
            for (let t = 0; t < tokens.length; t++) {
              if (!rec.searchBlob.includes(tokens[t])) {
                matched = false;
                break;
              }
            }
          }
        }
        if (!matched) continue;
        matchCount++;

        if (rec.id === rawQuery || rec.idNorm === qNorm || rec.titleNorm === qNorm) {
          if (exactBucket.length < maxRes) exactBucket.push(rec.item);
        } else if (rec.titleNorm.startsWith(qNorm) || rec.idNorm.startsWith(qNorm)) {
          if (prefixBucket.length < maxRes) prefixBucket.push(rec.item);
        } else if (otherBucket.length < maxRes) {
          otherBucket.push(rec.item);
        }
      }
    }

    const results = [];
    for (let i = 0; i < exactBucket.length && results.length < maxRes; i++) results.push(exactBucket[i]);
    for (let i = 0; i < prefixBucket.length && results.length < maxRes; i++) results.push(prefixBucket[i]);
    for (let i = 0; i < otherBucket.length && results.length < maxRes; i++) results.push(otherBucket[i]);

    return { items: results, totalCount, matchCount, searchSyncCandidates };
  }

  function runSearch(rawInput, { immediate = false } = {}) {
    if (!openState) return;
    cancelAsyncPending();

    const { normalizeSearch } = normHelper();
    const qRaw = String(rawInput ?? '').trim();
    const qNorm = normalizeSearch(qRaw);
    const tokens = qNorm ? qNorm.split(' ') : [];
    const maxRes = clampMaxResults(config.maxResults);

    const syncRes = runSyncProviders(qRaw, qNorm, tokens);
    lastSyncResult = {
      items: syncRes.items,
      totalCount: syncRes.totalCount,
      matchCount: syncRes.matchCount
    };

    const eligibleAsyncProviders = [];
    for (let i = 0; i < syncRes.searchSyncCandidates.length; i++) {
      const p = syncRes.searchSyncCandidates[i];
      if (qRaw.length >= p.minQueryLength) {
        eligibleAsyncProviders.push(p);
      }
    }

    if (!eligibleAsyncProviders.length) {
      lastAsyncResult = { items: [], totalCount: 0, matchCount: 0, loading: false, errorMessage: '' };
      renderPaletteState();
      return;
    }

    const invokeSearchProviders = () => {
      if (destroyed || !openState) return;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      activeController = controller;
      const seq = ++asyncSeq;
      const ctx = {
        query: qRaw,
        normalizedQuery: qNorm,
        tokens,
        limit: maxRes,
        signal: controller ? controller.signal : undefined
      };

      const promises = [];
      const syncItems = [];
      let syncExtraTotal = 0;

      for (let i = 0; i < eligibleAsyncProviders.length; i++) {
        const p = eligibleAsyncProviders[i];
        try {
          const out = p.search(qRaw, ctx);
          if (isThenable(out)) {
            promises.push({ provider: p, promise: out });
          } else {
            const payload = extractResultPayload(out);
            const defaults = { group: p.group, groupLabel: p.groupLabel };
            for (let k = 0; k < payload.items.length; k++) {
              const norm = normalizeItem(payload.items[k], defaults);
              if (norm && (!norm.when || norm.when())) syncItems.push(norm);
            }
            syncExtraTotal += payload.total;
          }
        } catch (err) {
          const wasAlreadyAborted = Boolean(controller?.signal?.aborted);
          try { controller?.abort(); } catch {}
          for (let j = 0; j < promises.length; j++) {
            Promise.resolve(promises[j].promise).catch(() => {});
          }
          if (activeController === controller) activeController = null;
          if (destroyed || !openState || seq !== asyncSeq || wasAlreadyAborted) return;
          lastAsyncResult = {
            items: syncItems,
            totalCount: syncExtraTotal,
            matchCount: syncExtraTotal,
            loading: false,
            errorMessage: err?.name === 'AbortError'
              ? ''
              : (err?.message ? String(err.message) : (config.errorMessage || DEFAULT_ERROR_MESSAGE))
          };
          renderPaletteState();
          return;
        }
      }

      if (!promises.length) {
        lastAsyncResult = {
          items: syncItems,
          totalCount: syncExtraTotal,
          matchCount: syncExtraTotal,
          loading: false,
          errorMessage: ''
        };
        if (activeController === controller) activeController = null;
        renderPaletteState();
        return;
      }

      lastAsyncResult = {
        items: syncItems,
        totalCount: syncExtraTotal,
        matchCount: syncExtraTotal,
        loading: true,
        errorMessage: ''
      };
      renderPaletteState();

      Promise.allSettled(promises.map(entry => entry.promise)).then(settled => {
        if (destroyed || !openState || seq !== asyncSeq || controller?.signal?.aborted) return;
        const asyncItems = [...syncItems];
        let asyncTotal = syncExtraTotal;
        let firstError = '';

        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i];
          const p = promises[i].provider;
          if (outcome.status === 'fulfilled') {
            const payload = extractResultPayload(outcome.value);
            const defaults = { group: p.group, groupLabel: p.groupLabel };
            for (let k = 0; k < payload.items.length; k++) {
              const norm = normalizeItem(payload.items[k], defaults);
              if (norm && (!norm.when || norm.when())) asyncItems.push(norm);
            }
            asyncTotal += payload.total;
          } else {
            const err = outcome.reason;
            if (err?.name === 'AbortError' || controller?.signal?.aborted) continue;
            if (!firstError) {
              firstError = err?.message ? String(err.message) : (config.errorMessage || DEFAULT_ERROR_MESSAGE);
            }
          }
        }

        if (activeController === controller) activeController = null;
        lastAsyncResult = {
          items: asyncItems,
          totalCount: asyncTotal,
          matchCount: asyncTotal,
          loading: false,
          errorMessage: firstError
        };
        renderPaletteState();
      });
    };

    const waitMs = Math.max(0, Number(config.debounceMs) || 0);
    if (immediate || waitMs === 0) {
      invokeSearchProviders();
    } else {
      lastAsyncResult = { items: [], totalCount: 0, matchCount: 0, loading: true, errorMessage: '' };
      renderPaletteState();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        invokeSearchProviders();
      }, waitMs);
    }
  }

  function attachStandaloneOverlay(dialog) {
    const changedAriaHidden = [];
    const selectors = ['.shell', '.access-card', 'main'];
    for (let i = 0; i < selectors.length; i++) {
      const el = doc.querySelector(selectors[i]);
      if (!el || el === dialog || el.contains(dialog)) continue;
      if (el.getAttribute('aria-hidden') !== 'true') {
        el.setAttribute('aria-hidden', 'true');
        changedAriaHidden.push(el);
      }
    }
    const openDialogs = doc.querySelectorAll('dialog[open]');
    for (let i = 0; i < openDialogs.length; i++) {
      const other = openDialogs[i];
      if (other === dialog) continue;
      if (other.getAttribute('aria-hidden') !== 'true') {
        other.setAttribute('aria-hidden', 'true');
        changedAriaHidden.push(other);
      }
    }
    const onPopstate = () => {
      if (openState) close({ restoreFocus: true, reason: 'popstate' });
    };
    win.addEventListener?.('popstate', onPopstate, true);
    return () => {
      win.removeEventListener?.('popstate', onPopstate, true);
      for (let i = 0; i < changedAriaHidden.length; i++) {
        const el = changedAriaHidden[i];
        if (el && el.isConnected) el.removeAttribute('aria-hidden');
      }
    };
  }

  function buildDialogDom() {
    const uid = `defter-cp-${++instanceSeq}`;
    const dlg = doc.createElement('dialog');
    dlg.id = uid;
    dlg.className = 'defter-dialog defter-command-palette';
    dlg.setAttribute('data-command-palette', '');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', `${uid}-title`);

    const surface = doc.createElement('div');
    surface.className = 'defter-command-palette-surface';

    const head = doc.createElement('header');
    head.className = 'defter-command-palette-head';

    const heading = doc.createElement('h2');
    heading.id = `${uid}-title`;
    heading.className = 'sr-only';
    heading.textContent = config.title || DEFAULT_TITLE;

    const searchWrap = doc.createElement('div');
    searchWrap.className = 'defter-command-palette-search-wrap';

    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'defter-command-palette-input';
    input.setAttribute('data-command-palette-input', '');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', `${uid}-list`);
    input.setAttribute('aria-label', config.title || DEFAULT_TITLE);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = config.placeholder || DEFAULT_PLACEHOLDER;

    const clear = doc.createElement('button');
    clear.type = 'button';
    clear.className = 'defter-command-palette-clear';
    clear.setAttribute('data-command-palette-clear', '');
    clear.tabIndex = -1;
    clear.setAttribute('aria-label', 'Aramayı temizle');
    clear.textContent = '×';
    clear.hidden = true;

    const closeBtnEl = doc.createElement('button');
    closeBtnEl.type = 'button';
    closeBtnEl.className = 'defter-dialog-close defter-command-palette-close';
    closeBtnEl.setAttribute('data-command-palette-close', '');
    closeBtnEl.setAttribute('aria-label', 'Komut paletini kapat');
    closeBtnEl.textContent = '×';

    searchWrap.append(input, clear, closeBtnEl);

    const status = doc.createElement('div');
    status.className = 'defter-command-palette-status';
    status.setAttribute('data-command-palette-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const errorBox = doc.createElement('div');
    errorBox.className = 'defter-command-palette-error';
    errorBox.setAttribute('data-command-palette-error', '');
    errorBox.setAttribute('role', 'alert');
    errorBox.hidden = true;

    head.append(heading, searchWrap, status, errorBox);

    const body = doc.createElement('div');
    body.className = 'defter-command-palette-body';

    const list = doc.createElement('div');
    list.id = `${uid}-list`;
    list.className = 'defter-command-palette-list';
    list.setAttribute('data-command-palette-list', '');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Komut sonuçları');

    const empty = doc.createElement('div');
    empty.className = 'defter-command-palette-empty';
    empty.setAttribute('data-command-palette-empty', '');
    empty.hidden = true;

    body.append(list, empty);

    const foot = doc.createElement('footer');
    foot.className = 'defter-command-palette-foot';
    foot.setAttribute('aria-hidden', 'true');
    for (const hint of ['↑↓ Gezin', 'Enter Çalıştır', 'Esc Kapat']) {
      const span = doc.createElement('span');
      span.textContent = hint;
      foot.append(span);
    }

    surface.append(head, body, foot);
    dlg.append(surface);

    input.addEventListener('input', () => {
      clear.hidden = !input.value;
      runSearch(input.value);
    });

    clear.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      clear.hidden = true;
      runSearch('', { immediate: true });
      input.focus({ preventScroll: true });
    });

    closeBtnEl.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true, reason: 'close-button' });
    });

    dlg.addEventListener('cancel', event => {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true, reason: 'escape' });
    });

    dlg.addEventListener('click', event => {
      if (event.target === dlg) {
        close({ restoreFocus: true, reason: 'backdrop' });
      }
    });

    dlg.addEventListener('keydown', event => {
      if (!openState) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true, reason: 'escape' });
        return;
      }
      if (event.key === 'Tab') {
        const items = focusableInDialog(dlg);
        if (!items.length) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (doc.activeElement === first || !dlg.contains(doc.activeElement))) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!event.shiftKey && (doc.activeElement === last || !dlg.contains(doc.activeElement))) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        updateActiveOption(stepEnabledIndex(activeIndex, 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        updateActiveOption(stepEnabledIndex(activeIndex, -1));
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        updateActiveOption(firstEnabledIndex());
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        updateActiveOption(lastEnabledIndex());
        return;
      }
      if (event.key === 'Enter') {
        if (event.target === closeBtnEl || event.target === clearBtn) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (activeIndex >= 0 && renderedItems[activeIndex] && !renderedItems[activeIndex].disabled) {
          executeItem(renderedItems[activeIndex]);
        }
      }
    });

    return { dlg, input, clear, closeBtnEl, status, errorBox, list, empty };
  }

  function isShortcutEvent(event) {
    if (!event || !event.key) return false;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
    return event.key.toLowerCase() === 'k';
  }

  function handleGlobalKeydown(event) {
    if (destroyed) return;
    if (!isShortcutEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    toggle({ source: 'shortcut', trigger: doc?.activeElement || null });
  }

  function handleGlobalClick(event) {
    if (destroyed) return;
    const trigger = event.target?.closest?.('[data-command-palette-trigger]');
    if (!trigger) return;
    if (trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    toggle({ source: 'trigger', trigger });
  }

  function ensureListeners() {
    if (!doc || listenersAttached) return;
    doc.addEventListener('keydown', handleGlobalKeydown, true);
    doc.addEventListener('click', handleGlobalClick);
    listenersAttached = true;
  }

  function removeListeners() {
    if (!doc || !listenersAttached) return;
    doc.removeEventListener('keydown', handleGlobalKeydown, true);
    doc.removeEventListener('click', handleGlobalClick);
    listenersAttached = false;
  }

  function configure(options = {}) {
    if (!options || typeof options !== 'object') return;
    destroyed = false;
    ensureListeners();
    if (options.maxResults !== undefined) config.maxResults = clampMaxResults(options.maxResults);
    if (options.maxPerGroup !== undefined) config.maxPerGroup = Math.max(1, Number(options.maxPerGroup) || DEFAULT_MAX_PER_GROUP);
    if (Array.isArray(options.groupOrder)) config.groupOrder = options.groupOrder.map(String);
    if (options.debounceMs !== undefined) config.debounceMs = Math.max(0, Number(options.debounceMs) || 0);
    if (options.isBlocked !== undefined) config.isBlocked = typeof options.isBlocked === 'function' ? options.isBlocked : null;
    if (options.onBlocked !== undefined) config.onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : null;
    if (options.onOpen !== undefined) config.onOpen = typeof options.onOpen === 'function' ? options.onOpen : null;
    if (options.onClose !== undefined) config.onClose = typeof options.onClose === 'function' ? options.onClose : null;
    if (options.onError !== undefined) config.onError = typeof options.onError === 'function' ? options.onError : null;
    if (options.emptyMessage !== undefined) config.emptyMessage = String(options.emptyMessage || DEFAULT_EMPTY_MESSAGE);
    if (options.errorMessage !== undefined) config.errorMessage = String(options.errorMessage || DEFAULT_ERROR_MESSAGE);
    if (options.placeholder !== undefined) config.placeholder = String(options.placeholder || DEFAULT_PLACEHOLDER);
    if (options.title !== undefined) config.title = String(options.title || DEFAULT_TITLE);
    if (openState && inputEl) {
      inputEl.placeholder = config.placeholder;
      refresh();
    }
  }

  function registerProvider(providerOrId, maybeSpec) {
    destroyed = false;
    ensureListeners();
    let rawSpec = null;
    if (typeof providerOrId === 'string') {
      if (Array.isArray(maybeSpec)) rawSpec = { id: providerOrId, items: maybeSpec };
      else if (typeof maybeSpec === 'function') {
        rawSpec = maybeSpec.length === 0 ? { id: providerOrId, getItems: maybeSpec } : { id: providerOrId, search: maybeSpec };
      } else if (maybeSpec && typeof maybeSpec === 'object') {
        rawSpec = { ...maybeSpec, id: maybeSpec.id || providerOrId };
      } else {
        rawSpec = { id: providerOrId, items: [] };
      }
    } else if (providerOrId && typeof providerOrId === 'object') {
      rawSpec = providerOrId;
    } else {
      throw new TypeError('Geçersiz komut sağlayıcısı.');
    }

    const id = String(rawSpec.id || `provider-${++providerSeq}`);
    const searchFn = typeof rawSpec.search === 'function'
      ? rawSpec.search
      : (typeof rawSpec.fetch === 'function'
        ? rawSpec.fetch
        : (typeof rawSpec.provider === 'function' ? rawSpec.provider : null));

    const entry = {
      id,
      seq: ++providerSeq,
      group: rawSpec.group ? String(rawSpec.group) : 'commands',
      groupLabel: rawSpec.groupLabel ? String(rawSpec.groupLabel) : 'Komutlar',
      priority: Number.isFinite(Number(rawSpec.priority)) ? Number(rawSpec.priority) : 100,
      maxItems: rawSpec.maxItems !== undefined && rawSpec.maxItems !== null ? Math.max(1, Number(rawSpec.maxItems) || 1) : null,
      minQueryLength: Math.max(0, Number(rawSpec.minQueryLength) || 0),
      when: typeof rawSpec.when === 'function' ? rawSpec.when : null,
      items: Array.isArray(rawSpec.items) ? rawSpec.items : null,
      getItems: typeof rawSpec.getItems === 'function' ? rawSpec.getItems : null,
      search: searchFn
    };

    if (entry.items) {
      getIndexedRecords(entry.items, entry);
    }

    providers = providers.filter(p => p.id !== id);
    providers.push(entry);
    providers.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));

    if (openState) refresh();

    return function unregister() {
      const prevLen = providers.length;
      providers = providers.filter(p => p !== entry);
      if (providers.length !== prevLen && openState) refresh();
    };
  }

  function unregisterProvider(id) {
    const key = String(id ?? '');
    const prevLen = providers.length;
    providers = providers.filter(p => p.id !== key);
    if (providers.length !== prevLen && openState) refresh();
    return providers.length !== prevLen;
  }

  function open(options = {}) {
    if (!doc || !doc.body) return false;
    destroyed = false;
    ensureListeners();
    const { trigger = null, initialQuery = undefined, source = 'programmatic' } = options || {};

    if (openState && (!dialogEl || !dialogEl.isConnected)) {
      close({ restoreFocus: false, reason: 'detached' });
    }

    const blockState = evaluateBlockState();
    if (blockState.blocked) {
      notifyBlocked(blockState.reason, { source, trigger });
      return false;
    }

    if (openState && dialogEl) {
      if (typeof initialQuery === 'string' && inputEl) {
        inputEl.value = initialQuery;
        if (clearBtn) clearBtn.hidden = !initialQuery;
        runSearch(initialQuery, { immediate: true });
      }
      inputEl?.focus?.({ preventScroll: true });
      return true;
    }

    returnTarget = trigger || doc.activeElement || null;
    const built = buildDialogDom();
    dialogEl = built.dlg;
    inputEl = built.input;
    clearBtn = built.clear;
    closeBtn = built.closeBtnEl;
    statusEl = built.status;
    errorEl = built.errorBox;
    listEl = built.list;
    emptyEl = built.empty;

    doc.body.append(dialogEl);

    const ui = getUI();
    if (ui && typeof ui.registerOverlay === 'function') {
      overlayHandle = ui.registerOverlay({
        dialog: dialogEl,
        close: reason => close({ restoreFocus: true, reason })
      });
      standaloneOverlayCleanup = null;
    } else {
      overlayHandle = null;
      standaloneOverlayCleanup = attachStandaloneOverlay(dialogEl);
    }

    if (typeof dialogEl.showModal === 'function') {
      try {
        dialogEl.showModal();
      } catch {
        dialogEl.setAttribute('open', '');
      }
    } else {
      dialogEl.setAttribute('open', '');
    }

    openState = true;
    syncTriggerExpanded(true);

    const qInit = typeof initialQuery === 'string' ? initialQuery : '';
    inputEl.value = qInit;
    clearBtn.hidden = !qInit;
    runSearch(qInit, { immediate: true });
    inputEl.focus?.({ preventScroll: true });

    try {
      config.onOpen?.({ source, trigger: returnTarget });
    } catch {}
    return true;
  }

  function close(options = {}) {
    if (!openState) return false;
    const { restoreFocus = true, reason = 'programmatic' } = options || {};
    openState = false;
    cancelAsyncPending();
    syncTriggerExpanded(false);

    if (dialogEl) {
      if (typeof dialogEl.close === 'function' && dialogEl.open) {
        try { dialogEl.close(); } catch {}
      }
      dialogEl.removeAttribute('open');
      dialogEl.remove();
    }

    if (overlayHandle) {
      try { overlayHandle.release(); } catch {}
      overlayHandle = null;
    }
    if (standaloneOverlayCleanup) {
      try { standaloneOverlayCleanup(); } catch {}
      standaloneOverlayCleanup = null;
    }

    const savedTarget = returnTarget;
    returnTarget = null;
    dialogEl = null;
    inputEl = null;
    clearBtn = null;
    closeBtn = null;
    statusEl = null;
    errorEl = null;
    listEl = null;
    emptyEl = null;
    renderedItems = [];
    optionButtons = [];
    activeIndex = -1;

    if (
      restoreFocus &&
      savedTarget &&
      savedTarget.isConnected &&
      !savedTarget.disabled &&
      typeof savedTarget.focus === 'function'
    ) {
      try { savedTarget.focus({ preventScroll: true }); } catch {}
    }

    try {
      config.onClose?.({ reason, returnTarget: savedTarget });
    } catch {}
    return true;
  }

  function toggle(options = {}) {
    if (openState && (!dialogEl || !dialogEl.isConnected)) {
      close({ restoreFocus: false, reason: 'detached' });
    }
    if (openState) {
      return close({ restoreFocus: true, reason: 'toggle' });
    }
    return open(options);
  }

  function isOpen() {
    return Boolean(openState && dialogEl && dialogEl.isConnected);
  }

  function isBlocked() {
    return Boolean(evaluateBlockState().blocked);
  }

  function refresh() {
    if (!openState || !inputEl) return false;
    runSearch(inputEl.value, { immediate: true });
    return true;
  }

  function destroy() {
    close({ restoreFocus: false, reason: 'destroy' });
    destroyed = true;
    removeListeners();
    providers = [];
    lastSyncResult = { items: [], totalCount: 0, matchCount: 0 };
    lastAsyncResult = { items: [], totalCount: 0, matchCount: 0, loading: false, errorMessage: '' };
  }

  ensureListeners();

  const exportsObj = {
    configure,
    registerProvider,
    unregisterProvider,
    open,
    close,
    toggle,
    isOpen,
    isBlocked,
    refresh,
    destroy
  };

  root.DefterCommandPalette = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterCommandPalette = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
