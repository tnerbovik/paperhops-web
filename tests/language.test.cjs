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

function visit({ languages = ['en-US'], saved, pathname = '/', search = '', hash = '', blocked = false } = {}) {
  const page = pages[pathname];
  const redirects = [];
  const picker = { value: page.lang, disabled: true, listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } };
  let preference = saved;
  vm.runInNewContext(source, {
    navigator: { languages, language: languages[0] },
    location: { pathname, search, hash, replace(url) { redirects.push(url); }, assign(url) { redirects.push(url); } },
    localStorage: {
      getItem() { if (blocked) throw new Error('Storage unavailable'); return preference; },
      setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); preference = value; }
    },
    URL,
    URLSearchParams,
    document: {
      documentElement: { lang: page.lang },
      querySelector(selector) {
        if (selector === '[data-language-select]') return picker;
        const language = selector.match(/hreflang="(\w+)"/)?.[1];
        return page[language] ? { getAttribute: () => page[language] } : null;
      }
    }
  });
  return { redirects, preference: () => preference, picker };
}

test('Norwegian browser preferences open the Norwegian page and preserve the section', () => {
  for (const language of ['nb-NO', 'nn-NO', 'no']) {
    assert.deepEqual(visit({ languages: [language], hash: '#levels' }).redirects, ['/no/#levels']);
  }
});

test('subpages open their own Norwegian counterpart', () => {
  assert.deepEqual(visit({ languages: ['nb-NO'], pathname: '/support/' }).redirects, ['/no/support/']);
});

test('pages without a Norwegian counterpart never redirect', () => {
  assert.deepEqual(visit({ languages: ['nb-NO'], pathname: '/untranslated/' }).redirects, []);
});

test('English takes precedence when it is preferred over Norwegian', () => {
  assert.deepEqual(visit({ languages: ['en-GB', 'nb-NO'] }).redirects, []);
});

test('unsupported languages fall back to the first supported preference', () => {
  assert.deepEqual(visit({ languages: ['fr-FR', 'nb-NO', 'en'] }).redirects, ['/no/']);
  assert.deepEqual(visit({ languages: ['fr-FR'] }).redirects, []);
});

test('a remembered language overrides browser preference', () => {
  assert.deepEqual(visit({ saved: 'en', languages: ['nb-NO'] }).redirects, []);
  assert.deepEqual(visit({ saved: 'nb' }).redirects, ['/no/']);
});

test('direct Norwegian URLs stay Norwegian even with an English preference', () => {
  assert.deepEqual(visit({ pathname: '/no/', saved: 'en' }).redirects, []);
});

test('explicit English selection works when storage is blocked', () => {
  assert.deepEqual(visit({ languages: ['nb-NO'], search: '?lang=en', blocked: true }).redirects, []);
});

test('automatic selection still works when storage is blocked', () => {
  assert.deepEqual(visit({ languages: ['nn-NO'], blocked: true }).redirects, ['/no/']);
});

test('the language dropdown remembers the choice and opens the same page', () => {
  const page = visit({ pathname: '/no/privacy/', hash: '#contact' });
  page.picker.value = 'en';
  page.picker.listeners.change();
  assert.equal(page.preference(), 'en');
  assert.deepEqual(page.redirects, ['/privacy/?lang=en#contact']);
  assert.equal(page.picker.disabled, false);
});

test('the dropdown switches to Norwegian even when storage is blocked', () => {
  const page = visit({ blocked: true, hash: '#pricing' });
  page.picker.value = 'nb';
  page.picker.listeners.change();
  assert.deepEqual(page.redirects, ['/no/#pricing']);
});
