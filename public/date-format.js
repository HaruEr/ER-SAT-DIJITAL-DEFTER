(root => {
  function formatTurkishDate(value, fallback = 'Başlangıç devri bekleniyor') {
    if (!value) return fallback;
    return new Date(`${value}T12:00:00`).toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  function todayIstanbul() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date()).map(p => [p.type, p.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  root.DefterDateFormat = {
    formatTurkishDate,
    todayIstanbul
  };
})(globalThis);
