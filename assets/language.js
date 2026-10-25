// The language bar above the header, like apple.com's. It is in the HTML on every page with
// plain English | Norsk links; once this script runs it swaps those for a language menu and a
// Continue button, and suggests the other language when the browser prefers it.
(() => {
  try {
    const preferenceKey = 'paperhops-language';
    const supported = language => language === 'en' || language === 'nb';
    const storage = {
      get(key) { try { return localStorage.getItem(key); } catch { return null; } },
      set(key, value) { try { localStorage.setItem(key, value); } catch { /* The choice is not remembered. */ } }
    };
    // Every translated page names its counterpart, e.g. /support/ ↔ /no/support/; others go to the front page.
    const alternate = language => document.querySelector(`link[rel="alternate"][hreflang="${language}"]`)?.getAttribute('href');
    const target = language => {
      const href = alternate(language);
      return href ? new URL(href, 'https://paperhops.app').pathname : language === 'nb' ? '/no/' : '/';
    };
    const current = document.documentElement.lang;
    const other = current === 'en' ? 'nb' : 'en';
    const params = new URLSearchParams(location.search);
    if (supported(params.get('lang'))) storage.set(preferenceKey, params.get('lang'));
    for (const link of document.querySelectorAll('[data-language-link]')) {
      link.addEventListener('click', () => storage.set(preferenceKey, link.dataset.languageLink));
    }

    const bar = document.querySelector('[data-language-bar]');
    if (!bar) return;
    const select = bar.querySelector('select');
    const button = bar.querySelector('[data-language-continue]');

    let preferred = storage.get(preferenceKey);
    if (!supported(preferred)) {
      preferred = current;
      for (const language of navigator.languages?.length ? navigator.languages : [navigator.language]) {
        const base = (language || '').toLowerCase().split('-')[0];
        if (['nb', 'nn', 'no'].includes(base)) { preferred = 'nb'; break; }
        if (base === 'en') { preferred = 'en'; break; }
      }
    }
    // ?lang-suggest shows the suggestion regardless, for testing.
    if (preferred === other || params.has('lang-suggest')) {
      const text = bar.querySelector('[data-language-text]');
      const { suggestTitle, suggestLine, suggestButton } = text.dataset;
      text.lang = other;
      text.querySelector('strong').textContent = suggestTitle;
      text.querySelector('span').textContent = suggestLine;
      button.lang = other;
      button.textContent = suggestButton;
      for (const option of select.options) option.selected = option.value === other;
    }

    button.addEventListener('click', () => {
      const language = select.value;
      if (!supported(language)) return;
      storage.set(preferenceKey, language);
      if (language !== current) location.assign(target(language) + location.hash);
    });
    bar.querySelector('[data-language-controls]').hidden = false;
    const links = bar.querySelector('[data-language-links]');
    if (links) links.hidden = true;
  } catch { /* The bar's plain links still switch language. */ }
})();
