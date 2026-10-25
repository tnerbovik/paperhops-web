// Suggests the visitor's language with a banner above the header, like apple.com: shown only
// when the browser (or an earlier choice) prefers the other language. The footer links switch
// language on every page and work without JavaScript.
(() => {
  try {
    const preferenceKey = 'paperhops-language';
    const dismissedKey = 'paperhops-language-banner';
    const supported = language => language === 'en' || language === 'nb';
    const storage = {
      get(key) { try { return localStorage.getItem(key); } catch { return null; } },
      set(key, value) { try { localStorage.setItem(key, value); } catch { /* The choice is not remembered. */ } }
    };
    // Every translated page names its counterpart, e.g. /support/ ↔ /no/support/.
    const alternate = language => document.querySelector(`link[rel="alternate"][hreflang="${language}"]`)?.getAttribute('href');
    const path = url => new URL(url, 'https://paperhops.app').pathname;
    const current = document.documentElement.lang;
    const params = new URLSearchParams(location.search);

    for (const link of document.querySelectorAll('[data-language-link]')) {
      link.addEventListener('click', () => storage.set(preferenceKey, link.dataset.languageLink));
    }
    if (supported(params.get('lang'))) storage.set(preferenceKey, params.get('lang'));

    const banner = document.querySelector('[data-language-banner]');
    if (!banner) return;

    let suggested = storage.get(preferenceKey);
    if (!supported(suggested)) {
      suggested = current;
      for (const preferred of navigator.languages?.length ? navigator.languages : [navigator.language]) {
        const base = (preferred || '').toLowerCase().split('-')[0];
        if (['nb', 'nn', 'no'].includes(base)) { suggested = 'nb'; break; }
        if (base === 'en') { suggested = 'en'; break; }
      }
    }
    // ?lang-banner shows the banner regardless, for testing.
    const wanted = suggested !== current && alternate(suggested) && storage.get(dismissedKey) !== current;
    if (!wanted && !params.has('lang-banner')) return;

    const select = banner.querySelector('select');
    const markChoice = () => {
      for (const option of select.options) option.textContent = (option.selected ? '✓ ' : '') + option.dataset.label;
    };
    markChoice();
    select.addEventListener('change', markChoice);
    banner.querySelector('[data-language-continue]').addEventListener('click', () => {
      const language = select.value;
      if (!supported(language)) return;
      storage.set(preferenceKey, language);
      const target = alternate(language);
      if (language === current || !target) banner.hidden = true;
      else location.assign(path(target) + location.hash);
    });
    banner.querySelector('[data-language-close]').addEventListener('click', () => {
      banner.hidden = true;
      storage.set(dismissedKey, current);
    });
    banner.hidden = false;
  } catch { /* Without the banner, the footer links still switch language. */ }
})();
