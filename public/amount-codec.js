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
    if (wholeStr.length > 13) {
      return { status: 'invalid', reason: 'Miktar izin verilen üst sınırı (1e12) aşıyor.' };
    }
    const whole = Number(wholeStr);
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
      : fracStr.length ? `${wholeStr}.${fracStr}` : wholeStr;
    return { status: 'valid', canonical, scaled };
  }

  function parseUserAmount(rawValue, unit = 'TL', { positive = false, allowZero = true, resolution = null } = {}) {
    const spec = units[unit];
    const text = String(rawValue ?? '').trim();
    if (!text) return { status: 'empty', scaled: null };
    if (text.startsWith('-') || !/^[\d.,]+$/.test(text)) {
      return { status: 'invalid', reason: 'Yalnızca pozitif rakam, nokta ve virgül kullanın.' };
    }

    let wholeStr = '';
    let fracStr = '';

    // 1. Single dot with exactly 3 trailing digits: 10.500 (thousands vs 3-decimal ambiguity)
    if (/^\d{1,3}\.\d{3}$/.test(text)) {
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
    } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(text)) {
      // 2. Turkish grouped thousands + optional comma decimal: 10.000,50 or 1.250.000
      const [intPart, decPart = ''] = text.split(',');
      wholeStr = intPart.replace(/\./g, '');
      fracStr = decPart;
    } else if (/^\d+,\d+$/.test(text)) {
      // 3. Plain comma decimal: 10,500 or 10,5
      [wholeStr, fracStr] = text.split(',');
    } else if (/^\d+\.\d{1,2}$/.test(text)) {
      // 4. Single dot with 1 or 2 digits: 10.5 or 10.25 -> decimal
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

  function clearDisambiguation(input) {
    const container = input.closest('label, .field, td, div') || input.parentElement;
    container?.querySelector(':scope > .amount-disambiguation')?.remove();
  }

  function renderDisambiguation(input, result) {
    const container = input.closest('label, .field, td, div') || input.parentElement;
    if (!container) return;
    let box = container.querySelector(':scope > .amount-disambiguation');
    if (!box) {
      box = document.createElement('div');
      box.className = 'amount-disambiguation';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Miktar netleştirme');
      input.after(box);
    }
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

  function parseInputElement(input, unit = 'TL', positive = false) {
    if (!input) return null;
    const resolution = input.dataset?.amountResolution || null;
    const result = parseUserAmount(input.value, unit, { positive, allowZero: !positive, resolution });
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
      renderDisambiguation(input, result);
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

  function canonicalInputValue(input, unit = 'TL', positive = false) {
    if (!input) return '';
    const scaled = parseInputElement(input, unit, positive);
    if (scaled !== null && input.dataset?.canonicalAmount) return input.dataset.canonicalAmount;
    return String(input.value ?? '').trim();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('input', event => {
      if (!event.isTrusted) return;
      const target = event.target;
      if (target instanceof HTMLInputElement && target.dataset?.amountResolution) {
        delete target.dataset.amountResolution;
      }
    }, true);
  }

  root.DefterAmountCodec = {
    units,
    formatAmount,
    canonicalFromScaled,
    parseUserAmount,
    parseInputElement,
    canonicalInputValue
  };
})(globalThis);
