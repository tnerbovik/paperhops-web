# Paperhops website

Static website for [paperhops.app](https://paperhops.app), hosted on GitHub Pages under the tnerbovik account. Paperhops is an iPhone and iPad app with printable colouring pages and dot-to-dots for kids aged 3 to 10.

The site is plain HTML with two shared stylesheets (`assets/theme.css` for the design tokens, `assets/site.css` for the layout) and no build step. Navigation works without JavaScript; `assets/language.js` only handles the language choice.

## Pages

| English | Norwegian (bokmål) | Content |
| --- | --- | --- |
| `/` | `/no/` | Landing page: the three levels, dot-to-dot, subjects, printing, Free and Pro |
| `/privacy/` | `/no/privacy/` | Privacy policy |
| `/terms/` | `/no/terms/` | Copyright and use, mirroring the in-app page (`copyright*` keys in the app's `src/i18n/en.ts` and `no.ts`) |
| `/support/` | `/no/support/` | FAQ: printing, paper size, restore purchases, Family Sharing, refunds, contact |
| `/404.html` | | Not-found page |

`/free/` (free printable colouring pages) and `tools/` are a separate section built on their own. The marketing pages link to `/free/` from the header, the hero, a teaser section and the footer; each link is marked with a `FREE PAGES SLOT` comment.

## Launch checklist

The app is not in the App Store yet. Search for `TODO(launch)`:

- Replace the placeholder `https://apps.apple.com/app/paperhops` with the real App Store URL (header button and both badges, on every page).
- Remove the "Coming soon to the App Store" / "Kommer snart i App Store" notes.

The contact address on every page is tnerbovik@gmail.com for now. hello@paperhops.app forwards through Dynadot's free email forwarding, but Gmail rejects mail from Dynadot's forwarding servers as likely spam (550 5.7.1, October 2026). Switch the domain's MX to a forwarder Gmail accepts (such as ImprovMX) before putting hello@ back.

## Languages

English lives at the root and Norwegian under `/no/`, with the same page paths. Every translated page declares its counterpart with `<link rel="alternate" hreflang="…">`.

Every page starts with a language bar above the header, like apple.com's. Without JavaScript it shows plain English | Norsk links. `assets/language.js` swaps those for a language menu (✓ on the choice) and a Continue button, which opens the same page in the chosen language and remembers the choice; pages without a counterpart, like the 404 page, go to that language's front page. The site never redirects by itself: when the browser languages (nb, nn, no or en) or an earlier choice prefer the other language, the bar's text switches to a suggestion in that language ("Se Paperhops på norsk." / "View Paperhops in English.") with that language preselected. Add `?lang-suggest=1` to a URL to force the suggestion while testing.

Run the tests with `node --test tests/`.

## Message and look

The site speaks to parents and grandparents who want a child off the tablet for a while: "Less screen. More life." The landing page has a "Why paper" section (calm focus, busy hands, their own ideas, time together; modest claims, no statistics) and a grandparents section. Titles and descriptions use phrases people search for: printable colouring pages, colouring pages for kids, less screen time, skjermfri, fargeleggingsark.

Colours, radii, shadows and fonts are the app's design tokens (`src/constants/colors.ts` and `theme.ts` in the app project), defined once in `assets/theme.css` with a `prefers-color-scheme: dark` variant. Every page, including `/free/`, links it before its own stylesheet. `--brand-*` crayons (tomato, sunflower, sky, leaf, plum) are only for drawings, decorative marks and large shapes; text uses `--color-tint` or a `--color-*-ink` on its `--color-*-soft` fill, which keeps contrast at 4.5:1 or more. The age levels use sky (3–5), leaf (6–8) and plum (9+), as in the app. Headings use Fredoka 500/600, self-hosted from `assets/fonts/` (subset to Latin, SIL Open Font License in `assets/fonts/OFL.txt`) so the site makes no third-party requests. Drawings always sit on white sheets, in both light and dark mode.

## Asset sources

- Drawings in `assets/drawings/`: unchanged SVGs from the app project's `assets/outlines/` (lion at levels 1–3, stegosaurus and its dot-to-dot, unicorn, whale).
- Icons in `assets/icons/`, `favicon.ico` and the social previews (`assets/social-preview.png`, `assets/social-preview-no.png`, 1200×630): rendered with resvg from the app's brand mark (`src/constants/mark.ts`, same geometry as `MarkTile` in `src/components/brand/mark.tsx`) and Fredoka.
- App Store badges: Apple's official English and Norwegian artwork, used unchanged.

## Local preview

Run `python3 -m http.server 8765` from this directory, then open http://localhost:8765. (Python's server does not serve `404.html` for missing pages; GitHub Pages does.)

## GitHub Pages

Pages publishes the `main` branch from the repository root. The custom domain is `paperhops.app`; the `CNAME` file keeps it for branch deployments. Enable Enforce HTTPS once GitHub has issued the certificate. `.app` domains only work over HTTPS, so the site is not reachable in browsers until the certificate exists.

## DNS

Set these records at the registrar for paperhops.app. Remove any other A, AAAA or CNAME records for `@` and `www` (for example a registrar parking page), but keep unrelated records such as MX (email) and TXT verification records.

| Type | Name | Value |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | tnerbovik.github.io |

On 25 October 2026 the domain used Dynadot name servers, and public DNS (1.1.1.1) already returned exactly these A, AAAA and `www` CNAME records.

GitHub redirects `www.paperhops.app` to `paperhops.app` once both are correct. To protect the domain from takeover, verify it under GitHub → Settings → Pages → Verified domains; GitHub then shows a TXT record (`_github-pages-challenge-tnerbovik`) to add at the registrar.
