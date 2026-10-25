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
  '/404.html': { lang: 'en' }
};

const element = props => ({ listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; }, ...props });

function visit({ languages = ['en-US'], saved = {}, pathname = '/', search = '', hash = '', blocked = false } = {}) {
  const page = pages[pathname];
  const redirects = [];
  const store = { ...saved };
  const options = ['en', 'nb'].map(value => ({ value, selected: value === page.lang, textContent: '', dataset: { label: value === 'en' ? 'English' : 'Norsk' } }));
  const select = Object.defineProperty(element({ options }), 'value', { get: () => options.find(o => o.selected).value });
  const button = element({ textContent: page.lang === 'en' ? 'Continue' : 'Fortsett' });
  const strong = { textContent: 'static title' };
  const span = { textContent: 'static line' };
  const text = {
    lang: '', dataset: { suggestTitle: 'suggested title', suggestLine: 'suggested line', suggestButton: 'suggested button' },
    querySelector: selector => (selector === 'strong' ? strong : span)
  };
  const controls = { hidden: true };
  const barLinks = { hidden: false };
  const links = ['en', 'nb'].map(language => element({ dataset: { languageLink: language } }));
  const bar = {
    querySelector(selector) {
      return { select, '[data-language-continue]': button, '[data-language-text]': text, '[data-language-controls]': controls, '[data-language-links]': barLinks }[selector];
    }
  };
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
      querySelectorAll: () => links,
      querySelector(selector) {
        if (selector === '[data-language-bar]') return bar;
        const language = selector.match(/hreflang="(\w+)"/)?.[1];
        return page[language] ? { getAttribute: () => page[language] } : null;
      }
    }
  });
  const choose = value => options.forEach(o => { o.selected = o.value === value; });
  return { redirects, store, controls, barLinks, select, options, button, strong, span, text, links, choose };
}

test('the menu and Continue button replace the plain links', () => {
  const page = visit();
  assert.equal(page.controls.hidden, false);
  assert.equal(page.barLinks.hidden, true);
});

test('the current language is selected when the browser agrees', () => {
  const page = visit({ languages: ['en-GB'] });
  assert.equal(page.select.value, 'en');
  assert.equal(page.strong.textContent, 'static title');
  assert.equal(page.button.textContent, 'Continue');
});

test('a Norwegian browser on an English page gets a Norwegian suggestion and no redirect', () => {
  for (const language of ['nb-NO', 'nn-NO', 'no']) {
    const page = visit({ languages: [language] });
    assert.equal(page.select.value, 'nb');
    assert.equal(page.text.lang, 'nb');
    assert.equal(page.strong.textContent, 'suggested title');
    assert.equal(page.span.textContent, 'suggested line');
    assert.equal(page.button.textContent, 'suggested button');
    assert.deepEqual(page.redirects, []);
  }
});

test('an English browser on a Norwegian page gets an English suggestion', () => {
  const page = visit({ pathname: '/no/', languages: ['en-US'] });
  assert.equal(page.select.value, 'en');
  assert.equal(page.text.lang, 'en');
});

test('unsupported languages fall through to the first supported preference', () => {
  assert.equal(visit({ languages: ['fr-FR', 'nb-NO', 'en'] }).select.value, 'nb');
  assert.equal(visit({ languages: ['fr-FR'] }).select.value, 'en');
});

test('a remembered choice overrides the browser languages', () => {
  assert.equal(visit({ languages: ['nb-NO'], saved: { 'paperhops-language': 'en' } }).select.value, 'en');
  assert.equal(visit({ languages: ['en-US'], saved: { 'paperhops-language': 'nb' } }).select.value, 'nb');
});

test('option labels are left alone, since the native menu marks the selection', () => {
  const page = visit({ languages: ['nb-NO'] });
  assert.deepEqual(page.options.map(o => o.textContent), ['', '']);
});

test('language links remember the choice', () => {
  const page = visit();
  page.links[1].listeners.click();
  assert.equal(page.store['paperhops-language'], 'nb');
});

test('Continue opens the same page in the chosen language and remembers it', () => {
  const page = visit({ pathname: '/no/privacy/', languages: ['nb-NO'], hash: '#contact' });
  page.choose('en');
  page.button.listeners.click();
  assert.deepEqual(page.redirects, ['/privacy/#contact']);
  assert.equal(page.store['paperhops-language'], 'en');
});

test('Continue with the current language stays and remembers it', () => {
  const page = visit({ languages: ['nb-NO'] });
  page.choose('en');
  page.button.listeners.click();
  assert.deepEqual(page.redirects, []);
  assert.equal(page.store['paperhops-language'], 'en');
});

test('pages without a counterpart send the other language to its front page', () => {
  const page = visit({ pathname: '/404.html' });
  page.choose('nb');
  page.button.listeners.click();
  assert.deepEqual(page.redirects, ['/no/']);
});

test('everything works when storage is blocked', () => {
  const page = visit({ languages: ['nb-NO'], blocked: true });
  assert.equal(page.controls.hidden, false);
  page.button.listeners.click();
  assert.deepEqual(page.redirects, ['/no/']);
});

test('?lang= remembers an explicit choice', () => {
  const page = visit({ languages: ['nb-NO'], search: '?lang=en' });
  assert.equal(page.store['paperhops-language'], 'en');
  assert.equal(page.select.value, 'en');
});

test('?lang-suggest forces the suggestion for testing', () => {
  assert.equal(visit({ languages: ['en-US'], search: '?lang-suggest=1' }).select.value, 'nb');
});
