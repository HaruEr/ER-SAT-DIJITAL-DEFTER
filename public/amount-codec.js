(root => {
  const KNOWN_UNITS = {
    TL: { scale: 100, digits: 2, label: 'TL' },
    USD: { scale: 100, digits: 2, label: 'USD' },
    EUR: { scale: 100, digits: 2, label: 'EUR' },
    GRAM: { scale: 1000, digits: 3, label: 'gr' },
    HAS: { scale: 1000, digits: 3, label: 'has gr' },
    SILVER: { scale: 1000, digits: 3, label: 'saf gümüş gr' },
    ADET: { scale: 1, digits: 0, label: 'adet' }
  };

  const units = new Proxy(KNOWN_UNITS, {
    get: (known, code) => Object.hasOwn(known, code) ? known[code] : { scale: 100, digits: 2, label: String(code) }
  });

  function formatAmount(value, unit = 'TL') {
    const spec = units[unit];
    return `${new Intl.NumberFormat('tr-TR', {
      minimumFractionDigits: spec.digits,
      maximumFractionDigits: spec.digits
    }).format((value || 0) / spec.scale)} ${spec.label}`;
  }

  function canonicalFromScaled(scaled, unit = 'TL') {
    const spec = units[unit];
    return (scaled / spec.scale).toFixed(spec.digits);
  }

  function buildScaled(wholeStr, fracStr, spec, positive, allowZero) {
    if (fracStr.length > spec.digits) {
      return {
        status: 'invalid',
        reason: spec.digits === 0
          ? 'Bu alanda ondalık kullanılamaz; tam sayı girin.'
          : `${spec.label} için en fazla ${spec.digits} ondalık basamak kullanın.`
      };
    }
    const normWhole = wholeStr.replace(/^0+(?=\d)/, '');
    if (normWhole.length > 13) {
      return { status: 'invalid', reason: 'Miktar izin verilen üst sınırı (1e12) aşıyor.' };
    }
    const whole = Number(normWhole);
    const frac = spec.digits === 0 ? 0 : Number(fracStr.padEnd(spec.digits, '0'));
    const scaled = whole * spec.scale + frac;
    if (!Number.isSafeInteger(scaled) || scaled > 1e12) {
      return { status: 'invalid', reason: 'Miktar izin verilen üst sınırı (1e12) aşıyor.' };
    }
    if ((!allowZero && scaled === 0) || (positive && scaled <= 0)) {
      return { status: 'invalid', reason: 'Miktar sıfırdan büyük olmalıdır.' };
    }
    const canonical = spec.digits === 0
      ? String(whole)
      : fracStr.length ? `${normWhole}.${fracStr}` : normWhole;
    return { status: 'valid', canonical, scaled };
  }

  function parseUnsignedAmount(text, unit = 'TL', { positive = false, allowZero = true, resolution = null } = {}) {
    const spec = units[unit];
    if (!/^[\d.,]+$/.test(text)) {
      return { status: 'invalid', reason: `Geçersiz miktar biçimi (${unit}). Örnek: 10.000,50 veya 10500.` };
    }

    let wholeStr = '';
    let fracStr = '';

    // 1. Single dot with exactly 3 trailing digits: 10.500 (thousands vs 3-decimal ambiguity)
    if (/^[1-9]\d{0,2}\.\d{3}$/.test(text)) {
      const [left, right] = text.split('.');
      if (spec.digits === 3) {
        const asThousands = buildScaled(left + right, '', spec, positive, allowZero);
        const asDecimal = buildScaled(left, right, spec, positive, allowZero);
        if (resolution === 'thousands') {
          if (asThousands.status !== 'valid') return asThousands;
          return { ...asThousands, formatted: formatAmount(asThousands.scaled, unit) };
        }
        if (resolution === 'decimal') {
          if (asDecimal.status !== 'valid') return asDecimal;
          return { ...asDecimal, formatted: formatAmount(asDecimal.scaled, unit) };
        }
        if (asThousands.status === 'valid' && asDecimal.status === 'valid') {
          return {
            status: 'ambiguous',
            reason: `${text} girişi belirsiz: on bin beş yüz (${formatAmount(asThousands.scaled, unit)}) mü, ondalık (${formatAmount(asDecimal.scaled, unit)}) mı?`,
            options: [
              { choice: 'thousands', canonical: asThousands.canonical, scaled: asThousands.scaled, formatted: formatAmount(asThousands.scaled, unit) },
              { choice: 'decimal', canonical: asDecimal.canonical, scaled: asDecimal.scaled, formatted: formatAmount(asDecimal.scaled, unit) }
            ]
          };
        }
        const fallback = asThousands.status === 'valid' ? asThousands : asDecimal;
        return fallback.status === 'valid' ? { ...fallback, formatted: formatAmount(fallback.scaled, unit) } : fallback;
      }
      // For TL / FX (digits: 2) or ADET (digits: 0), 10.500 is unambiguously Turkish thousands (10500).
      wholeStr = left + right;
      fracStr = '';
    } else if (/^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?$/.test(text)) {
      // 2. Turkish grouped thousands + optional comma decimal: 10.000,50 or 1.250.000
      const [intPart, decPart = ''] = text.split(',');
      wholeStr = intPart.replace(/\./g, '');
      fracStr = decPart;
    } else if (/^\d+,\d+$/.test(text)) {
      // 3. Plain comma decimal: 10,500 or 10,5
      [wholeStr, fracStr] = text.split(',');
    } else if (/^\d+\.\d{1,3}$/.test(text)) {
      // 4. Single dot with 1 to 3 digits: 0.500, 1000.500, 10.5 or 10.25 -> decimal
      [wholeStr, fracStr] = text.split('.');
    } else if (/^\d+$/.test(text)) {
      // 5. Plain integer: 10500
      wholeStr = text;
      fracStr = '';
    } else {
      return { status: 'invalid', reason: `Geçersiz miktar biçimi (${unit}). Örnek: 10.000,50 veya 10500.` };
    }

    const built = buildScaled(wholeStr, fracStr, spec, positive, allowZero);
    if (built.status !== 'valid') return built;
    return { ...built, formatted: formatAmount(built.scaled, unit) };
  }

  function parseUserAmount(rawValue, unit = 'TL', { positive = false, allowZero = true, signed = false, resolution = null } = {}) {
    const text = String(rawValue ?? '').trim();
    if (!text) return { status: 'empty', scaled: null };
    if (text.startsWith('-')) {
      if (!signed) {
        return { status: 'invalid', reason: 'Yalnızca pozitif rakam, nokta ve virgül kullanın.' };
      }
      if (positive) {
        return { status: 'invalid', reason: 'Miktar sıfırdan büyük olmalıdır.' };
      }
      const unsigned = text.slice(1);
      if (!unsigned || /^\s/.test(unsigned)) {
        return { status: 'invalid', reason: 'Geçerli bir miktar girin.' };
      }
      const res = parseUnsignedAmount(unsigned, unit, { positive: false, allowZero, resolution });
      if (res.status === 'valid') {
        const scaled = res.scaled === 0 ? 0 : -res.scaled;
        const canonical = res.scaled === 0 ? res.canonical : `-${res.canonical}`;
        return { status: 'valid', canonical, scaled, formatted: formatAmount(scaled, unit) };
      }
      if (res.status === 'ambiguous') {
        const options = res.options.map(opt => {
          const negScaled = opt.scaled === 0 ? 0 : -opt.scaled;
          return {
            choice: opt.choice,
            canonical: opt.scaled === 0 ? opt.canonical : `-${opt.canonical}`,
            scaled: negScaled,
            formatted: formatAmount(negScaled, unit)
          };
        });
        return {
          status: 'ambiguous',
          reason: `${text} girişi belirsiz: ${options[0].formatted} mü, ${options[1].formatted} mı?`,
          options
        };
      }
      return res;
    }
    if (!/^[\d.,]+$/.test(text)) {
      return { status: 'invalid', reason: 'Yalnızca pozitif rakam, nokta ve virgül kullanın.' };
    }
    return parseUnsignedAmount(text, unit, { positive, allowZero, resolution });
  }

  function clearDisambiguation(input) {
    const container = input.closest('label, .field, td, div') || input.parentElement;
    container?.querySelector(':scope > .amount-disambiguation')?.remove();
  }

  function renderDisambiguation(input, result, unit = 'TL') {
    const container = input.closest('label, .field, td, div') || input.parentElement;
    if (!container) return;
    const sig = JSON.stringify([
      unit,
      String(input.value ?? '').trim(),
      result.options.map(o => [o.choice, o.formatted])
    ]);
    let box = container.querySelector(':scope > .amount-disambiguation');
    if (
      box &&
      box.dataset.disambigKey === sig &&
      box.querySelectorAll('[data-amount-choice]').length === result.options.length
    ) {
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'amount-disambiguation';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Miktar netleştirme');
      input.after(box);
    }
    box.dataset.disambigKey = sig;
    box.innerHTML = '';
    const prompt = document.createElement('small');
    prompt.textContent = 'Bu miktarı nasıl yorumlayalım?';
    box.append(prompt);
    for (const option of result.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button secondary compact';
      btn.dataset.amountChoice = option.choice;
      btn.textContent = option.formatted;
      btn.addEventListener('mousedown', event => {
        event.preventDefault();
      });
      btn.addEventListener('click', () => {
        input.dataset.amountResolution = option.choice;
        input.dataset.canonicalAmount = option.canonical;
        input.setCustomValidity('');
        clearDisambiguation(input);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      box.append(btn);
    }
  }

  function normalizeInputOptions(positive = false, options = {}) {
    if (positive && typeof positive === 'object') {
      const pos = Boolean(positive.positive);
      return {
        positive: pos,
        allowZero: positive.allowZero !== undefined ? Boolean(positive.allowZero) : !pos,
        signed: Boolean(positive.signed)
      };
    }
    const opts = options && typeof options === 'object' ? options : {};
    const pos = Boolean(positive);
    return {
      positive: pos,
      allowZero: opts.allowZero !== undefined ? Boolean(opts.allowZero) : !pos,
      signed: Boolean(opts.signed)
    };
  }

  function isMoneyUnit(unit) {
    if (!unit) return false;
    const u = String(unit);
    if (['GRAM', 'HAS', 'SILVER', 'ADET', 'RATE'].includes(u)) return false;
    return units[u].digits === 2;
  }

  function formatLiveMoneyValue(raw, cursorPos = null, { treatDotAsDecimal = false } = {}) {
    const str = String(raw ?? '');
    if (!str) return { value: '', cursor: 0 };
    const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? Math.min(cursorPos, str.length) : str.length;
    const isNeg = str.startsWith('-');
    const rawBody = isNeg ? str.slice(1) : str;
    const bodyPos = isNeg ? Math.max(0, pos - 1) : pos;

    // Prevent 100x inflation on canonical dot-decimal values (e.g. "100000.00", "0.50", or pasted "12.50")
    // while preserving Turkish backspace safety ("1.000" -> "1.00" => "100", "10.000" -> "10.00" => "1.000").
    let body = rawBody;
    if (!rawBody.includes(',') && /^\d+\.\d{1,2}$/.test(rawBody)) {
      const [dotInt] = rawBody.split('.');
      if (treatDotAsDecimal || dotInt.length >= 4 || dotInt === '0') {
        body = rawBody.replace('.', ',');
      }
    }

    // Count meaningful characters (digits + first comma) before cursor
    let commaSeenBefore = false;
    let meaningfulBefore = 0;
    for (let i = 0; i < bodyPos; i++) {
      const ch = body[i];
      if (ch >= '0' && ch <= '9') meaningfulBefore++;
      else if (ch === ',' && !commaSeenBefore) { commaSeenBefore = true; meaningfulBefore++; }
    }

    // Split on first comma: integer part strips dots/non-digits, frac part keeps max 2 digits
    const commaIdx = body.indexOf(',');
    const hasComma = commaIdx !== -1;
    const rawInt = (hasComma ? body.slice(0, commaIdx) : body).replace(/\D/g, '');
    const rawFrac = hasComma ? body.slice(commaIdx + 1).replace(/\D/g, '').slice(0, 2) : '';

    // Normalize leading zeros in integer part (keep single '0' if followed by comma or if all zeros)
    const cleanInt = rawInt.length > 1 ? rawInt.replace(/^0+(?=\d)/, '') : rawInt;
    const groupedInt = cleanInt.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const formattedBody = hasComma ? `${groupedInt || (rawInt ? '0' : '')},${rawFrac}` : groupedInt;
    const finalValue = (isNeg ? '-' : '') + formattedBody;

    // Map meaningfulBefore back to new cursor index
    let count = 0;
    let newCursor = isNeg ? 1 : 0;
    if (meaningfulBefore === 0) {
      newCursor = isNeg && pos > 0 ? 1 : 0;
    } else {
      for (let i = 0; i < formattedBody.length; i++) {
        const ch = formattedBody[i];
        if ((ch >= '0' && ch <= '9') || ch === ',') {
          count++;
          if (count >= meaningfulBefore) {
            newCursor = (isNeg ? 1 : 0) + i + 1;
            break;
          }
        }
      }
      if (count < meaningfulBefore) newCursor = finalValue.length;
    }
    return { value: finalValue, cursor: newCursor };
  }

  function applyLiveMoneyGrouping(input, unit, options = {}) {
    if (!input || !isMoneyUnit(unit)) return false;
    const raw = input.value;
    if (!raw) return false;
    let start = null;
    try { start = input.selectionStart; } catch {}
    const { value, cursor } = formatLiveMoneyValue(raw, start, options);
    if (value === raw) return false;
    input.value = value;
    try {
      if (typeof input.setSelectionRange === 'function' && document?.activeElement === input) {
        input.setSelectionRange(cursor, cursor);
      }
    } catch {}
    return true;
  }

  function setFormattedInputValue(input, value, unit = 'TL') {
    if (!input) return '';
    clearInputState(input);
    if (input.dataset && unit) input.dataset.amountUnit = String(unit);
    if (value === null || value === undefined || value === '') {
      input.value = '';
      return '';
    }
    const spec = units[unit];
    const canonicalStr = typeof value === 'number' && Number.isFinite(value)
      ? canonicalFromScaled(value, unit)
      : String(value).trim();
    if (!canonicalStr) {
      input.value = '';
      return '';
    }
    let formatted;
    if (isMoneyUnit(unit)) {
      formatted = formatLiveMoneyValue(canonicalStr, null, { treatDotAsDecimal: true }).value;
    } else if (spec.digits === 0) {
      formatted = canonicalStr.replace(/[.,].*$/, '');
    } else {
      formatted = canonicalStr.replace('.', ',');
    }
    input.value = formatted;
    return formatted;
  }

  function attachMoneyGrouping(input, unitOrGetter) {
    if (!input || input.dataset?.moneyGroupingBound === '1') return;
    if (input.dataset) input.dataset.moneyGroupingBound = '1';
    const resolveUnit = () => (typeof unitOrGetter === 'function' ? unitOrGetter() : (unitOrGetter || input.dataset?.amountUnit || ''));
    input.addEventListener('keydown', event => {
      const u = resolveUnit();
      if (isMoneyUnit(u) && event.key === '.') {
        event.preventDefault();
      }
    });
    input.addEventListener('input', () => {
      const u = resolveUnit();
      if (isMoneyUnit(u)) applyLiveMoneyGrouping(input, u);
    });
  }

  function parseInputElement(input, unit = 'TL', positive = false, options = {}) {
    if (!input) return null;
    if (input.dataset) input.dataset.amountUnit = unit;
    const normOpts = normalizeInputOptions(positive, options);
    const resolution = input.dataset?.amountResolution || null;
    const result = parseUserAmount(input.value, unit, {
      positive: normOpts.positive,
      allowZero: normOpts.allowZero,
      signed: normOpts.signed,
      resolution
    });
    if (result.status === 'empty') {
      input.setCustomValidity('');
      delete input.dataset.canonicalAmount;
      delete input.dataset.formattedPreview;
      clearDisambiguation(input);
      return null;
    }
    if (result.status === 'ambiguous') {
      input.setCustomValidity(result.reason);
      delete input.dataset.canonicalAmount;
      delete input.dataset.formattedPreview;
      renderDisambiguation(input, result, unit);
      return null;
    }
    clearDisambiguation(input);
    if (result.status === 'invalid') {
      input.setCustomValidity(result.reason);
      delete input.dataset.canonicalAmount;
      delete input.dataset.formattedPreview;
      return null;
    }
    input.setCustomValidity('');
    input.dataset.canonicalAmount = result.canonical;
    input.dataset.formattedPreview = result.formatted;
    return result.scaled;
  }

  function clearInputState(input) {
    if (!input) return;
    if (input.dataset) {
      delete input.dataset.amountUnit;
      delete input.dataset.amountResolution;
      delete input.dataset.canonicalAmount;
      delete input.dataset.formattedPreview;
    }
    input.setCustomValidity?.('');
    clearDisambiguation(input);
  }

  function canonicalInputValue(input, unit = 'TL', positive = false, options = {}) {
    if (!input) return '';
    const scaled = parseInputElement(input, unit, positive, options);
    if (scaled !== null && input.dataset?.canonicalAmount) return input.dataset.canonicalAmount;
    return String(input.value ?? '').trim();
  }

  function inferInputUnit(target) {
    if (!target || !(target instanceof HTMLInputElement)) return '';
    if (target.dataset?.amountUnit) return target.dataset.amountUnit;
    if (target.id === 'bind-calc-rate' || target.id === 'fx-calc-rate') return 'RATE';
    if (target.inputMode !== 'decimal' && target.getAttribute?.('inputmode') !== 'decimal') return '';
    if (target.dataset?.itemField === 'value' || target.dataset?.allocationField === 'valueTL' || target.dataset?.field === 'referenceTL' || target.hasAttribute('data-value')) return 'TL';
    const labelText = (target.closest?.('label')?.textContent || '').toLocaleLowerCase('tr-TR');
    if (/(?:^|[^a-zçğıöşü0-9])(kur|kuru|oran)(?=$|[^a-zçğıöşü0-9])/.test(labelText)) return 'RATE';
    if (/(?:^|[^a-zçğıöşü0-9])(gram|gr|has|gümüş|ağırlık|tartı)(?=$|[^a-zçğıöşü0-9])/.test(labelText)) return 'GRAM';
    if (/(?:^|[^a-zçğıöşü0-9])(tl|tutar|bedel|fiyat|komisyon|usd|eur|gbp|chf|sar|aed|cad|aud|jpy|kwd|qar|sek|nok|dkk)(?=$|[^a-zçğıöşü0-9])/.test(labelText)) return 'TL';
    return '';
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', event => {
      if (!event.isTrusted || event.key !== '.') return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const u = inferInputUnit(target);
      if (isMoneyUnit(u)) event.preventDefault();
    }, true);
    document.addEventListener('input', event => {
      if (!event.isTrusted) return;
      const target = event.target;
      if (target instanceof HTMLInputElement && target.dataset) {
        if (target.dataset.amountResolution) delete target.dataset.amountResolution;
        if (target.dataset.canonicalAmount) delete target.dataset.canonicalAmount;
        if (target.dataset.formattedPreview) delete target.dataset.formattedPreview;
        const u = inferInputUnit(target);
        if (isMoneyUnit(u)) applyLiveMoneyGrouping(target, u, { treatDotAsDecimal: event.inputType === 'insertFromPaste' });
      }
    }, true);
  }

  const exportsObj = {
    units,
    isMoneyUnit,
    formatAmount,
    formatLiveMoneyValue,
    applyLiveMoneyGrouping,
    attachMoneyGrouping,
    setFormattedInputValue,
    inferInputUnit,
    canonicalFromScaled,
    parseUserAmount,
    parseInputElement,
    canonicalInputValue,
    clearInputState
  };
  root.DefterAmountCodec = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterAmountCodec = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
