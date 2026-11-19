(root => {
  const COMBINING_RE = /[\u0300-\u036f]/g;
  const WHITESPACE_RE = /\s+/g;

  function fallbackNormalize(raw) {
    return raw
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(COMBINING_RE, '')
      .replace(/ı/g, 'i')
      .replace(WHITESPACE_RE, ' ')
      .trim();
  }

  function normalizeSearch(text) {
    if (text === null || text === undefined) return '';
    const raw = String(text);
    const len = raw.length;
    if (!len) return '';

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
          return fallbackNormalize(raw);
      }
      out += mapped;
      runStart = i + 1;
    }

    if (runStart < len) out += raw.slice(runStart);
    if (out.length > 0 && prevSpace) {
      return out.slice(0, out.length - 1);
    }
    return out;
  }

  function tokenizeSearch(text) {
    const normalized = normalizeSearch(text);
    return normalized ? normalized.split(' ') : [];
  }

  function collectParts(value, out) {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) collectParts(value[i], out);
      return;
    }
    out.push(String(value));
  }

  function searchHaystack(value) {
    if (Array.isArray(value)) {
      const parts = [];
      collectParts(value, parts);
      return parts.length ? normalizeSearch(parts.join(' ')) : '';
    }
    return normalizeSearch(value);
  }

  function matchesSearch(haystack, query) {
    const tokens = tokenizeSearch(query);
    if (!tokens.length) return true;
    const normalizedHaystack = searchHaystack(haystack);
    if (!normalizedHaystack) return false;
    for (let i = 0; i < tokens.length; i++) {
      if (!normalizedHaystack.includes(tokens[i])) return false;
    }
    return true;
  }

  const exportsObj = {
    normalizeSearch,
    tokenizeSearch,
    searchHaystack,
    matchesSearch
  };

  root.DefterSearchNorm = exportsObj;
  if (typeof globalThis !== 'undefined') globalThis.DefterSearchNorm = exportsObj;
})(typeof window !== 'undefined' ? window : globalThis);
