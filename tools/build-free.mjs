#!/usr/bin/env node
/**
 * Builds the free colouring-page section of paperhops.app (free/) from the Paperhops app's own
 * drawings: exactly the pages that are free in the app (FREE_PAGES in src/lib/pro.ts) and the
 * dot-to-dot of each free level-1 page.
 *
 * For every page it writes an A4 print-ready PDF (vector, drawing centred inside 12 mm margins, a
 * small "paperhops.app" footer) and web PNGs into free/files/, then the HTML: a gallery and one
 * page per drawing, in English (free/) and Norwegian (free/no/), plus free/sitemap-free.xml.
 *
 * The app repository is only read. Run from anywhere:
 *   npm --prefix tools install && npm --prefix tools run build-free
 * Set PAPERHOPS_APP to use an app checkout somewhere else.
 */
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { PDFDocument, PDFNumber, PDFOperator, StandardFonts, rgb, grayscale } from 'pdf-lib';
import sharp from 'sharp';

const APP = process.env.PAPERHOPS_APP ?? '/Users/tnerbovik/Code/Apps/Paperhops';
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'free');
const FILES = path.join(OUT, 'files');
const SITE = 'https://paperhops.app';
const BASE = `${SITE}/free/`;
/** The main site's home page per language; it carries the App Store link, so "get the app" goes there too. */
const HOME = { en: '/', no: '/no/' };
/** Fixed PDF dates, so a rebuild only changes files whose drawing changed. */
const PDF_DATE = new Date('2026-10-25T00:00:00Z');
const YEAR = 2026;

// ---------------------------------------------------------------------------------------------
// The app's content

async function appFile(rel) {
  return readFile(path.join(APP, rel), 'utf8');
}

/** Evaluates an object literal cut out of a TypeScript source (plain data, no types inside). */
function literal(source, pattern, what) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find ${what}`);
  return Function(`return (${match[1]});`)();
}

async function loadContent() {
  const free = literal(await appFile('src/lib/pro.ts'), /FREE_PAGES[^=]*=\s*(\{[\s\S]*?\n\});/, 'FREE_PAGES');
  const text = {};
  for (const lang of ['en', 'no']) {
    const src = await appFile(`src/content/drawings/subject-text/${lang}.ts`);
    text[lang] = literal(src, /:\s*SubjectText\s*=\s*(\{[\s\S]*?\n\});/, `subject text (${lang})`);
  }
  const { SUBJECTS } = await import(pathToFileURL(path.join(APP, 'scripts/outline-subjects.mjs')).href);
  const outlines = new Map();
  for (const line of (await appFile('src/content/drawings/outlines.ts')).split('\n')) {
    const m = line.match(/^\s*\.\.\.(\{.*\}),\s*$/);
    if (m) {
      const d = JSON.parse(m[1]);
      outlines.set(d.id, d);
    }
  }
  return { free, text, SUBJECTS, outlines };
}

// ---------------------------------------------------------------------------------------------
// Drawing (mirrors src/lib/drawing-svg.ts)

const LABEL_SIZE = { 1: 6.5, 2: 6, 3: 5.5 };

/** The numbered dots as SVG, as `dotsMarkup` draws them in the app. */
function dotsMarkup(drawing) {
  const size = LABEL_SIZE[drawing.difficulty];
  return drawing.dotPoints
    .map(
      ([x, y, lx, ly], i) =>
        `<circle cx="${x}" cy="${y}" r="${size / 3.2}" fill="#000000"/>` +
        `<text x="${lx}" y="${ly + size * 0.35}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${size}" fill="#000000">${i + 1}</text>`,
    )
    .join('');
}

/** The single evenodd ink path of a traced outline SVG. */
function inkPath(svg) {
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((m) => m[1]);
  if (paths.length !== 1 || !/fill-rule="evenodd"/.test(svg)) {
    throw new Error('Expected one evenodd path per outline SVG; the PDF writer needs updating.');
  }
  return paths[0];
}

/** SVG path data (absolute M/L/C/Z, as the tracer writes it) to PDF path operators. */
function pathOperators(d) {
  const ops = [];
  const tokens = d.match(/[MLCZmlcz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let cmd = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd !== cmd.toUpperCase()) throw new Error(`Relative path command ${cmd} not supported`);
      if (cmd === 'Z') {
        ops.push(PDFOperator.of('h'));
        continue;
      }
    }
    if (cmd === 'M') {
      ops.push(PDFOperator.of('m', [num(), num()].map(n)));
      cmd = 'L'; // further pairs after M are line-tos
    } else if (cmd === 'L') ops.push(PDFOperator.of('l', [num(), num()].map(n)));
    else if (cmd === 'C') ops.push(PDFOperator.of('c', [num(), num(), num(), num(), num(), num()].map(n)));
    else throw new Error(`Unexpected path data near token ${i}: ${tokens[i]}`);
  }
  return ops;
}

const n = (v) => PDFNumber.of(Math.round(v * 1000) / 1000);

/** A filled circle as four Béziers. */
function circleOperators(cx, cy, r) {
  const k = 0.5523 * r;
  const c = (...v) => PDFOperator.of('c', v.map(n));
  return [
    PDFOperator.of('m', [cx + r, cy].map(n)),
    c(cx + r, cy + k, cx + k, cy + r, cx, cy + r),
    c(cx - k, cy + r, cx - r, cy + k, cx - r, cy),
    c(cx - r, cy - k, cx - k, cy - r, cx, cy - r),
    c(cx + k, cy - r, cx + r, cy - k, cx + r, cy),
    PDFOperator.of('h'),
  ];
}

const MM = 72 / 25.4;
const A4 = { width: 210 * MM, height: 297 * MM };
const MARGIN = 12 * MM;
const FOOTER = 8 * MM;

/** An A4 page: the drawing as large as fits inside the margins, a small footer at the foot. */
async function buildPdf({ svg, dots, title, keywords, lang }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.setAuthor('Paperhops');
  doc.setSubject(lang === 'no' ? 'Fargeleggingsark fra paperhops.app' : 'Colouring page from paperhops.app');
  doc.setKeywords(keywords);
  doc.setCreator('paperhops.app');
  doc.setProducer('paperhops.app');
  doc.setCreationDate(PDF_DATE);
  doc.setModificationDate(PDF_DATE);
  doc.setLanguage(lang === 'no' ? 'nb-NO' : 'en-GB');
  const page = doc.addPage([A4.width, A4.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const innerW = A4.width - MARGIN * 2;
  const innerH = A4.height - MARGIN * 2 - FOOTER;
  const size = Math.min(innerW, innerH);
  const scale = size / 200;
  const left = (A4.width - size) / 2;
  const top = A4.height - MARGIN - (innerH - size) / 2; // page y of the drawing's top edge

  // Drawing space: SVG units, y down.
  page.pushOperators(
    PDFOperator.of('q'),
    PDFOperator.of('cm', [scale, 0, 0, -scale, left, top].map(n)),
    PDFOperator.of('g', [n(0)]),
    ...pathOperators(inkPath(svg)),
    PDFOperator.of('f*'),
  );
  if (dots) {
    const r = LABEL_SIZE[dots.difficulty] / 3.2;
    page.pushOperators(...dots.dotPoints.flatMap(([x, y]) => circleOperators(x, y, r)), PDFOperator.of('f'));
  }
  page.pushOperators(PDFOperator.of('Q'));

  if (dots) {
    const fontSize = LABEL_SIZE[dots.difficulty] * scale;
    dots.dotPoints.forEach(([, , lx, ly], i) => {
      const label = String(i + 1);
      page.drawText(label, {
        x: left + lx * scale - font.widthOfTextAtSize(label, fontSize) / 2,
        y: top - (ly + LABEL_SIZE[dots.difficulty] * 0.35) * scale,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    });
  }

  const footer = 'paperhops.app';
  const footerSize = 9;
  page.drawText(footer, {
    x: (A4.width - font.widthOfTextAtSize(footer, footerSize)) / 2,
    y: MARGIN + 2,
    size: footerSize,
    font,
    color: grayscale(0.55),
  });
  return doc.save({ useObjectStreams: true });
}

/** A small, palette-quantised greyscale PNG of the drawing. */
async function buildPng(svg, width) {
  const raw = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: '#ffffff',
    // Only the dot numbers are text; loading the system fonts for every picture is slow.
    font: svg.includes('<text') ? { loadSystemFonts: true, defaultFontFamily: 'Helvetica' } : { loadSystemFonts: false },
  })
    .render()
    .asPng();
  return sharp(raw).greyscale().png({ palette: true, colors: 16, compressionLevel: 9, effort: 10 }).toBuffer();
}

// ---------------------------------------------------------------------------------------------
// Words

const LEVELS = [1, 2, 3];

const T = {
  en: {
    htmlLang: 'en',
    languageName: 'English',
    ogLocale: 'en_GB',
    root: '/free/',
    other: 'no',
    // The language bar. `suggest*` is what a Norwegian page shows a visitor who prefers English.
    bar: {
      label: 'Language',
      title: 'Choose your language.',
      line: 'Paperhops is available in English and Norwegian.',
      go: 'Continue',
      suggestTitle: 'View Paperhops in English.',
      suggestLine: 'Choose the language you’d like to read the site in.',
    },
    navFree: 'Free pages',
    navApp: 'Get the app',
    ages: { 1: 'Ages 3–5', 2: 'Ages 6–8', 3: 'Ages 9+' },
    agesFor: { 1: 'for ages 3–5', 2: 'for ages 6–8', 3: 'for ages 9+' },
    agesForTitle: { 1: 'for ages 3–5', 2: 'for ages 6–8', 3: 'for ages 9+ and adults' },
    levelName: { 1: 'Little artists', 2: 'Young explorers', 3: 'Creative masters' },
    levelBlurb: {
      1: 'Big shapes and thick lines for little hands.',
      2: 'More parts to colour and a little more detail.',
      3: 'Fine detail for older kids, and relaxing adult colouring for parents and grandparents to do side by side.',
    },
    levelPhrase: {
      1: 'with big shapes and thick lines for little hands',
      2: 'with more parts and a little more detail',
      3: 'with fine detail for older kids and relaxing adult colouring',
    },
    kb: (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`,
    galleryTitle: 'Free printable colouring pages for kids – screen-free fun | Paperhops',
    galleryDescription: (c) =>
      `Free printable colouring pages for kids and grandparents: screen-free activities for ages 3–5, 6–8 and 9+. Swap 20 minutes of screen for a page to colour.`,
    galleryH1: 'Free colouring pages for a screen-free moment',
    galleryLead: (c) =>
      `Swap 20 minutes of screen for a page to colour. These ${c.free} free printable colouring pages and ${c.dots} dot-to-dots are for parents and grandparents who want a calm, screen-free activity with the children: print a stack before the grandkids visit, and there is always something ready on the table. They come at three levels, from three-year-olds to grown-ups, and the 9+ pages double as relaxing adult colouring to do side by side.`,
    galleryJump: 'Jump to',
    galleryDots: 'with dot-to-dot',
    whyTitle: 'Less screen time, more colouring',
    why: [
      ['Hands-on', 'Holding a crayon, staying inside the lines and choosing colours trains the small hand movements children later use to write.'],
      ['Calm, without notifications', 'A sheet of paper doesn’t ping, autoplay or ask for one more minute. Children settle into it at their own pace.'],
      ['Side by side', 'The detailed 9+ pages are relaxing adult colouring too. Sit down together, each with your own page.'],
      ['Ready in a minute', 'Print a stack while the kettle boils, before the grandkids arrive. No account, no sign-up, no ads.'],
    ],
    ctaTitle: (c) => `${c.more} more pages in the app`,
    ctaBody: (c) =>
      `Paperhops has ${c.subjects} subjects, each drawn at three levels, and a dot-to-dot for every simple page. The pages here are a taste: Paperhops Pro unlocks the whole library with one purchase, no subscription.`,
    ctaButton: 'Get Paperhops',
    ctaNote: 'Less screen. More life.',
    useTitle: 'Free to print at home and in class',
    useBody:
      'Print as many copies as you like for your own family and the children you look after. Teachers and kindergarten staff may print copies for their own group. Please don’t sell the pages or upload the files elsewhere: share a link to the page instead.',
    copyright: `© ${YEAR} Paperhops (Torbjørn Nerbøvik). All rights reserved.`,
    pageTitle: (s, l) => `Free printable ${s} colouring page ${T.en.agesForTitle[l]} | Paperhops`,
    pageH1: (s, l) => `${cap(s)} colouring page ${T.en.agesForTitle[l]}`,
    pageDescription: (s, l, dots) =>
      l === 3
        ? `Free printable ${s} colouring page for ages 9+ and adults: relaxing, screen-free colouring to do side by side. Download the A4 PDF.`
        : `Free printable ${s} colouring page ${T.en.agesFor[l]}: a calm, screen-free activity for kids and grandparents. Download the A4 PDF${dots ? ' and a matching dot-to-dot' : ''}.`,
    pageLead: (s, l) =>
      `A free ${s} to print and colour, ${T.en.levelPhrase[l]}. Swap a little screen time for crayons: download the print-ready PDF and you’re set.${l === 3 ? ' Grown-ups: print two and colour side by side.' : ''}`,
    alt: (s, l) => `${cap(s)} colouring page ${T.en.agesFor[l]}: a black outline drawing to print and colour`,
    dotsAlt: (s, count) => `${cap(s)} dot-to-dot with numbers from 1 to ${count}`,
    download: 'Download PDF',
    letterTip: 'Printing on US Letter? Choose “fit to page” in the print dialog.',
    pin: 'Save on Pinterest',
    dotsTitle: (s) => `${cap(s)} dot-to-dot`,
    dotsBody: (count) => `Join the dots from 1 to ${count} to finish the picture, then colour it in.`,
    dotsDownload: 'Download dot-to-dot PDF',
    levelsTitle: (s) => `More ${s} pages`,
    levelsBody: 'The same subject at the other levels.',
    inApp: 'In the app',
    freeHere: 'Free',
    relatedTitle: (l) => `More free pages ${T.en.agesFor[l]}`,
    tags: 'Search words',
    breadcrumbHome: 'Paperhops',
    breadcrumbFree: 'Free colouring pages',
    pdfTitle: (s, l) => `${cap(s)} colouring page ${T.en.agesFor[l]}`,
    dotsPdfTitle: (s) => `${cap(s)} dot-to-dot`,
    fileName: (slug) => `paperhops-${slug}-colouring-page.pdf`,
    dotsFileName: (slug) => `paperhops-${slug}-dot-to-dot.pdf`,
    footerTagline: 'Colouring pages and dot-to-dots to print.',
    footerLinks: [['Free colouring pages', '/free/'], ['Support', '/support/'], ['Privacy', '/privacy/'], ['Terms', '/terms/']],
  },
  no: {
    htmlLang: 'nb',
    languageName: 'Norsk',
    ogLocale: 'nb_NO',
    root: '/free/no/',
    other: 'en',
    bar: {
      label: 'Språk',
      title: 'Velg språk.',
      line: 'Paperhops finnes på norsk og engelsk.',
      go: 'Fortsett',
      suggestTitle: 'Se Paperhops på norsk.',
      suggestLine: 'Velg språket du vil lese nettsiden på.',
    },
    navFree: 'Gratis ark',
    navApp: 'Hent appen',
    ages: { 1: '3–5 år', 2: '6–8 år', 3: '9+ år' },
    agesFor: { 1: 'for 3–5 år', 2: 'for 6–8 år', 3: 'fra 9 år' },
    agesForTitle: { 1: 'for 3–5 år', 2: 'for 6–8 år', 3: 'fra 9 år og for voksne' },
    levelName: { 1: 'Små kunstnere', 2: 'Unge oppdagere', 3: 'Kreative mestere' },
    levelBlurb: {
      1: 'Store former og tykke streker for små hender.',
      2: 'Flere deler å fargelegge og litt mer detaljer.',
      3: 'Fine detaljer for store barn, og avslappende fargelegging for foreldre og besteforeldre å gjøre side om side.',
    },
    levelPhrase: {
      1: 'med store former og tykke streker for små hender',
      2: 'med flere deler og litt mer detaljer',
      3: 'med fine detaljer for store barn og avslappende fargelegging for voksne',
    },
    kb: (bytes) => `${Math.max(1, Math.round(bytes / 1024))} kB`,
    galleryTitle: 'Gratis fargeleggingsark for barn – skjermfri aktivitet | Paperhops',
    galleryDescription: (c) =>
      `Gratis fargeleggingsark: fargelegging for barn som skjermfri aktivitet, for foreldre og besteforeldre. ${c.free} PDF-er og ${c.dots} prikk til prikk-ark for 3–5, 6–8 og 9+ år.`,
    galleryH1: 'Gratis fargeleggingsark for en skjermfri stund',
    galleryLead: (c) =>
      `Bytt 20 minutter skjerm mot et ark å fargelegge. Disse ${c.free} gratis fargeleggingsarkene og ${c.dots} prikk til prikk-arkene er for foreldre og besteforeldre som vil ha en rolig, skjermfri aktivitet sammen med barna: skriv ut en bunke før barnebarna kommer på besøk, så ligger det alltid noe klart på bordet. Arkene finnes på tre nivåer, fra treåringer til voksne, og arkene for 9+ år er også avslappende fargelegging for voksne, side om side.`,
    galleryJump: 'Gå til',
    galleryDots: 'med prikk til prikk',
    whyTitle: 'Mindre skjermtid, mer fargelegging',
    why: [
      ['Med hendene', 'Å holde en fargestift, holde seg innenfor strekene og velge farger trener de små håndbevegelsene barn senere bruker når de skal skrive.'],
      ['Rolig, uten varsler', 'Et ark plinger ikke, starter ikke neste video og ber ikke om ett minutt til. Barna finner roen i sitt eget tempo.'],
      ['Side om side', 'De detaljerte arkene for 9+ år er avslappende fargelegging for voksne også. Sett dere ned sammen, med hvert deres ark.'],
      ['Klart på et minutt', 'Skriv ut en bunke mens kaffen traktes, før barnebarna kommer. Ingen konto, ingen registrering, ingen reklame.'],
    ],
    ctaTitle: (c) => `${c.more} ark til i appen`,
    ctaBody: (c) =>
      `Paperhops har ${c.subjects} motiver, hvert tegnet på tre nivåer, og prikk til prikk til alle de enkleste arkene. Arkene her er en smakebit: Paperhops Pro låser opp hele biblioteket med ett kjøp, uten abonnement.`,
    ctaButton: 'Hent Paperhops',
    ctaNote: 'Mindre skjerm. Mer liv.',
    useTitle: 'Gratis å skrive ut hjemme, i barnehagen og på skolen',
    useBody:
      'Skriv ut så mange kopier du vil til din egen familie og barn du passer på. Lærere og barnehageansatte kan skrive ut kopier til sin egen barnegruppe. Ikke selg arkene eller last opp filene andre steder: del heller en lenke til siden.',
    copyright: `© ${YEAR} Paperhops (Torbjørn Nerbøvik). Alle rettigheter forbeholdt.`,
    pageTitle: (s, l) => `Gratis fargeleggingsark med ${s} ${T.no.agesForTitle[l]} | Paperhops`,
    pageH1: (s, l) => `Fargeleggingsark med ${s} ${T.no.agesForTitle[l]}`,
    pageDescription: (s, l, dots) =>
      l === 3
        ? `Gratis fargeleggingsark med ${s} fra 9 år og for voksne: avslappende, skjermfri fargelegging side om side. Last ned PDF for A4.`
        : `Gratis fargeleggingsark med ${s} ${T.no.agesFor[l]}: en rolig, skjermfri aktivitet for barn og besteforeldre. Last ned PDF for A4${dots ? ' og prikk til prikk' : ''}.`,
    pageLead: (s, l) =>
      `Gratis fargeleggingsark med ${s}, ${T.no.levelPhrase[l]}. Bytt litt skjermtid mot fargestifter: last ned PDF-en, skriv den ut, så er dere i gang.${l === 3 ? ' Voksne: skriv ut to og fargelegg side om side.' : ''}`,
    alt: (s, l) => `Fargeleggingsark med ${s} ${T.no.agesFor[l]}: svart strektegning å skrive ut og fargelegge`,
    dotsAlt: (s, count) => `Prikk til prikk med ${s}, med tall fra 1 til ${count}`,
    download: 'Last ned PDF',
    letterTip: '',
    pin: 'Lagre på Pinterest',
    dotsTitle: (s) => `Prikk til prikk: ${s}`,
    dotsBody: (count) => `Trekk streker fra 1 til ${count} for å fullføre tegningen, og fargelegg den etterpå.`,
    dotsDownload: 'Last ned prikk til prikk (PDF)',
    levelsTitle: (s) => `Flere ark med ${s}`,
    levelsBody: 'Det samme motivet på de andre nivåene.',
    inApp: 'I appen',
    freeHere: 'Gratis',
    relatedTitle: (l) => `Flere gratis ark ${T.no.agesFor[l]}`,
    tags: 'Stikkord',
    breadcrumbHome: 'Paperhops',
    breadcrumbFree: 'Gratis fargeleggingsark',
    pdfTitle: (s, l) => `Fargeleggingsark med ${s} ${T.no.agesFor[l]}`,
    dotsPdfTitle: (s) => `Prikk til prikk: ${s}`,
    fileName: (slug) => `paperhops-${slug}-fargeleggingsark.pdf`,
    dotsFileName: (slug) => `paperhops-${slug}-prikk-til-prikk.pdf`,
    footerTagline: 'Fargeleggingsark og prikk til prikk å skrive ut.',
    footerLinks: [['Gratis fargeleggingsark', '/free/no/'], ['Hjelp', '/no/support/'], ['Personvern', '/no/privacy/'], ['Vilkår', '/no/terms/']],
  },
};

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A title mid-sentence: "Fire engine" → "fire engine", but "T-rex" stays. */
function lower(title) {
  return /^.[a-zæøå]/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
}

function esc(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------------------------------------------------------------------------------------------
// HTML

/** The main site's icons, and a preload of the self-hosted Fredoka that /assets/theme.css declares. */
const SHARED_LINKS = `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32.png">
  <link rel="icon" type="image/svg+xml" sizes="any" href="/assets/icons/favicon.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="preload" href="/assets/fonts/fredoka-600.woff2" as="font" type="font/woff2" crossorigin>`;

function head({ lang, title, description, path: urlPath, otherPath, image, imageAlt, imageSize, jsonld }) {
  const t = T[lang];
  const url = SITE + urlPath;
  const enPath = lang === 'en' ? urlPath : otherPath;
  const noPath = lang === 'no' ? urlPath : otherPath;
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#fbf6ec" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1c1815" media="(prefers-color-scheme: dark)">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="en" href="${SITE + enPath}">
  <link rel="alternate" hreflang="nb" href="${SITE + noPath}">
  <link rel="alternate" hreflang="x-default" href="${SITE + enPath}">
  ${SHARED_LINKS}
  <link rel="stylesheet" href="/assets/theme.css">
  <link rel="stylesheet" href="/free/free.css">
  <script src="/assets/language.js" defer></script>
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Paperhops">
  <meta property="og:locale" content="${t.ogLocale}">
  <meta property="og:locale:alternate" content="${T[t.other].ogLocale}">
  <meta property="og:title" content="${esc(title.replace(/ \| Paperhops$/, ''))}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${image}">
  <meta property="og:image:width" content="${imageSize}"><meta property="og:image:height" content="${imageSize}">
  <meta property="og:image:alt" content="${esc(imageAlt)}">
  <meta name="twitter:card" content="summary_large_image">
  <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
</head>`;
}

/**
 * The main site's language bar, always shown above the header, like apple.com's. Without
 * JavaScript it offers plain links to this page in each language; /assets/language.js swaps them
 * for a menu and a Continue button that goes to the page's hreflang counterpart, and suggests the
 * other language (in that language) when the visitor prefers it.
 */
function languageBar(lang, paths) {
  const t = T[lang];
  const other = T[t.other];
  const option = (code) =>
    `<option value="${T[code].htmlLang}" lang="${T[code].htmlLang}" data-label="${T[code].languageName}"${code === lang ? ' selected' : ''}>${T[code].languageName}</option>`;
  const link = (code) =>
    `<a href="${paths[code]}" lang="${T[code].htmlLang}" hreflang="${T[code].htmlLang}"${code === lang ? ' aria-current="true"' : ''}>${T[code].languageName}</a>`;
  return `<div class="fp-lang-bar" role="region" aria-label="${t.bar.label}" data-language-bar>
    <div class="fp-wrap">
      <p data-language-text data-suggest-title="${esc(other.bar.suggestTitle)}" data-suggest-line="${esc(other.bar.suggestLine)}" data-suggest-button="${other.bar.go}"><strong>${t.bar.title}</strong><br><span>${t.bar.line}</span></p>
      <div class="fp-lang-bar-actions" data-language-controls hidden>
        <select aria-label="${t.bar.label}">${option('en')}${option('no')}</select>
        <button type="button" class="fp-lang-bar-go" data-language-continue>${t.bar.go}</button>
      </div>
      <noscript><nav class="fp-lang-bar-links" aria-label="${t.bar.label}">${link('en')}<span aria-hidden="true">|</span>${link('no')}</nav></noscript>
    </div>
  </div>`;
}

function header(lang, paths) {
  const t = T[lang];
  return `<body>
  <a class="fp-skip" href="#main">${lang === 'no' ? 'Gå til innholdet' : 'Skip to content'}</a>
  ${languageBar(lang, paths)}
  <header class="fp-header">
    <div class="fp-wrap fp-header-inner">
      <a class="fp-brand" href="${HOME[lang]}" aria-label="${lang === 'no' ? 'Paperhops forside' : 'Paperhops home'}"><img src="/assets/icons/favicon.svg" width="40" height="40" alt=""><span class="fp-wordmark">Paperhops<span>.</span></span></a>
      <nav aria-label="${lang === 'no' ? 'Hovedmeny' : 'Main navigation'}">
        <a href="${t.root}">${t.navFree}</a>
        <a class="fp-nav-app" href="${HOME[lang]}">${t.navApp}</a>
      </nav>
    </div>
  </header>`;
}

function footer(lang) {
  const t = T[lang];
  return `  <footer class="fp-footer">
    <div class="fp-wrap">
      <p><strong>Paperhops</strong> · ${t.footerTagline}</p>
      <nav class="fp-footer-nav" aria-label="${lang === 'no' ? 'Bunnmeny' : 'Footer'}">${t.footerLinks.map(([label, href]) => `<a href="${href}">${label}</a>`).join('')}<a href="mailto:hello@paperhops.app">hello@paperhops.app</a></nav>
      <p class="fp-muted">${esc(t.copyright)}</p>
    </div>
  </footer>
</body>
</html>
`;
}

function cta(lang, counts) {
  const t = T[lang];
  return `<section class="fp-cta" aria-labelledby="cta-title">
      <div class="fp-wrap fp-cta-inner">
        <p class="fp-eyebrow">${t.ctaNote}</p>
        <h2 id="cta-title">${esc(t.ctaTitle(counts))}</h2>
        <p>${esc(t.ctaBody(counts))}</p>
        <a class="fp-button" href="${HOME[lang]}">${t.ctaButton}</a>
      </div>
    </section>`;
}

function card(href, img, alt, label, sub, extra = '') {
  return `<li class="fp-card${extra}"><a href="${href}"><img src="${img}" width="360" height="360" loading="lazy" alt="${esc(alt)}"><span class="fp-card-title">${esc(label)}</span>${sub ? `<span class="fp-card-sub">${esc(sub)}</span>` : ''}</a></li>`;
}

function pagePath(lang, slug) {
  return `${T[lang].root}${slug}/`;
}

function galleryHtml(lang, pages, counts) {
  const t = T[lang];
  const urlPath = t.root;
  const otherPath = T[t.other].root;
  const first = pages.find((p) => p.level === 1);
  const sections = LEVELS.map((level) => {
    const items = pages
      .filter((p) => p.level === level)
      .map((p) =>
        card(pagePath(lang, p.slug), `/free/files/${p.slug}-sm.png`, t.alt(p.name[lang], level), cap(p.name[lang]), p.dots ? t.galleryDots : ''),
      )
      .join('\n          ');
    return `<section class="fp-level" id="level-${level}" aria-labelledby="level-${level}-title">
        <div class="fp-level-head">
          <h2 id="level-${level}-title"><span class="fp-age fp-age-${level}">${t.ages[level]}</span> ${t.levelName[level]}</h2>
          <p>${t.levelBlurb[level]}</p>
        </div>
        <ul class="fp-grid" role="list">
          ${items}
        </ul>
      </section>`;
  }).join('\n      ');
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: t.galleryH1,
    description: t.galleryDescription(counts),
    url: SITE + urlPath,
    inLanguage: t.htmlLang,
    isPartOf: { '@type': 'WebSite', name: 'Paperhops', url: `${SITE}/` },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: pages.length,
      itemListElement: pages.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: SITE + pagePath(lang, p.slug), name: t.pdfTitle(p.name[lang], p.level) })),
    },
  };
  return `${head({
    lang,
    title: t.galleryTitle,
    description: t.galleryDescription(counts),
    path: urlPath,
    otherPath,
    image: `${BASE}files/${first.slug}.png`,
    imageAlt: t.alt(first.name[lang], 1),
    imageSize: 800,
    jsonld,
  })}
${header(lang, { [lang]: urlPath, [t.other]: otherPath })}
  <main id="main">
    <section class="fp-hero">
      <div class="fp-wrap">
        <h1>${t.galleryH1}</h1>
        <p class="fp-lead">${esc(t.galleryLead(counts))}</p>
        <p class="fp-jump">${t.galleryJump}: ${LEVELS.map((l) => `<a class="fp-age fp-age-${l}" href="#level-${l}">${t.ages[l]}</a>`).join(' ')}</p>
      </div>
    </section>
    <div class="fp-wrap">
      ${sections}
    </div>
    <section class="fp-why" aria-labelledby="why-title">
      <div class="fp-wrap">
        <h2 id="why-title">${t.whyTitle}</h2>
        <ul class="fp-why-grid" role="list">
          ${t.why.map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`).join('\n          ')}
        </ul>
      </div>
    </section>
    ${cta(lang, counts)}
    <section class="fp-wrap fp-use" id="use" aria-labelledby="use-title">
      <h2 id="use-title">${t.useTitle}</h2>
      <p>${esc(t.useBody)}</p>
    </section>
  </main>
${footer(lang)}`;
}

function detailHtml(lang, page, pages, counts) {
  const t = T[lang];
  const name = page.name[lang];
  const urlPath = pagePath(lang, page.slug);
  const otherPath = pagePath(t.other, page.slug);
  const image = `${BASE}files/${page.slug}.png`;
  const alt = t.alt(name, page.level);
  const description = t.pageDescription(name, page.level, !!page.dots);
  const pinUrl = `https://www.pinterest.com/pin/create/button/?url=${encodeURIComponent(SITE + urlPath)}&media=${encodeURIComponent(image)}&description=${encodeURIComponent(t.pageH1(name, page.level))}`;

  const levels = LEVELS.filter((l) => l !== page.level)
    .map((l) => {
      const free = pages.find((p) => p.subject === page.subject && p.level === l);
      return free
        ? card(pagePath(lang, free.slug), `/free/files/${free.slug}-sm.png`, t.alt(name, l), t.ages[l], t.freeHere, ' fp-card-free')
        : card(HOME[lang], `/free/files/app-${page.subject}-${l}.png`, t.alt(name, l), t.ages[l], t.inApp, ' fp-card-locked');
    })
    .join('\n          ');
  const related = pages
    .filter((p) => p.level === page.level && p !== page)
    .map((p) => card(pagePath(lang, p.slug), `/free/files/${p.slug}-sm.png`, t.alt(p.name[lang], p.level), cap(p.name[lang]), ''))
    .join('\n          ');

  const dots = page.dots
    ? `<section class="fp-panel fp-dots" aria-labelledby="dots-title">
        <div class="fp-sheet"><img src="/free/files/${page.slug}-dots.png" width="800" height="800" loading="lazy" alt="${esc(t.dotsAlt(name, page.dots.count))}"></div>
        <div class="fp-panel-copy">
          <h2 id="dots-title">${esc(t.dotsTitle(name))}</h2>
          <p>${esc(t.dotsBody(page.dots.count))}</p>
          <p><a class="fp-button" href="/free/files/${page.slug}-dots.pdf" download="${t.dotsFileName(page.slug)}">${t.dotsDownload}</a> <span class="fp-muted">A4 · ${t.kb(page.dots.bytes)}</span></p>
        </div>
      </section>`
    : '';

  const breadcrumb = [
    [t.breadcrumbHome, SITE + HOME[lang]],
    [t.breadcrumbFree, SITE + t.root],
    [cap(name) + ` (${t.ages[page.level]})`, SITE + urlPath],
  ];
  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ImageObject',
        name: t.pageH1(name, page.level),
        description,
        contentUrl: image,
        thumbnailUrl: `${BASE}files/${page.slug}-sm.png`,
        encodingFormat: 'image/png',
        width: 800,
        height: 800,
        inLanguage: t.htmlLang,
        keywords: page.tags[lang].join(', '),
        creator: { '@type': 'Organization', name: 'Paperhops', url: `${SITE}/` },
        creditText: 'Paperhops',
        copyrightNotice: t.copyright,
        license: `${SITE}${t.root}#use`,
        acquireLicensePage: `${SITE}${t.root}#use`,
        associatedMedia: { '@type': 'MediaObject', contentUrl: `${BASE}files/${page.slug}.pdf`, encodingFormat: 'application/pdf' },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: breadcrumb.map(([n, item], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item })),
      },
    ],
  };

  return `${head({ lang, title: t.pageTitle(name, page.level), description, path: urlPath, otherPath, image, imageAlt: alt, imageSize: 800, jsonld })}
${header(lang, { [lang]: urlPath, [t.other]: otherPath })}
  <main id="main">
    <div class="fp-wrap">
      <nav class="fp-crumbs" aria-label="${lang === 'no' ? 'Brødsmuler' : 'Breadcrumb'}"><a href="${t.root}">${t.breadcrumbFree}</a> <span aria-hidden="true">›</span> <a href="${t.root}#level-${page.level}">${t.ages[page.level]}</a> <span aria-hidden="true">›</span> <span aria-current="page">${esc(cap(name))}</span></nav>
      <section class="fp-panel fp-main" aria-labelledby="page-title">
        <div class="fp-sheet"><img src="/free/files/${page.slug}.png" width="800" height="800" fetchpriority="high" alt="${esc(alt)}"></div>
        <div class="fp-panel-copy">
          <p class="fp-age fp-age-${page.level}">${t.ages[page.level]} · ${t.levelName[page.level]}</p>
          <h1 id="page-title">${esc(t.pageH1(name, page.level))}</h1>
          <p class="fp-lead">${esc(t.pageLead(name, page.level))}</p>
          <p><a class="fp-button" href="/free/files/${page.slug}.pdf" download="${t.fileName(page.slug)}">${t.download}</a> <span class="fp-muted">A4 · ${t.kb(page.bytes)}</span></p>
          ${t.letterTip ? `<p class="fp-muted fp-small">${t.letterTip}</p>` : ''}
          <p class="fp-small"><a href="${esc(pinUrl)}" rel="noopener" target="_blank">${t.pin}</a></p>
          <p class="fp-tags"><span class="fp-muted">${t.tags}:</span> ${page.tags[lang].map((tag) => `<span>${esc(tag)}</span>`).join(' ')}</p>
        </div>
      </section>
      ${dots}
      <section class="fp-section" aria-labelledby="levels-title">
        <h2 id="levels-title">${esc(t.levelsTitle(name))}</h2>
        <p>${t.levelsBody}</p>
        <ul class="fp-grid fp-grid-small" role="list">
          ${levels}
        </ul>
      </section>
    </div>
    ${cta(lang, counts)}
    <div class="fp-wrap">
      <section class="fp-section" aria-labelledby="related-title">
        <h2 id="related-title">${esc(t.relatedTitle(page.level))}</h2>
        <ul class="fp-grid" role="list">
          ${related}
        </ul>
      </section>
      <section class="fp-section fp-use" aria-labelledby="use-title">
        <h2 id="use-title">${t.useTitle}</h2>
        <p>${esc(t.useBody)}</p>
      </section>
    </div>
  </main>
${footer(lang)}`;
}

function sitemapXml(pages) {
  const urls = [T.en.root, ...pages.map((p) => pagePath('en', p.slug))].map((enPath) => {
    const noPath = enPath.replace(/^\/free\//, '/free/no/');
    const alts = `<xhtml:link rel="alternate" hreflang="en" href="${SITE + enPath}"/><xhtml:link rel="alternate" hreflang="nb" href="${SITE + noPath}"/><xhtml:link rel="alternate" hreflang="x-default" href="${SITE + enPath}"/>`;
    return [enPath, noPath].map((p) => `  <url><loc>${SITE + p}</loc>${alts}</url>`).join('\n');
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const { free, text, SUBJECTS, outlines } = await loadContent();

  // Start clean so a page dropped from FREE_PAGES disappears from the site too.
  for (const dir of ['files', 'no']) await rm(path.join(OUT, dir), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const entry of await readdir(OUT, { withFileTypes: true })) {
    if (entry.isDirectory() && /-\d$/.test(entry.name)) await rm(path.join(OUT, entry.name), { recursive: true });
  }
  await mkdir(FILES, { recursive: true });

  const pages = [];
  for (const level of LEVELS) {
    for (const subject of free[level]) {
      const category = SUBJECTS[subject];
      const id = `${category}-${subject}-${level}`;
      const drawing = outlines.get(id);
      if (!category || !drawing) throw new Error(`No drawing ${id}`);
      if (!text.en[subject] || !text.no[subject]) throw new Error(`No title for ${subject}`);
      pages.push({
        subject,
        level,
        slug: `${subject}-${level}`,
        id,
        drawing,
        name: { en: lower(text.en[subject].title), no: lower(text.no[subject].title) },
        tags: { en: text.en[subject].tags, no: text.no[subject].tags },
      });
    }
  }

  for (const page of pages) {
    const svg = await appFile(`assets/outlines/${page.id}.svg`);
    const pdf = await buildPdf({
      svg,
      title: T.en.pdfTitle(page.name.en, page.level),
      keywords: [page.name.en, 'colouring page', 'coloring page', ...page.tags.en],
      lang: 'en',
    });
    page.bytes = pdf.length;
    await writeFile(path.join(FILES, `${page.slug}.pdf`), pdf);
    await writeFile(path.join(FILES, `${page.slug}.png`), await buildPng(svg, 800));
    await writeFile(path.join(FILES, `${page.slug}-sm.png`), await buildPng(svg, 360));

    if (page.level === 1 && page.drawing.dots && page.drawing.dotPoints?.length) {
      const dotsSvg = await appFile(`assets/outlines/${page.id}-dots.svg`);
      const dotsPdf = await buildPdf({
        svg: dotsSvg,
        dots: page.drawing,
        title: T.en.dotsPdfTitle(page.name.en),
        keywords: [page.name.en, 'dot-to-dot', 'connect the dots', ...page.tags.en],
        lang: 'en',
      });
      await writeFile(path.join(FILES, `${page.slug}-dots.pdf`), dotsPdf);
      const withDots = dotsSvg.replace(/<\/svg>\s*$/, `${dotsMarkup(page.drawing)}</svg>`);
      await writeFile(path.join(FILES, `${page.slug}-dots.png`), await buildPng(withDots, 800));
      page.dots = { count: page.drawing.dotPoints.length, bytes: dotsPdf.length };
    }

    // Small previews of the subject's other levels, which are in the app.
    for (const level of LEVELS) {
      if (level === page.level || pages.some((p) => p.subject === page.subject && p.level === level)) continue;
      const other = await appFile(`assets/outlines/${SUBJECTS[page.subject]}-${page.subject}-${level}.svg`);
      await writeFile(path.join(FILES, `app-${page.subject}-${level}.png`), await buildPng(other, 360));
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const subjects = new Set([...outlines.values()].map((d) => d.subject ?? d.id)).size;
  const counts = {
    free: pages.length,
    dots: pages.filter((p) => p.dots).length,
    more: outlines.size - pages.length,
    subjects,
  };

  for (const lang of ['en', 'no']) {
    const dir = lang === 'en' ? OUT : path.join(OUT, 'no');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'index.html'), galleryHtml(lang, pages, counts));
    for (const page of pages) {
      await mkdir(path.join(dir, page.slug), { recursive: true });
      await writeFile(path.join(dir, page.slug, 'index.html'), detailHtml(lang, page, pages, counts));
    }
  }
  await writeFile(path.join(OUT, 'sitemap-free.xml'), sitemapXml(pages));
  console.log(`Built ${pages.length} pages (${counts.dots} with dot-to-dot) in ${path.relative(process.cwd(), OUT) || OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
