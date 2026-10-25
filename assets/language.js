(() => {
  const preferenceKey = 'paperhops-language';
  const supported = language => language === 'en' || language === 'nb';
  const remember = language => {
    try { localStorage.setItem(preferenceKey, language); } catch { /* Links still work without storage. */ }
  };
  // Every translated page names its counterpart, e.g. /support/ ↔ /no/support/.
  const alternate = language => document.querySelector(`link[rel="alternate"][hreflang="${language}"]`)?.getAttribute('href');
  const path = url => new URL(url, 'https://paperhops.app').pathname;

  const picker = document.querySelector('[data-language-select]');
  if (picker) {
    picker.disabled = false;
    picker.addEventListener('change', () => {
      const target = alternate(picker.value);
      if (!supported(picker.value) || !target) return;
      remember(picker.value);
      location.assign(path(target) + (picker.value === 'en' ? '?lang=en' : '') + location.hash);
    });
  }

  // A direct /no/ link always opens Norwegian. Only English pages with a Norwegian
  // counterpart select a language automatically; the explicit ?lang=en link also
  // works when browser storage is unavailable.
  const norwegian = alternate('nb');
  if (document.documentElement.lang !== 'en' || !norwegian) return;
  let language = new URLSearchParams(location.search).get('lang');
  if (supported(language)) {
    remember(language);
  } else {
    try { language = localStorage.getItem(preferenceKey); } catch { /* Use browser preferences. */ }
    if (!supported(language)) {
      language = 'en';
      for (const preferred of navigator.languages?.length ? navigator.languages : [navigator.language]) {
        const base = (preferred || '').toLowerCase().split('-')[0];
        if (['nb', 'nn', 'no'].includes(base)) { language = 'nb'; break; }
        if (base === 'en') break;
      }
    }
  }
  if (language === 'nb') location.replace(path(norwegian) + location.hash);
})();
