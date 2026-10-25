const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../assets/language.js'), 'utf8');

const pages = {
  '/': { lang: 'en', en: 'https://paperhops.app/', nb: 'https://paperhops.app/no/' },
  '/support/': { lang: 'en', en: 'https://paperhops.app/support/', nb: 'https://paperhops.app/no/support/' },
  '/no/': { lang: 'nb', en: 'https://paperhops.app/', nb: 'https://paperhops.app/no/' },
  '/no/privacy/': { lang: 'nb', en: 'https://paperhops.app/privacy/', nb: 'https://paperhops.app/no/privacy/' },
  '/untranslated/': { lang: 'en' }
};

const element = () => ({ listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } });

function visit({ languages = ['en-US'], saved = {}, pathname = '/', search = '', hash = '', blocked = false } = {}) {
  const page = pages[pathname];
  const redirects = [];
  const store = { ...saved };
  const other = page.lang === 'en' ? 'nb' : 'en';
  const options = ['en', 'nb'].map(value => ({ value, selected: value === other, textContent: '', dataset: { label: value === 'en' ? 'English' : 'Norsk' } }));
  const select = { ...element(), options, get value() { return options.find(o => o.selected).value; } };
  const buttons = { continue: element(), close: element() };
  const banner = {
    hidden: true,
    querySelector(selector) {
      if (selector === 'select') return select;
      return selector.includes('continue') ? buttons.continue : buttons.close;
    }
  };
  const footerLinks = ['en', 'nb'].map(language => ({ ...element(), dataset: { languageLink: language } }));
  vm.runInNewContext(source, {
    navigator: { languages, language: languages[0] },
    location: { pathname, search, hash, replace(url) { redirects.push(url); }, assign(url) { redirects.push(url); } },
    localStorage: {
      getItem(key) { if (blocked) throw new Error('Storage unavailable'); return store[key] ?? null; },
      setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); store[key] = value; }
    },
    URL,
    URLSearchParams,
    document: {
      documentElement: { lang: page.lang },
      querySelectorAll() { return footerLinks; },
      querySelector(selector) {
        if (selector === '[data-language-banner]') return banner;
        const language = selector.match(/hreflang="(\w+)"/)?.[1];
        return page[language] ? { getAttribute: () => page[language] } : null;
      }
    }
  });
  const choose = value => options.forEach(o => { o.selected = o.value === value; });
  return { redirects, store, banner, select, options, buttons, footerLinks, choose };
}

test('Norwegian browsers see the banner on English pages, and are not redirected', () => {
  for (const language of ['nb-NO', 'nn-NO', 'no']) {
    const page = visit({ languages: [language] });
    assert.equal(page.banner.hidden, false);
    assert.deepEqual(page.redirects, []);
  }
});

test('English browsers see the banner on Norwegian pages', () => {
  assert.equal(visit({ pathname: '/no/', languages: ['en-GB'] }).banner.hidden, false);
});

test('the banner stays hidden when the page is already in the preferred language', () => {
  assert.equal(visit({ languages: ['en-GB', 'nb-NO'] }).banner.hidden, true);
  assert.equal(visit({ pathname: '/no/', languages: ['nb-NO'] }).banner.hidden, true);
  assert.equal(visit({ languages: ['fr-FR'] }).banner.hidden, true);
});

test('unsupported languages fall through to the first supported preference', () => {
  assert.equal(visit({ languages: ['fr-FR', 'nb-NO', 'en'] }).banner.hidden, false);
});

test('pages without a counterpart never show the banner', () => {
  assert.equal(visit({ pathname: '/untranslated/', languages: ['nb-NO'] }).banner.hidden, true);
});

test('a remembered choice overrides the browser languages', () => {
  assert.equal(visit({ languages: ['nb-NO'], saved: { 'paperhops-language': 'en' } }).banner.hidden, true);
  assert.equal(visit({ languages: ['en-US'], saved: { 'paperhops-language': 'nb' } }).banner.hidden, false);
});

test('Continue opens the same page in the chosen language and remembers it', () => {
  const page = visit({ pathname: '/no/privacy/', languages: ['en-US'], hash: '#contact' });
  page.buttons.continue.listeners.click();
  assert.deepEqual(page.redirects, ['/privacy/#contact']);
  assert.equal(page.store['paperhops-language'], 'en');
});

test('choosing the current language in the banner just closes it', () => {
  const page = visit({ languages: ['nb-NO'] });
  page.choose('en');
  page.buttons.continue.listeners.click();
  assert.equal(page.banner.hidden, true);
  assert.deepEqual(page.redirects, []);
  assert.equal(page.store['paperhops-language'], 'en');
});

test('the selected option is marked with a check', () => {
  const page = visit({ languages: ['nb-NO'] });
  assert.deepEqual(page.options.map(o => o.textContent), ['English', '✓ Norsk']);
  page.choose('en');
  page.select.listeners.change();
  assert.deepEqual(page.options.map(o => o.textContent), ['✓ English', 'Norsk']);
});

test('closing the banner keeps it closed on later visits', () => {
  const page = visit({ languages: ['nb-NO'] });
  page.buttons.close.listeners.click();
  assert.equal(page.banner.hidden, true);
  assert.equal(visit({ languages: ['nb-NO'], saved: page.store }).banner.hidden, true);
});

test('everything still works when storage is blocked', () => {
  const page = visit({ languages: ['nb-NO'], blocked: true });
  assert.equal(page.banner.hidden, false);
  page.buttons.continue.listeners.click();
  assert.deepEqual(page.redirects, ['/no/']);
});

test('footer links and ?lang= remember an explicit choice', () => {
  const page = visit({ languages: ['nb-NO'], search: '?lang=en' });
  assert.equal(page.banner.hidden, true);
  page.footerLinks[1].listeners.click();
  assert.equal(page.store['paperhops-language'], 'nb');
});

test('?lang-banner forces the banner for testing', () => {
  assert.equal(visit({ languages: ['en-US'], search: '?lang-banner=1' }).banner.hidden, false);
});
