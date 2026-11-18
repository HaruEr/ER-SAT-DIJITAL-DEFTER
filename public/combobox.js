(root => {
  const DEFAULT_MAX_RESULTS = 20;
  const DEFAULT_SMALL_LIST_THRESHOLD = 50;
  const DEFAULT_MAX_NATIVE_OPTIONS = 2;
  const INVALID_TEXT_MSG = 'Listeden geçerli bir seçim yapın veya aramayı temizleyin.';

  const instancesByEl = new WeakMap();
  const itemRecordCache = new WeakMap();
  const selectHooks = new WeakMap();
  const patchedSelectProtos = new WeakMap();
  const docPointerRegistry = new WeakMap();
  let instanceSeq = 0;

  function getDocPointerReg(doc) {
    let reg = docPointerRegistry.get(doc);
    if (!reg) {
      const openSet = new Set();
      const onPointerDown = event => {
        const entries = [...openSet];
        const target = event.target;
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.wasConnected && !entry.rootEl.isConnected) {
            openSet.delete(entry);
            entry.closeOnDetach();
            continue;
          }
          if (entry.rootEl.isConnected) entry.wasConnected = true;
          if (!entry.rootEl.contains(target) && !entry.panelEl.contains(target)) {
            entry.onOutsidePointerDown();
          }
        }
        if (openSet.size === 0 && reg.attached) {
          doc.removeEventListener('pointerdown', onPointerDown);
          reg.attached = false;
        }
      };
      reg = { openSet, attached: false, onPointerDown };
      docPointerRegistry.set(doc, reg);
    }
    return reg;
  }

  function ensureSelectProtoPatched(HTMLSelectProto) {
    if (!HTMLSelectProto) return null;
    if (patchedSelectProtos.has(HTMLSelectProto)) return patchedSelectProtos.get(HTMLSelectProto);
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectProto, 'value');
    const disabledDesc = Object.getOwnPropertyDescriptor(HTMLSelectProto, 'disabled');
    const requiredDesc = Object.getOwnPropertyDescriptor(HTMLSelectProto, 'required');
    const descriptors = { valueDesc, disabledDesc, requiredDesc };
    if (valueDesc && valueDesc.configurable) {
      Object.defineProperty(HTMLSelectProto, 'value', {
        configurable: true,
        enumerable: valueDesc.enumerable,
        get() {
          return valueDesc.get.call(this);
        },
        set(nextVal) {
          const hook = selectHooks.get(this);
          if (hook && hook.onValueSet) hook.onValueSet(nextVal, valueDesc.set);
          else valueDesc.set.call(this, nextVal);
        }
      });
    }
    if (disabledDesc && disabledDesc.configurable) {
      Object.defineProperty(HTMLSelectProto, 'disabled', {
        configurable: true,
        enumerable: disabledDesc.enumerable,
        get() {
          return disabledDesc.get.call(this);
        },
        set(nextVal) {
          disabledDesc.set.call(this, Boolean(nextVal));
          const hook = selectHooks.get(this);
          if (hook && hook.onDisabledSet) hook.onDisabledSet(Boolean(nextVal));
        }
      });
    }
    if (requiredDesc && requiredDesc.configurable) {
      Object.defineProperty(HTMLSelectProto, 'required', {
        configurable: true,
        enumerable: requiredDesc.enumerable,
        get() {
          return requiredDesc.get.call(this);
        },
        set(nextVal) {
          requiredDesc.set.call(this, Boolean(nextVal));
          const hook = selectHooks.get(this);
          if (hook && hook.onRequiredSet) hook.onRequiredSet(Boolean(nextVal));
        }
      });
    }
    patchedSelectProtos.set(HTMLSelectProto, descriptors);
    return descriptors;
  }

  const ASCII_RE = /^[\x00-\x7f]*$/;
  const COMBINING_RE = /[\u0300-\u036f]/g;
  const WHITESPACE_RE = /\s+/g;

  function fallbackNormalize(text) {
    if (text === null || text === undefined) return '';
    const raw = String(text);
    if (!raw) return '';
    if (ASCII_RE.test(raw)) return raw.toLowerCase().replace(WHITESPACE_RE, ' ').trim();
    return raw
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(COMBINING_RE, '')
      .replace(/ı/g, 'i')
      .replace(WHITESPACE_RE, ' ')
      .trim();
  }

  function normHelper() {
    const helper = root.DefterSearchNorm || (typeof globalThis !== 'undefined' ? globalThis.DefterSearchNorm : null);
    if (helper && typeof helper.normalizeSearch === 'function') return helper;
    return {
      normalizeSearch: fallbackNormalize,
      tokenizeSearch: text => {
        const n = fallbackNormalize(text);
        return n ? n.split(' ') : [];
      }
    };
  }

  function formatCount(n) {
    try {
      return new Intl.NumberFormat('tr-TR').format(n);
    } catch {
      return String(n);
    }
  }

  function normalizeItem(rawItem) {
    if (rawItem === null || rawItem === undefined) return null;
    if (typeof rawItem !== 'object') {
      const id = String(rawItem);
      return {
        id,
        label: id,
        unit: '',
        subtitle: '',
        meta: '',
        phone: '',
        taxId: '',
        code: '',
        barcode: '',
        badge: '',
        disabled: false,
        disabledReason: '',
        keywords: '',
        raw: rawItem
      };
    }
    const id = String(rawItem.id ?? rawItem.value ?? '');
    const label = String(rawItem.label ?? rawItem.name ?? id);
    const unit = rawItem.unit ? String(rawItem.unit) : '';
    const subtitle = rawItem.subtitle ? String(rawItem.subtitle) : (rawItem.disambiguationLabel ? String(rawItem.disambiguationLabel) : '');
    const meta = rawItem.meta ? String(rawItem.meta) : '';
    const phone = rawItem.phone ? String(rawItem.phone) : '';
    const taxId = rawItem.taxId ? String(rawItem.taxId) : '';
    const code = rawItem.code ? String(rawItem.code) : '';
    const barcode = rawItem.barcode ? String(rawItem.barcode) : '';
    const badge = rawItem.badge ? String(rawItem.badge) : '';
    const disabled = Boolean(rawItem.disabled || rawItem.retired);
    const disabledReason = rawItem.disabledReason
      ? String(rawItem.disabledReason)
      : (rawItem.retired ? 'Pasif' : (disabled ? 'Devre Dışı' : ''));
    const keywords = Array.isArray(rawItem.keywords)
      ? rawItem.keywords.filter(Boolean).join(' ')
      : (rawItem.keywords ? String(rawItem.keywords) : '');
    return {
      id,
      label,
      unit,
      subtitle,
      meta,
      phone,
      taxId,
      code,
      barcode,
      badge,
      disabled,
      disabledReason,
      keywords,
      raw: rawItem
    };
  }

  function rawMatchesCached(raw, cachedItem) {
    const id = String(raw.id ?? raw.value ?? '');
    if (cachedItem.id !== id) return false;
    const label = String(raw.label ?? raw.name ?? id);
    if (cachedItem.label !== label) return false;
    if (cachedItem.unit !== (raw.unit ? String(raw.unit) : '')) return false;
    const subtitle = raw.subtitle ? String(raw.subtitle) : (raw.disambiguationLabel ? String(raw.disambiguationLabel) : '');
    if (cachedItem.subtitle !== subtitle) return false;
    if (cachedItem.meta !== (raw.meta ? String(raw.meta) : '')) return false;
    if (cachedItem.phone !== (raw.phone ? String(raw.phone) : '')) return false;
    if (cachedItem.taxId !== (raw.taxId ? String(raw.taxId) : '')) return false;
    if (cachedItem.code !== (raw.code ? String(raw.code) : '')) return false;
    if (cachedItem.barcode !== (raw.barcode ? String(raw.barcode) : '')) return false;
    if (cachedItem.badge !== (raw.badge ? String(raw.badge) : '')) return false;
    const disabled = Boolean(raw.disabled || raw.retired);
    if (cachedItem.disabled !== disabled) return false;
    const disabledReason = raw.disabledReason ? String(raw.disabledReason) : (raw.retired ? 'Pasif' : (disabled ? 'Devre Dışı' : ''));
    if (cachedItem.disabledReason !== disabledReason) return false;
    const keywords = Array.isArray(raw.keywords) ? raw.keywords.filter(Boolean).join(' ') : (raw.keywords ? String(raw.keywords) : '');
    if (cachedItem.keywords !== keywords) return false;
    return true;
  }

  function buildIndexRecord(item, normalizeSearch) {
    const raw = item.raw;
    if (raw && typeof raw === 'object') {
      const cached = itemRecordCache.get(raw);
      if (
        cached &&
        cached.item.id === item.id &&
        cached.item.label === item.label &&
        cached.item.unit === item.unit &&
        cached.item.subtitle === item.subtitle &&
        cached.item.meta === item.meta &&
        cached.item.phone === item.phone &&
        cached.item.taxId === item.taxId &&
        cached.item.code === item.code &&
        cached.item.barcode === item.barcode &&
        cached.item.badge === item.badge &&
        cached.item.disabled === item.disabled &&
        cached.item.disabledReason === item.disabledReason &&
        cached.item.keywords === item.keywords
      ) {
        return cached;
      }
    }
    const idNorm = normalizeSearch(item.id);
    const labelNorm = normalizeSearch(item.label);
    const codeNorm = item.code ? normalizeSearch(item.code) : '';
    const barcodeNorm = item.barcode ? normalizeSearch(item.barcode) : '';
    const blobParts = [];
    if (idNorm) blobParts.push(idNorm);
    if (labelNorm) blobParts.push(labelNorm);
    if (item.unit) {
      const unitNorm = normalizeSearch(item.unit);
      if (unitNorm) blobParts.push(unitNorm);
    }
    if (item.subtitle) {
      const subNorm = normalizeSearch(item.subtitle);
      if (subNorm) blobParts.push(subNorm);
    }
    if (item.meta) {
      const metaNorm = normalizeSearch(item.meta);
      if (metaNorm) blobParts.push(metaNorm);
    }
    if (item.phone) {
      const phoneNorm = normalizeSearch(item.phone);
      if (phoneNorm) blobParts.push(phoneNorm);
      const phoneDigits = item.phone.replace(/\D+/g, '');
      if (phoneDigits && phoneDigits !== phoneNorm) blobParts.push(phoneDigits);
    }
    if (item.taxId) {
      const taxNorm = normalizeSearch(item.taxId);
      if (taxNorm) blobParts.push(taxNorm);
    }
    if (codeNorm) blobParts.push(codeNorm);
    if (barcodeNorm) blobParts.push(barcodeNorm);
    if (item.keywords) {
      const kwNorm = normalizeSearch(item.keywords);
      if (kwNorm) blobParts.push(kwNorm);
    }
    const searchBlob = blobParts.join(' ');
    const rec = {
      item,
      id: item.id,
      idNorm,
      labelNorm,
      codeNorm,
      barcodeNorm,
      searchBlob,
      disabled: item.disabled
    };
    if (raw && typeof raw === 'object') {
      itemRecordCache.set(raw, rec);
    }
    return rec;
  }

  function create(options = {}) {
    const {
      container = null,
      input: existingInput = null,
      label = '',
      placeholder = 'Ara ve seç…',
      items: initialItems = [],
      provider = null,
      value: initialValue = '',
      allowEmpty = true,
      emptyLabel = 'Seçilmedi',
      clearable = true,
      required = false,
      disabled = false,
      maxResults: rawMaxResults = DEFAULT_MAX_RESULTS,
      debounceMs: rawDebounceMs,
      minQueryLength: rawMinQueryLength,
      openOnFocus: rawOpenOnFocus,
      invalidTextBehavior = 'error',
      emptyMessage = 'Sonuç bulunamadı.',
      loadingMessage = 'Aranıyor…',
      errorMessage = 'Arama yapılamadı. Tekrar deneyin.',
      mountTarget = 'auto',
      formatSelectedText = item => item.label,
      onSelect = null,
      onChange = null,
      onQuery = null,
      _backingSelect = null
    } = options;

    const maxResults = Math.max(1, Math.min(DEFAULT_MAX_RESULTS, Number(rawMaxResults) || DEFAULT_MAX_RESULTS));
    const isAsync = typeof provider === 'function';
    const debounceMs = rawDebounceMs !== undefined ? Math.max(0, Number(rawDebounceMs) || 0) : (isAsync ? 180 : 0);
    const minQueryLength = rawMinQueryLength !== undefined ? Math.max(0, Number(rawMinQueryLength) || 0) : (isAsync ? 2 : 0);
    const openOnFocus = rawOpenOnFocus !== undefined ? Boolean(rawOpenOnFocus) : !isAsync;

    const uid = `defter-cb-${++instanceSeq}`;
    const listboxId = `${uid}-listbox`;

    const doc = (existingInput || container || _backingSelect || document).ownerDocument || document;

    const rootEl = doc.createElement('div');
    rootEl.className = 'defter-combobox';

    const controlEl = doc.createElement('div');
    controlEl.className = 'defter-combobox-control';

    const inputEl = existingInput || doc.createElement('input');
    if (!existingInput) {
      inputEl.type = 'text';
      inputEl.autocomplete = 'off';
      inputEl.spellcheck = false;
    }
    inputEl.classList.add('defter-combobox-input');
    inputEl.setAttribute('role', 'combobox');
    inputEl.setAttribute('aria-autocomplete', 'list');
    inputEl.setAttribute('aria-expanded', 'false');
    inputEl.setAttribute('aria-controls', listboxId);
    if (placeholder && !inputEl.placeholder) inputEl.placeholder = placeholder;
    if (label) inputEl.setAttribute('aria-label', label);
    inputEl.disabled = Boolean(disabled);
    if (required) inputEl.required = true;

    const actionsEl = doc.createElement('div');
    actionsEl.className = 'defter-combobox-actions';

    const clearBtn = doc.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'defter-combobox-clear';
    clearBtn.tabIndex = -1;
    clearBtn.setAttribute('aria-label', 'Seçimi temizle');
    clearBtn.textContent = '×';
    clearBtn.hidden = true;

    const toggleBtn = doc.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'defter-combobox-toggle';
    toggleBtn.tabIndex = -1;
    toggleBtn.setAttribute('aria-label', 'Listeyi aç/kapat');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.textContent = '▾';

    if (clearable) actionsEl.append(clearBtn);
    actionsEl.append(toggleBtn);

    if (existingInput) {
      if (existingInput.parentNode) {
        existingInput.parentNode.insertBefore(rootEl, existingInput);
      }
      controlEl.append(inputEl, actionsEl);
      rootEl.append(controlEl);
    } else {
      controlEl.append(inputEl, actionsEl);
      rootEl.append(controlEl);
      if (container) container.append(rootEl);
    }

    const panelEl = doc.createElement('div');
    panelEl.className = 'defter-combobox-panel';
    panelEl.hidden = true;

    const statusEl = doc.createElement('div');
    statusEl.className = 'defter-combobox-status';
    statusEl.setAttribute('data-combobox-status', '');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');

    const listboxEl = doc.createElement('div');
    listboxEl.className = 'defter-combobox-listbox';
    listboxEl.setAttribute('role', 'listbox');
    listboxEl.id = listboxId;

    const emptyEl = doc.createElement('div');
    emptyEl.className = 'defter-combobox-empty';
    emptyEl.setAttribute('data-combobox-empty', '');
    emptyEl.hidden = true;

    panelEl.append(statusEl, listboxEl, emptyEl);
    rootEl.append(panelEl);

    let rawItems = [];
    let indexedItems = null;
    let itemMap = isAsync ? new Map() : null;
    let renderedItems = [];
    let optionButtons = [];
    let activeIndex = -1;
    let isOpen = false;
    let isDestroyed = false;

    let committedValue = '';
    let committedItem = null;
    let committedLabel = '';
    let lastMatchCount = 0;
    let lastTotalCount = 0;

    let debounceTimer = null;
    let activeController = null;
    let requestSeq = 0;
    let currentPortalDialog = null;
    let dialogScrollBody = null;

    function syncClearVisibility() {
      const showClear = Boolean(clearable && !inputEl.disabled && (inputEl.value.length > 0 || committedValue !== ''));
      clearBtn.hidden = !showClear;
      rootEl.classList.toggle('has-clear', showClear);
      toggleBtn.disabled = Boolean(inputEl.disabled);
      clearBtn.disabled = Boolean(inputEl.disabled);
    }

    function clearValidityState() {
      if (typeof inputEl.setCustomValidity === 'function') inputEl.setCustomValidity('');
      inputEl.removeAttribute('aria-invalid');
      if (_backingSelect && typeof _backingSelect.setCustomValidity === 'function') {
        _backingSelect.setCustomValidity('');
      }
    }

    function setInvalidTextError({ report = false } = {}) {
      if (typeof inputEl.setCustomValidity === 'function') inputEl.setCustomValidity(INVALID_TEXT_MSG);
      inputEl.setAttribute('aria-invalid', 'true');
      if (_backingSelect && typeof _backingSelect.setCustomValidity === 'function') {
        _backingSelect.setCustomValidity(INVALID_TEXT_MSG);
      }
      if (report && typeof inputEl.reportValidity === 'function') {
        inputEl.reportValidity();
      }
    }

    function rawHasId(id) {
      const key = String(id ?? '');
      if (itemMap) return itemMap.has(key);
      for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        if (raw === null || raw === undefined) continue;
        const rawId = typeof raw === 'object' ? String(raw.id ?? raw.value ?? '') : String(raw);
        if (rawId === key) return true;
      }
      return false;
    }

    function findItemById(id) {
      if (id === '' || id === null || id === undefined) return null;
      const key = String(id);
      if (itemMap) return itemMap.get(key) || null;
      for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        if (raw === null || raw === undefined) continue;
        if (typeof raw !== 'object') {
          if (String(raw) === key) return normalizeItem(raw);
        } else {
          const rawId = String(raw.id ?? raw.value ?? '');
          if (rawId === key) return normalizeItem(raw);
        }
      }
      return null;
    }

    function ensureIndexed() {
      if (isAsync || indexedItems !== null) return;
      const { normalizeSearch } = normHelper();
      const nextIndexed = [];
      const nextMap = new Map();
      for (let i = 0; i < rawItems.length; i++) {
        const raw = rawItems[i];
        if (raw === null || raw === undefined) continue;
        if (typeof raw === 'object') {
          const cached = itemRecordCache.get(raw);
          if (cached && rawMatchesCached(raw, cached.item)) {
            nextMap.set(cached.id, cached.item);
            nextIndexed.push(cached);
            continue;
          }
        }
        const item = normalizeItem(raw);
        if (!item) continue;
        nextMap.set(item.id, item);
        nextIndexed.push(buildIndexRecord(item, normalizeSearch));
      }
      indexedItems = nextIndexed;
      itemMap = nextMap;
    }

    function setItems(nextItems = []) {
      rawItems = Array.isArray(nextItems) ? nextItems : [];
      if (isAsync) {
        if (!itemMap) itemMap = new Map();
        else itemMap.clear();
        for (let i = 0; i < rawItems.length; i++) {
          const item = normalizeItem(rawItems[i]);
          if (item) itemMap.set(item.id, item);
        }
      } else {
        indexedItems = null;
        itemMap = null;
      }
      if (committedValue !== '') {
        const prevCommittedLabel = committedLabel;
        const refreshed = findItemById(committedValue);
        if (refreshed) {
          committedItem = refreshed;
          committedLabel = String(formatSelectedText(refreshed) ?? refreshed.label);
          if (inputEl.value === prevCommittedLabel) {
            inputEl.value = committedLabel;
          }
        } else {
          committedValue = '';
          committedItem = null;
          committedLabel = '';
          if (inputEl.value === prevCommittedLabel || !isOpen) {
            inputEl.value = '';
          }
          clearValidityState();
          syncClearVisibility();
        }
      }
      if (isOpen && !isAsync) {
        ensureIndexed();
        const effectiveQuery = inputEl.value === committedLabel && committedValue !== '' ? '' : inputEl.value;
        runSyncSearch(effectiveQuery);
      }
    }

    function buildMetaParts(item) {
      const parts = [];
      const seen = new Set();
      const pushPart = text => {
        if (!text) return;
        const clean = String(text).trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        parts.push(clean);
      };
      if (item.subtitle) pushPart(item.subtitle);
      if (item.phone && (!item.subtitle || !item.subtitle.includes(item.phone))) pushPart(item.phone);
      if (item.taxId && (!item.subtitle || !item.subtitle.includes(item.taxId))) pushPart(`TC/VKN ${item.taxId}`);
      if (item.code) pushPart(`Kod: ${item.code}`);
      if (item.meta) pushPart(item.meta);
      return parts;
    }

    function updateActiveDom(nextIndex) {
      if (activeIndex >= 0 && activeIndex < optionButtons.length) {
        optionButtons[activeIndex].classList.remove('is-active');
      }
      activeIndex = nextIndex;
      if (activeIndex >= 0 && activeIndex < optionButtons.length) {
        const btn = optionButtons[activeIndex];
        btn.classList.add('is-active');
        inputEl.setAttribute('aria-activedescendant', btn.id);
        if (typeof btn.scrollIntoView === 'function') {
          try { btn.scrollIntoView({ block: 'nearest' }); } catch {}
        }
      } else {
        inputEl.removeAttribute('aria-activedescendant');
      }
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

    function renderOptions(items, { total = items.length, matchCount = total, message = '' } = {}) {
      const capped = items.slice(0, maxResults);
      renderedItems = capped;
      lastMatchCount = matchCount;
      lastTotalCount = total;

      const frag = doc.createDocumentFragment();
      const nextButtons = [];
      for (let i = 0; i < capped.length; i++) {
        const item = capped[i];
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'defter-combobox-option';
        btn.id = `${uid}-opt-${i}`;
        btn.setAttribute('role', 'option');
        btn.tabIndex = -1;
        const selected = committedValue !== '' && item.id === committedValue;
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (item.disabled) btn.setAttribute('aria-disabled', 'true');

        const head = doc.createElement('span');
        head.className = 'defter-combobox-option-head';

        const labelSpan = doc.createElement('span');
        labelSpan.className = 'defter-combobox-label';
        labelSpan.textContent = item.label;
        head.append(labelSpan);

        if (item.unit || item.badge || item.disabled) {
          const badges = doc.createElement('span');
          badges.className = 'defter-combobox-badges';
          if (item.unit) {
            const unitBadge = doc.createElement('span');
            unitBadge.className = 'defter-combobox-badge defter-combobox-badge--unit';
            unitBadge.textContent = item.unit;
            badges.append(unitBadge);
          }
          if (item.badge && item.badge !== item.unit) {
            const customBadge = doc.createElement('span');
            customBadge.className = 'defter-combobox-badge';
            customBadge.textContent = item.badge;
            badges.append(customBadge);
          }
          if (item.disabled) {
            const disabledBadge = doc.createElement('span');
            disabledBadge.className = 'defter-combobox-badge defter-combobox-badge--retired';
            disabledBadge.textContent = item.disabledReason || 'Pasif';
            badges.append(disabledBadge);
          }
          head.append(badges);
        }

        btn.append(head);

        const metaParts = buildMetaParts(item);
        if (metaParts.length) {
          const metaEl = doc.createElement('span');
          metaEl.className = 'defter-combobox-meta';
          metaEl.textContent = metaParts.join(' · ');
          btn.append(metaEl);
        }

        btn.addEventListener('mousedown', event => {
          event.preventDefault();
        });
        btn.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (item.disabled || inputEl.disabled) return;
          commitSelection(item, { source: 'pointer' });
          close({ restoreText: false });
          inputEl.focus({ preventScroll: true });
        });

        frag.append(btn);
        nextButtons.push(btn);
      }

      optionButtons = nextButtons;
      activeIndex = -1;
      listboxEl.replaceChildren(frag);

      if (capped.length > 0) {
        emptyEl.hidden = true;
        emptyEl.classList.remove('defter-combobox-empty--error');
        emptyEl.removeAttribute('data-combobox-error');
        const baseStatus = `${formatCount(capped.length)} / ${formatCount(total)} kayıt`;
        statusEl.textContent = matchCount < total
          ? `${baseStatus} (${formatCount(matchCount)} eşleşme)`
          : baseStatus;

        let initialIdx = -1;
        if (committedValue !== '') {
          const foundIdx = capped.findIndex(it => it.id === committedValue && !it.disabled);
          if (foundIdx >= 0) initialIdx = foundIdx;
        }
        if (initialIdx < 0) initialIdx = firstEnabledIndex();
        updateActiveDom(initialIdx);
      } else {
        inputEl.removeAttribute('aria-activedescendant');
        emptyEl.hidden = false;
        emptyEl.classList.remove('defter-combobox-empty--error');
        emptyEl.removeAttribute('data-combobox-error');
        const msg = message || emptyMessage;
        emptyEl.textContent = msg;
        statusEl.textContent = msg;
      }

      if (isOpen) positionPanel();
    }

    function renderStatusBox(text, { isError = false } = {}) {
      renderedItems = [];
      optionButtons = [];
      activeIndex = -1;
      inputEl.removeAttribute('aria-activedescendant');
      listboxEl.replaceChildren();
      emptyEl.hidden = false;
      emptyEl.classList.toggle('defter-combobox-empty--error', Boolean(isError));
      if (isError) emptyEl.setAttribute('data-combobox-error', 'true');
      else emptyEl.removeAttribute('data-combobox-error');
      emptyEl.textContent = text;
      statusEl.textContent = text;
      if (isOpen) positionPanel();
    }

    function runSyncSearch(rawQuery) {
      ensureIndexed();
      const { normalizeSearch } = normHelper();
      const qRaw = String(rawQuery ?? '').trim();
      const qNorm = normalizeSearch(qRaw);
      const total = indexedItems.length;

      if (!qNorm) {
        const slice = [];
        const lim = Math.min(maxResults, total);
        for (let i = 0; i < lim; i++) slice.push(indexedItems[i].item);
        renderOptions(slice, { total, matchCount: total });
        return;
      }

      const tokens = qNorm.split(' ');
      const singleToken = tokens.length === 1;
      const token0 = tokens[0];
      const exactBucket = [];
      const prefixBucket = [];
      const otherBucket = [];
      let matchCount = 0;

      for (let i = 0; i < total; i++) {
        const rec = indexedItems[i];
        let matched = rec.id === qRaw;
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

        if (
          rec.id === qRaw ||
          rec.idNorm === qNorm ||
          rec.labelNorm === qNorm ||
          (rec.codeNorm && rec.codeNorm === qNorm) ||
          (rec.barcodeNorm && rec.barcodeNorm === qNorm)
        ) {
          if (exactBucket.length < maxResults) exactBucket.push(rec.item);
        } else if (
          rec.labelNorm.startsWith(qNorm) ||
          rec.idNorm.startsWith(qNorm) ||
          (rec.codeNorm && rec.codeNorm.startsWith(qNorm))
        ) {
          if (prefixBucket.length < maxResults) prefixBucket.push(rec.item);
        } else if (otherBucket.length < maxResults) {
          otherBucket.push(rec.item);
        }
      }

      const results = [];
      for (let i = 0; i < exactBucket.length && results.length < maxResults; i++) results.push(exactBucket[i]);
      for (let i = 0; i < prefixBucket.length && results.length < maxResults; i++) results.push(prefixBucket[i]);
      for (let i = 0; i < otherBucket.length && results.length < maxResults; i++) results.push(otherBucket[i]);

      renderOptions(results, { total, matchCount });
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
      requestSeq++;
    }

    async function executeAsyncSearch(rawQuery) {
      const q = String(rawQuery ?? '').trim();
      if (q.length < minQueryLength) {
        cancelAsyncPending();
        if (minQueryLength > 0) {
          renderStatusBox(`En az ${minQueryLength} karakter yazın.`);
        } else {
          renderOptions([], { total: 0, matchCount: 0 });
        }
        return;
      }

      if (activeController) {
        try { activeController.abort(); } catch {}
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      activeController = controller;
      const seq = ++requestSeq;

      renderStatusBox(loadingMessage);

      try {
        const result = await provider(q, { signal: controller ? controller.signal : undefined, limit: maxResults });
        if (isDestroyed || seq !== requestSeq || controller?.signal?.aborted) return;

        let rawList = [];
        let total = 0;
        if (Array.isArray(result)) {
          rawList = result;
          total = result.length;
        } else if (result && Array.isArray(result.items)) {
          rawList = result.items;
          total = Number.isFinite(Number(result.total)) ? Number(result.total) : result.items.length;
        }
        const normalized = [];
        for (let i = 0; i < rawList.length; i++) {
          const item = normalizeItem(rawList[i]);
          if (item) {
            normalized.push(item);
            itemMap.set(item.id, item);
          }
        }
        renderOptions(normalized, { total, matchCount: total });
      } catch (err) {
        if (isDestroyed || seq !== requestSeq || controller?.signal?.aborted || err?.name === 'AbortError') return;
        const msg = err && err.message ? String(err.message) : errorMessage;
        renderStatusBox(msg || errorMessage, { isError: true });
      } finally {
        if (activeController === controller) activeController = null;
      }
    }

    function triggerAsyncSearch(rawQuery, { immediate = false } = {}) {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      const q = String(rawQuery ?? '').trim();
      if (q.length < minQueryLength) {
        executeAsyncSearch(rawQuery);
        return;
      }
      if (immediate || debounceMs === 0) {
        executeAsyncSearch(rawQuery);
        return;
      }
      renderStatusBox(loadingMessage);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        executeAsyncSearch(rawQuery);
      }, debounceMs);
    }

    function resolveMountHost() {
      if (mountTarget === 'inline') return rootEl;
      if (mountTarget === 'body') return doc.body || rootEl;
      const dlg = typeof inputEl.closest === 'function' ? inputEl.closest('dialog') : null;
      return dlg || rootEl;
    }

    function positionPanel() {
      const host = panelEl.parentNode;
      if (!host) return;
      if (host === rootEl) {
        panelEl.classList.remove('defter-combobox-panel--portal');
        panelEl.style.left = '';
        panelEl.style.top = '';
        panelEl.style.width = '';
        panelEl.style.bottom = '';
        const rect = controlEl.getBoundingClientRect?.();
        if (rect && rect.width > 0) {
          const vh = root.innerHeight || doc.documentElement?.clientHeight || 768;
          const dropup = vh - rect.bottom < 240 && rect.top > 240;
          rootEl.classList.toggle('defter-combobox--dropup', dropup);
        } else {
          rootEl.classList.remove('defter-combobox--dropup');
        }
        return;
      }

      rootEl.classList.remove('defter-combobox--dropup');
      panelEl.classList.add('defter-combobox-panel--portal');
      const rect = controlEl.getBoundingClientRect?.();
      if (rect && rect.width > 0) {
        const vw = root.innerWidth || doc.documentElement?.clientWidth || 1024;
        const vh = root.innerHeight || doc.documentElement?.clientHeight || 768;
        const width = Math.min(rect.width, vw - 16);
        const left = Math.max(8, Math.min(rect.left, vw - width - 8));
        panelEl.style.width = `${Math.round(width)}px`;
        panelEl.style.left = `${Math.round(left)}px`;
        const panelHeight = Math.min(320, panelEl.offsetHeight || 260);
        if (rect.bottom + 4 + panelHeight > vh - 8 && rect.top - 4 - panelHeight >= 8) {
          panelEl.style.top = `${Math.round(Math.max(8, rect.top - panelHeight - 4))}px`;
        } else {
          panelEl.style.top = `${Math.round(Math.min(vh - 48, rect.bottom + 4))}px`;
        }
      }
    }

    function attachPortalListeners() {
      const dlg = currentPortalDialog;
      if (dlg) {
        dlg.addEventListener('close', onDialogClose);
        dialogScrollBody = dlg.querySelector('.defter-dialog-body');
        if (dialogScrollBody) dialogScrollBody.addEventListener('scroll', onViewportChange, { passive: true });
      }
      if (typeof root.addEventListener === 'function') {
        root.addEventListener('resize', onViewportChange, { passive: true });
        root.addEventListener('popstate', onPopstateClose);
      }
    }

    function detachPortalListeners() {
      if (currentPortalDialog) {
        currentPortalDialog.removeEventListener('close', onDialogClose);
        currentPortalDialog = null;
      }
      if (dialogScrollBody) {
        dialogScrollBody.removeEventListener('scroll', onViewportChange);
        dialogScrollBody = null;
      }
      if (typeof root.removeEventListener === 'function') {
        root.removeEventListener('resize', onViewportChange);
        root.removeEventListener('popstate', onPopstateClose);
      }
    }

    function onDialogClose() {
      close({ restoreText: true });
    }

    function onPopstateClose() {
      close({ restoreText: true });
    }

    function onViewportChange() {
      if (isOpen) positionPanel();
    }

    const pointerEntry = {
      rootEl,
      panelEl,
      wasConnected: false,
      onOutsidePointerDown: () => {
        if (isOpen) close({ validate: true });
      },
      closeOnDetach: () => {
        if (isOpen) close({ restoreText: false, validate: false });
      }
    };

    function open({ searchQuery = null, immediate = false } = {}) {
      if (isDestroyed || inputEl.disabled) return;
      const host = resolveMountHost();
      if (panelEl.parentNode !== host) {
        host.append(panelEl);
      }
      detachPortalListeners();
      currentPortalDialog = host !== rootEl && host.tagName === 'DIALOG' ? host : null;
      attachPortalListeners();

      const reg = getDocPointerReg(doc);
      for (const entry of [...reg.openSet]) {
        if (entry !== pointerEntry && entry.wasConnected && !entry.rootEl.isConnected) {
          reg.openSet.delete(entry);
          entry.closeOnDetach();
        }
      }
      pointerEntry.wasConnected = Boolean(rootEl.isConnected);
      reg.openSet.add(pointerEntry);
      if (!reg.attached) {
        doc.addEventListener('pointerdown', reg.onPointerDown);
        reg.attached = true;
      }

      isOpen = true;
      panelEl.hidden = false;
      inputEl.setAttribute('aria-expanded', 'true');
      toggleBtn.setAttribute('aria-expanded', 'true');

      const q = searchQuery !== null ? searchQuery : inputEl.value;
      if (isAsync) {
        triggerAsyncSearch(q, { immediate });
      } else {
        ensureIndexed();
        const effectiveQuery = q === committedLabel && committedValue !== '' ? '' : q;
        runSyncSearch(effectiveQuery);
      }
      positionPanel();
    }

    function close({ restoreText = false, validate = false } = {}) {
      if (!isOpen && !restoreText && !validate) return;
      isOpen = false;
      const reg = docPointerRegistry.get(doc);
      if (reg) {
        reg.openSet.delete(pointerEntry);
        for (const entry of [...reg.openSet]) {
          if (entry.wasConnected && !entry.rootEl.isConnected) {
            reg.openSet.delete(entry);
            entry.closeOnDetach();
          } else if (entry.rootEl.isConnected) {
            entry.wasConnected = true;
          }
        }
        if (reg.openSet.size === 0 && reg.attached) {
          doc.removeEventListener('pointerdown', reg.onPointerDown);
          reg.attached = false;
        }
      }
      if (isAsync) cancelAsyncPending();
      panelEl.hidden = true;
      inputEl.setAttribute('aria-expanded', 'false');
      toggleBtn.setAttribute('aria-expanded', 'false');
      inputEl.removeAttribute('aria-activedescendant');
      detachPortalListeners();

      if (restoreText) {
        inputEl.value = committedLabel;
        clearValidityState();
      } else if (validate) {
        validateUncommittedText({ report: false });
      }
      syncClearVisibility();
    }

    function commitSelection(item, { source = 'user', emitChange = true } = {}) {
      if (!item || item.disabled) return false;
      const prevValue = committedValue;
      committedValue = item.id;
      committedItem = item;
      if (itemMap) itemMap.set(item.id, item);
      committedLabel = String(formatSelectedText(item) ?? item.label);
      inputEl.value = committedLabel;
      clearValidityState();
      syncClearVisibility();
      if (emitChange) {
        onSelect?.(item, { source });
        if (prevValue !== committedValue || source === 'pointer' || source === 'keyboard') {
          onChange?.(committedValue, committedItem, { source });
        }
      }
      return true;
    }

    function clear({ emitChange = true, source = 'clear' } = {}) {
      const prevValue = committedValue;
      committedValue = '';
      committedItem = null;
      committedLabel = '';
      inputEl.value = '';
      clearValidityState();
      syncClearVisibility();
      if (isAsync) cancelAsyncPending();
      if (isOpen) {
        if (isAsync) {
          if (minQueryLength > 0) renderStatusBox(`En az ${minQueryLength} karakter yazın.`);
          else renderOptions([], { total: 0, matchCount: 0 });
        } else {
          runSyncSearch('');
        }
      }
      if (emitChange && prevValue !== '') {
        onChange?.('', null, { source });
      }
    }

    function validateUncommittedText({ report = false } = {}) {
      const raw = inputEl.value;
      const trimmed = raw.trim();
      if (trimmed === '') {
        if (allowEmpty) {
          if (committedValue !== '') clear({ emitChange: true, source: 'empty' });
          else {
            inputEl.value = '';
            clearValidityState();
          }
          return true;
        }
        if (invalidTextBehavior === 'revert') {
          inputEl.value = committedLabel;
          clearValidityState();
          return true;
        }
        setInvalidTextError({ report });
        return false;
      }

      if (raw === committedLabel && (committedValue !== '' || !trimmed)) {
        clearValidityState();
        return true;
      }

      if (invalidTextBehavior === 'revert') {
        inputEl.value = committedLabel;
        clearValidityState();
        return true;
      }

      setInvalidTextError({ report });
      return false;
    }

    function setValue(nextId, { emitChange = false, item = null, allowDisabled = false } = {}) {
      const id = nextId === null || nextId === undefined ? '' : String(nextId);
      if (id === '') {
        clear({ emitChange, source: 'programmatic' });
        return true;
      }
      let target = item ? normalizeItem(item) : findItemById(id);
      if (target) {
        if (target.disabled && !allowDisabled) return false;
        if (itemMap) itemMap.set(target.id, target);
      } else {
        return false;
      }
      const prev = committedValue;
      committedValue = target.id;
      committedItem = target;
      committedLabel = String(formatSelectedText(target) ?? target.label);
      inputEl.value = committedLabel;
      clearValidityState();
      syncClearVisibility();
      if (emitChange && prev !== committedValue) {
        onChange?.(committedValue, committedItem, { source: 'programmatic' });
      }
      return true;
    }

    function onInput() {
      if (inputEl.disabled) return;
      clearValidityState();
      syncClearVisibility();
      const val = inputEl.value;
      onQuery?.(val);
      if (!isOpen) {
        if (isAsync && val.trim().length < minQueryLength) return;
        open({ searchQuery: val });
        return;
      }
      if (isAsync) {
        triggerAsyncSearch(val);
      } else {
        runSyncSearch(val);
      }
    }

    function onFocus() {
      if (inputEl.disabled) return;
      if (openOnFocus && !isOpen) {
        open();
      }
    }

    function onKeydown(event) {
      if (inputEl.disabled) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!isOpen) {
          open({ immediate: true });
          return;
        }
        const nextIdx = stepEnabledIndex(activeIndex, 1);
        if (nextIdx >= 0) updateActiveDom(nextIdx);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen) {
          open({ immediate: true });
          return;
        }
        const prevIdx = stepEnabledIndex(activeIndex, -1);
        if (prevIdx >= 0) updateActiveDom(prevIdx);
        return;
      }
      if (event.key === 'Home' && isOpen) {
        event.preventDefault();
        const idx = firstEnabledIndex();
        if (idx >= 0) updateActiveDom(idx);
        return;
      }
      if (event.key === 'End' && isOpen) {
        event.preventDefault();
        const idx = lastEnabledIndex();
        if (idx >= 0) updateActiveDom(idx);
        return;
      }
      if (event.key === 'Enter') {
        if (isOpen) {
          event.preventDefault();
          if (activeIndex >= 0 && renderedItems[activeIndex] && !renderedItems[activeIndex].disabled) {
            commitSelection(renderedItems[activeIndex], { source: 'keyboard' });
            close({ restoreText: false });
          } else if (activeIndex < 0 && allowEmpty && inputEl.value.trim() === '') {
            if (committedValue !== '') clear({ emitChange: true, source: 'keyboard' });
            close({ restoreText: false });
          }
          return;
        }
        if (inputEl.value.trim() === '' && allowEmpty) {
          if (committedValue !== '') clear({ emitChange: true, source: 'keyboard' });
          return;
        }
        if (inputEl.value !== committedLabel) {
          event.preventDefault();
          validateUncommittedText({ report: true });
        }
        return;
      }
      if (event.key === 'Escape') {
        if (isOpen) {
          event.preventDefault();
          event.stopPropagation();
          close({ restoreText: true });
        }
        return;
      }
      if (event.key === 'Tab') {
        if (isOpen) {
          close({ validate: true });
        }
      }
    }

    function onBlur(event) {
      const related = event.relatedTarget;
      if (related && (rootEl.contains(related) || panelEl.contains(related))) return;
      if (isOpen) close({ validate: true });
      else validateUncommittedText({ report: false });
    }

    function onClearMousedown(event) {
      event.preventDefault();
    }

    function onClearClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (inputEl.disabled) return;
      clear({ emitChange: true, source: 'clear' });
      inputEl.focus({ preventScroll: true });
    }

    function onToggleMousedown(event) {
      event.preventDefault();
    }

    function onToggleClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (inputEl.disabled) return;
      if (isOpen) {
        close({ restoreText: true });
      } else {
        open({ immediate: true });
        inputEl.focus({ preventScroll: true });
      }
    }

    function onRootClick(event) {
      if (event.target === inputEl || event.target === clearBtn || event.target === toggleBtn) return;
      if (panelEl.contains(event.target)) return;
      event.preventDefault();
    }

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('focus', onFocus);
    inputEl.addEventListener('keydown', onKeydown);
    inputEl.addEventListener('blur', onBlur);
    clearBtn.addEventListener('mousedown', onClearMousedown);
    clearBtn.addEventListener('click', onClearClick);
    toggleBtn.addEventListener('mousedown', onToggleMousedown);
    toggleBtn.addEventListener('click', onToggleClick);
    rootEl.addEventListener('click', onRootClick);

    setItems(initialItems);
    if (initialValue !== '' && initialValue !== null && initialValue !== undefined) {
      setValue(initialValue, { emitChange: false, allowDisabled: Boolean(options.allowDisabled) });
    } else {
      syncClearVisibility();
    }

    const instance = {
      root: rootEl,
      input: inputEl,
      panel: panelEl,
      listbox: listboxEl,
      statusEl,
      getValue: () => committedValue,
      getSelectedItem: () => committedItem,
      hasValue: id => rawHasId(id),
      setValue,
      setItems,
      setDisabled: next => {
        inputEl.disabled = Boolean(next);
        if (inputEl.disabled && isOpen) close({ restoreText: true });
        syncClearVisibility();
      },
      setRequired: next => {
        inputEl.required = Boolean(next);
        if (!inputEl.required && inputEl.value === committedLabel) {
          clearValidityState();
        }
      },
      open: () => open({ immediate: true }),
      close: opts => close(opts),
      focus: () => inputEl.focus({ preventScroll: true }),
      clear: opts => clear(opts),
      refresh: () => {
        if (isOpen) {
          if (isAsync) triggerAsyncSearch(inputEl.value, { immediate: true });
          else runSyncSearch(inputEl.value === committedLabel && committedValue !== '' ? '' : inputEl.value);
        }
      },
      getCounts: () => ({
        visible: renderedItems.length,
        matched: lastMatchCount,
        total: lastTotalCount
      }),
      destroy: () => {
        if (isDestroyed) return;
        isDestroyed = true;
        isOpen = false;
        const reg = docPointerRegistry.get(doc);
        if (reg) {
          reg.openSet.delete(pointerEntry);
          if (reg.openSet.size === 0 && reg.attached) {
            doc.removeEventListener('pointerdown', reg.onPointerDown);
            reg.attached = false;
          }
        }
        cancelAsyncPending();
        detachPortalListeners();
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('focus', onFocus);
        inputEl.removeEventListener('keydown', onKeydown);
        inputEl.removeEventListener('blur', onBlur);
        clearBtn.removeEventListener('mousedown', onClearMousedown);
        clearBtn.removeEventListener('click', onClearClick);
        toggleBtn.removeEventListener('mousedown', onToggleMousedown);
        toggleBtn.removeEventListener('click', onToggleClick);
        rootEl.removeEventListener('click', onRootClick);
        instancesByEl.delete(rootEl);
        instancesByEl.delete(inputEl);
        instancesByEl.delete(panelEl);
        instancesByEl.delete(listboxEl);
        rawItems = [];
        indexedItems = null;
        if (itemMap) itemMap.clear();
        renderedItems = [];
        optionButtons = [];
        committedItem = null;
        if (panelEl.parentNode) panelEl.remove();
        if (!existingInput && rootEl.parentNode) rootEl.remove();
      }
    };

    instancesByEl.set(rootEl, instance);
    instancesByEl.set(inputEl, instance);
    instancesByEl.set(panelEl, instance);
    instancesByEl.set(listboxEl, instance);

    return instance;
  }

  function readOptionsFromSelect(selectEl) {
    const items = [];
    let emptyLabel = 'Seçilmedi';
    let hasEmpty = false;
    const opts = selectEl.options || [];
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i];
      if (opt.value === '') {
        hasEmpty = true;
        emptyLabel = opt.textContent.trim() || emptyLabel;
        continue;
      }
      const ds = opt.dataset || {};
      items.push({
        id: opt.value,
        label: opt.textContent.trim(),
        unit: ds.unit || '',
        subtitle: ds.subtitle || '',
        meta: ds.meta || '',
        phone: ds.phone || '',
        taxId: ds.taxId || '',
        code: ds.code || '',
        barcode: ds.barcode || '',
        badge: ds.badge || '',
        disabled: Boolean(opt.disabled),
        retired: ds.retired === 'true',
        disabledReason: ds.disabledReason || '',
        keywords: ds.keywords || '',
        dataset: { ...ds }
      });
    }
    return { items, emptyLabel, hasEmpty };
  }

  function buildOptionElement(doc, item, selected) {
    const opt = doc.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    if (item.disabled) opt.disabled = true;
    if (selected) opt.selected = true;
    const ds = item.raw?.dataset || item.dataset;
    if (ds) {
      for (const [k, v] of Object.entries(ds)) {
        if (v !== undefined) opt.dataset[k] = v;
      }
    }
    if (item.code && !opt.dataset.code) opt.dataset.code = item.code;
    if (item.unit && !opt.dataset.unit) opt.dataset.unit = item.unit;
    return opt;
  }

  function enhanceSelect(selectEl, options = {}) {
    if (!selectEl) return null;
    const existing = instancesByEl.get(selectEl);
    if (existing) return existing;

    const doc = selectEl.ownerDocument || document;
    const HTMLSelectProto = (doc.defaultView && doc.defaultView.HTMLSelectElement && doc.defaultView.HTMLSelectElement.prototype)
      || (typeof HTMLSelectElement !== 'undefined' ? HTMLSelectElement.prototype : null);
    const descs = ensureSelectProtoPatched(HTMLSelectProto);
    const valueDesc = descs?.valueDesc || null;

    const getNativeValue = () => (valueDesc && valueDesc.get ? valueDesc.get.call(selectEl) : selectEl.value);
    const setNativeValue = val => {
      if (valueDesc && valueDesc.set) valueDesc.set.call(selectEl, val);
    };

    const smallListThreshold = options.smallListThreshold !== undefined ? Number(options.smallListThreshold) : DEFAULT_SMALL_LIST_THRESHOLD;
    const maxNativeOptions = options.maxNativeOptions !== undefined ? Math.max(1, Number(options.maxNativeOptions)) : DEFAULT_MAX_NATIVE_OPTIONS;
    const forwardSelectFocus = options.forwardSelectFocus !== undefined ? Boolean(options.forwardSelectFocus) : true;
    const syncOnChange = options.syncOnChange !== undefined ? Boolean(options.syncOnChange) : true;

    const isAsync = typeof options.provider === 'function';
    const initialChildNodes = !Array.isArray(options.items) && !isAsync
      ? [...selectEl.childNodes].map(node => node.cloneNode(true))
      : null;

    const parsed = readOptionsFromSelect(selectEl);
    const initialItems = Array.isArray(options.items) ? options.items : parsed.items;
    const initialValue = options.value !== undefined ? String(options.value ?? '') : getNativeValue();

    let resolvedLabel = options.label || selectEl.getAttribute('aria-label') || '';
    if (!resolvedLabel) {
      const parentLabel = typeof selectEl.closest === 'function' ? selectEl.closest('label') : null;
      if (parentLabel) {
        const labelSpan = parentLabel.querySelector('span, .field-label');
        if (labelSpan) resolvedLabel = labelSpan.textContent.trim();
      }
    }

    selectEl.classList.add('defter-combobox-native');
    const prevTabIndex = selectEl.getAttribute('tabindex');
    const prevAriaHidden = selectEl.getAttribute('aria-hidden');
    selectEl.tabIndex = -1;
    selectEl.setAttribute('aria-hidden', 'true');

    let syncingSelect = false;
    let itemsReplaced = false;
    let destroyed = false;
    let currentItems = initialItems;
    const allowEmpty = options.allowEmpty !== undefined ? Boolean(options.allowEmpty) : (parsed.hasEmpty || initialValue === '');
    const emptyLabel = options.emptyLabel || parsed.emptyLabel;

    const combobox = create({
      ...options,
      label: resolvedLabel,
      items: initialItems,
      value: initialValue,
      allowEmpty,
      emptyLabel,
      required: options.required !== undefined ? Boolean(options.required) : Boolean(selectEl.required),
      disabled: options.disabled !== undefined ? Boolean(options.disabled) : Boolean(selectEl.disabled),
      _backingSelect: selectEl,
      onChange: (val, item, meta) => {
        if (!syncingSelect) {
          syncSelectOptions(val, item);
          if (syncOnChange && meta?.source !== 'select-sync') {
            syncingSelect = true;
            try {
              const Ev = doc.defaultView?.Event || Event;
              selectEl.dispatchEvent(new Ev('change', { bubbles: true }));
            } finally {
              syncingSelect = false;
            }
          }
        }
        options.onChange?.(val, item, meta);
      }
    });

    selectEl.after(combobox.root);

    function syncSelectOptions(targetValue = combobox.getValue(), targetItem = combobox.getSelectedItem()) {
      const useCompactSelect = isAsync || currentItems.length > smallListThreshold;
      const frag = doc.createDocumentFragment();
      let count = 0;

      if (allowEmpty && (!useCompactSelect || count < maxNativeOptions)) {
        const emptyOpt = doc.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = emptyLabel;
        if (targetValue === '') emptyOpt.selected = true;
        frag.append(emptyOpt);
        count++;
      }

      if (useCompactSelect) {
        if (targetValue !== '') {
          let chosen = targetItem;
          if (!chosen) {
            const raw = currentItems.find(it => String(it?.id ?? it?.value ?? '') === targetValue);
            if (raw) chosen = normalizeItem(raw);
          }
          if (chosen) {
            frag.append(buildOptionElement(doc, chosen, true));
          }
        }
        selectEl.replaceChildren(frag);
        setNativeValue(targetValue);
        return;
      }

      for (let i = 0; i < currentItems.length; i++) {
        const norm = normalizeItem(currentItems[i]);
        if (!norm) continue;
        frag.append(buildOptionElement(doc, norm, norm.id === targetValue));
      }
      selectEl.replaceChildren(frag);
      setNativeValue(targetValue);
    }

    syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());

    selectHooks.set(selectEl, {
      onValueSet(nextVal, nativeSetter) {
        const id = nextVal === null || nextVal === undefined ? '' : String(nextVal);
        if (id === '' && allowEmpty) {
          syncingSelect = true;
          try {
            combobox.setValue('', { emitChange: false });
            syncSelectOptions('', null);
          } finally {
            syncingSelect = false;
          }
        } else if (id !== '' && combobox.hasValue(id)) {
          syncingSelect = true;
          try {
            const accepted = combobox.setValue(id, { emitChange: false });
            syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
            if (!accepted) return;
          } finally {
            syncingSelect = false;
          }
        } else {
          nativeSetter.call(selectEl, id);
          if (getNativeValue() !== combobox.getValue()) {
            syncingSelect = true;
            try {
              const actual = getNativeValue();
              if (actual === '' && allowEmpty) {
                combobox.clear({ emitChange: false });
                syncSelectOptions('', null);
              } else if (actual === '' && !allowEmpty && combobox.getValue() !== '') {
                syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
              }
            } finally {
              syncingSelect = false;
            }
          }
        }
      },
      onDisabledSet(nextVal) {
        combobox.setDisabled(Boolean(nextVal));
      },
      onRequiredSet(nextVal) {
        combobox.setRequired(Boolean(nextVal));
      }
    });

    const MutationObs = doc.defaultView?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    let observer = null;
    if (MutationObs) {
      observer = new MutationObs(() => {
        combobox.setDisabled(Boolean(selectEl.disabled));
        combobox.setRequired(Boolean(selectEl.required));
      });
      observer.observe(selectEl, { attributes: true, attributeFilter: ['disabled', 'required'] });
    }

    function onSelectChange() {
      if (syncingSelect) return;
      const val = getNativeValue();
      syncingSelect = true;
      try {
        const ok = combobox.setValue(val, { emitChange: false });
        if (!ok) syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
      } finally {
        syncingSelect = false;
      }
    }

    function onSelectFocus() {
      if (destroyed || syncingSelect) return;
      combobox.input.focus({ preventScroll: true });
    }

    function onSelectInvalid(event) {
      event?.preventDefault?.();
      const msg = selectEl.validationMessage || INVALID_TEXT_MSG;
      if (typeof combobox.input.setCustomValidity === 'function') combobox.input.setCustomValidity(msg);
      combobox.input.setAttribute('aria-invalid', 'true');
      combobox.focus();
      const defer = typeof queueMicrotask === 'function' ? queueMicrotask : fn => Promise.resolve().then(fn);
      defer(() => {
        if (!destroyed && doc.activeElement === selectEl) {
          combobox.input.focus({ preventScroll: true });
        }
      });
    }

    const origFocus = selectEl.focus;
    if (forwardSelectFocus) {
      selectEl.focus = function forwardedFocus(opts) {
        combobox.input.focus(opts);
      };
      selectEl.addEventListener('focus', onSelectFocus);
    }

    selectEl.addEventListener('change', onSelectChange);
    selectEl.addEventListener('invalid', onSelectInvalid);

    const enhanced = {
      ...combobox,
      select: selectEl,
      setItems: nextItems => {
        itemsReplaced = true;
        currentItems = Array.isArray(nextItems) ? nextItems : [];
        combobox.setItems(currentItems);
        syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
      },
      setValue: (id, opts = {}) => {
        const ok = combobox.setValue(id, opts);
        if (ok) syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
        return ok;
      },
      clear: opts => {
        combobox.clear(opts);
        syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
      },
      syncFromSelect: () => {
        itemsReplaced = true;
        const reread = readOptionsFromSelect(selectEl);
        currentItems = reread.items;
        combobox.setItems(currentItems);
        combobox.setDisabled(Boolean(selectEl.disabled));
        combobox.setRequired(Boolean(selectEl.required));
        const val = getNativeValue();
        combobox.setValue(val, { emitChange: false, allowDisabled: Boolean(options.allowDisabled) });
        syncSelectOptions(combobox.getValue(), combobox.getSelectedItem());
      },
      destroy: ({ restoreOptions = true } = {}) => {
        if (destroyed) return;
        destroyed = true;
        const committedVal = combobox.getValue();
        observer?.disconnect();
        selectEl.removeEventListener('change', onSelectChange);
        selectEl.removeEventListener('invalid', onSelectInvalid);
        if (forwardSelectFocus) {
          selectEl.removeEventListener('focus', onSelectFocus);
          if (Object.hasOwn(selectEl, 'focus')) delete selectEl.focus;
          else selectEl.focus = origFocus;
        }
        selectHooks.delete(selectEl);
        if (restoreOptions !== false) {
          if (initialChildNodes && !itemsReplaced) {
            selectEl.replaceChildren(...initialChildNodes);
            setNativeValue(committedVal);
          } else if (currentItems.length > smallListThreshold || (isAsync && currentItems.length > 0)) {
            const frag = doc.createDocumentFragment();
            if (allowEmpty) {
              const emptyOpt = doc.createElement('option');
              emptyOpt.value = '';
              emptyOpt.textContent = emptyLabel;
              if (committedVal === '') emptyOpt.selected = true;
              frag.append(emptyOpt);
            }
            for (let i = 0; i < currentItems.length; i++) {
              const norm = normalizeItem(currentItems[i]);
              if (!norm) continue;
              frag.append(buildOptionElement(doc, norm, norm.id === committedVal));
            }
            selectEl.replaceChildren(frag);
            setNativeValue(committedVal);
          }
        }
        currentItems = [];
        if (initialChildNodes) initialChildNodes.length = 0;
        selectEl.classList.remove('defter-combobox-native');
        if (prevTabIndex === null) selectEl.removeAttribute('tabindex');
        else selectEl.setAttribute('tabindex', prevTabIndex);
        if (prevAriaHidden === null) selectEl.removeAttribute('aria-hidden');
        else selectEl.setAttribute('aria-hidden', prevAriaHidden);
        instancesByEl.delete(selectEl);
        instancesByEl.delete(combobox.root);
        instancesByEl.delete(combobox.input);
        instancesByEl.delete(combobox.panel);
        instancesByEl.delete(combobox.listbox);
        combobox.destroy();
      }
    };

    instancesByEl.set(selectEl, enhanced);
    instancesByEl.set(combobox.root, enhanced);
    instancesByEl.set(combobox.input, enhanced);
    instancesByEl.set(combobox.panel, enhanced);
    instancesByEl.set(combobox.listbox, enhanced);

    return enhanced;
  }

  function getInstance(el) {
    return el ? (instancesByEl.get(el) || null) : null;
  }

  const exportsObj = {
    create,
    enhanceSelect,
    getInstance
  };

  root.DefterCombobox = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterCombobox = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
