---
name: helm-web
description: Craft standards for making a website or full-stack web app real (stack choice, routing, rendering, forms, accessibility, responsive layout, performance, SEO, secrets, security headers, consent, checks, browser evidence, and deployment). Use when you are a Helm Web platform builder or the solo lead of a Helm web project.
---

# Helm Web Craft

Excellent web work is a site that loads fast on a mid-range phone over a slow network, works with a keyboard and a screen reader, still submits its forms when JavaScript fails, leaks no secret into the browser, sends real security headers, and has screenshots and passing checks to prove all of it. `helm-specialist` covers how you work inside Helm. This skill covers what good web work looks like.

Your default write scope is `apps/web/**`, `infra/**`, `deploy/**` and `reports/web/**`. Your BRIEF wins if it differs. You own the web app shell: routing, pages, data loading, server endpoints that belong to the web tier, configuration, build, and deployment. The UI builder owns components and design tokens. The Core builder owns the API and business logic. You wire them together exactly as CONTRACT.md says. If you are the solo lead, you own all of it, plus ARCHITECTURE.md, DECISIONS.md and `.helm/checks.json`.

---

## 1. Choose a boring stack and record it

- **Pick by need, then justify in one paragraph.** Defaults as of late 2026:
  - **Full-stack app with accounts, dashboards, forms, server logic:** a React meta-framework, normally Next.js (App Router), or React Router in framework mode. Pick SvelteKit if the team or SPEC prefers Svelte.
  - **Content site (marketing, docs, blog, portfolio):** Astro, with islands only where interaction is needed. Next.js static export is fine if the site will grow into an app.
  - **Pure client app behind a login with no SEO needs:** Vite plus React or Svelte, with a client router.
- **Use TypeScript with `strict` on.** Use the framework's official starter (`npx create-next-app@latest`, `npx sv create`, `npm create astro@latest`) with current stable versions. Do not hand-assemble webpack configs.
- **Avoid novelty:** no beta features, experimental flags, or extra state library when server data, URL state and component state suffice.
- **Record the decision.** As the builder, send the lead the stack, rendering model, hosting target, package manager, Node version, and the reason (`helm_message`, kind `ask`) so it lands in ARCHITECTURE.md and DECISIONS.md. Those files are the lead's. As the solo lead, write them yourself. Pin the Node version in `.nvmrc` or `engines` and commit the lockfile.
- **Verify every dependency** in the npm registry (exact name, publisher, recent releases, licence) before adding it. `helm-code` section 11 applies in full. Check that the APIs you call exist in the installed version, because framework APIs change between majors.

---

## 2. Layout, app shell and routing

- **Follow the framework's conventions,** not a custom structure: `app/` for Next.js, `src/routes/` for SvelteKit, `src/pages/` for Astro. Put the layout you choose in ARCHITECTURE.md (via the lead) so the UI and Core builders know where their code is imported from.
- **One root layout** holds `<html lang="…">`, the skip link, header, main landmark, footer, theme handling, and global providers. Nested layouts hold section navigation. Do not repeat the shell per page.
- **Routes come from the SPEC.** Every screen in the SPEC has a route, and every route is in the SPEC. URLs are lowercase, hyphenated, stable, and human-readable (`/projects/0193…/settings`, not `/p?id=…&tab=3`).
- **Put shareable state in the URL:** filters, sort, pagination, selected tab, search query. Back and forward must work, and a reload must restore the view.
- **Navigation uses real links** (`<a href>` through the framework's link component) so middle-click, open-in-new-tab and crawlers work. Buttons are for actions, links are for navigation.
- **Protect routes on the server.** A middleware or layout redirect is a UX convenience. Every data load and every mutation also checks the session on the server, because an attacker can call them directly.
- **Loading UI** uses the framework's mechanism (streaming with Suspense boundaries, `loading.tsx`, SvelteKit streaming promises) with a skeleton that matches the final layout, so nothing jumps when data arrives.

---

## 3. Rendering: server first, client where it earns it

- **Default to server rendering or static generation.** Ship HTML that already contains the content. Add client JavaScript only for interaction that needs it: menus, live validation, drag and drop, rich editors.
- **Choose per route and write it down:** static for marketing, docs and legal pages; static with revalidation for listings that change hourly or daily; dynamic server rendering for anything that depends on the session; client-only for highly interactive widgets inside a server-rendered page.
- **Keep the client boundary small.** In React Server Components, mark the smallest interactive leaf with `"use client"`, not the page. Never import server-only modules (database, secrets, SDKs with keys) into client components. Import the `server-only` package in server modules so a mistaken import fails the build.
- **Avoid hydration mismatches.** Do not read `window`, `Date.now()`, random values, or locale-dependent formatting during render without making server and client agree. Format dates with an explicit locale and time zone.
- **Do not call your own API over HTTP from server code** when the Core module can be called directly.

---

## 4. Wiring the UI to the Core per CONTRACT

- **CONTRACT.md is the only interface.** Use the request and response types, error codes, and view models it defines. Never invent an endpoint, field or error code. If you need one, ask the lead for a CONTRACT change and build against the current version meanwhile.
- **Use one typed client,** generated from or sharing the schemas the Core builder publishes (an OpenAPI-generated client, a shared Zod or Valibot schema package, or tRPC or server actions if the CONTRACT chose them). No hand-written `fetch` calls with `any` types scattered across pages.
- **Compose, do not re-implement.** Pages import the UI builder's components and pass them view models built from Core responses. Do not fork a component to tweak it: ask the UI builder. Do not copy business rules into the web tier: call the Core.
- **Every data-driven view has every state:** loading, empty, error, permission denied, not found, and offline or failed request, as the UI builder's components define them. Map each CONTRACT error code to a user-facing state. Do not show a generic "Something went wrong" for a validation error the user can fix.
- **Mutations:** disable double submission, show pending state, and update the UI from the server's response. Use optimistic updates only where the CONTRACT says the operation is safe to roll back, and roll back visibly on failure. Send an idempotency key where the CONTRACT defines one.
- **Timeouts:** every client request has one and is aborted (`AbortController`) on navigation away.
- **Before the Core is ready,** build against a mock server that serves CONTRACT examples (for example MSW) in development and tests only. The mock never ships, and no production code path imports it.

---

## 5. Forms with progressive enhancement

- **Start with a real `<form>`** with `method` and `action` that works with JavaScript disabled, using the framework's server mutation mechanism (Next.js Server Actions, SvelteKit form actions with `use:enhance`, React Router actions, Astro actions). Then enhance with client validation and pending UI.
- **Validate on the server, always,** with the same schema the Core uses. Client validation is a convenience and never the only check.
- **Every input has a visible `<label>`.** Placeholders are not labels. Group related controls with `<fieldset>` and `<legend>`.
- **Use the right `type`, `inputmode` and `autocomplete`** (`email`, `tel`, `current-password`, `new-password`, `one-time-code`, `postal-code`) so mobile keyboards and password managers work. Never block paste into password fields.
- **Errors:** show them next to the field, connect them with `aria-describedby`, set `aria-invalid="true"`, and on submit move focus to an error summary that links to each field. Keep the user's input after a failed submit. Return all field errors at once.
- **No redundant entry** (WCAG 3.3.7): do not ask for information the user already gave in the same process.
- **Accessible authentication** (WCAG 3.3.8): no cognitive tests such as puzzles or memorised transcription. Support password managers and paste, and prefer passkeys, email links or one-time codes.
- **Spam:** server-side rate limits (`helm-backend` section 7) and a honeypot before any CAPTCHA, which needs consent and an account (`helm_need`).

---

## 6. Accessibility: WCAG 2.2 AA is a requirement

Accessibility failures block review. Test them, do not assume them.

- **Semantics first.** Use landmarks (`header`, `nav`, `main`, `footer`), one `h1` per page with a logical heading order, lists for lists, tables with `<th scope>` for tabular data, and `<button>` for actions. Use ARIA only when no native element exists, and then follow the WAI-ARIA Authoring Practices pattern exactly.
- **Keyboard:** everything works with Tab, Shift+Tab, Enter, Space, Escape and the arrow keys where the pattern expects them. Focus order follows visual order. No keyboard traps. A skip link goes to `main`.
- **Focus visible and not obscured** (WCAG 2.4.7, 2.4.11): a clear focus ring with at least 3:1 contrast, never `outline: none` without a replacement. Sticky headers and cookie banners must not cover the focused element (use `scroll-padding-top`).
- **Target size** (WCAG 2.5.8): interactive targets at least 24 by 24 CSS pixels, or spaced so a 24 px circle fits. Aim for 44 px on touch-first layouts.
- **Dragging** (WCAG 2.5.7): anything done by dragging also has a single-pointer alternative (buttons, a menu).
- **Contrast:** text 4.5:1, large text 3:1, UI components and focus indicators 3:1, in both themes.
- **Route changes in client navigation:** move focus to the new page's `h1` or announce the new title, and update `document.title`.
- **Dialogs:** native `<dialog>` with `showModal()` or a proven primitive; Escape closes and focus returns to the trigger.
- **Motion:** honour `prefers-reduced-motion`; nothing flashes more than three times a second; auto-play can be paused.
- **Images:** specific `alt` text, `alt=""` if decorative; icon-only buttons have an accessible name.
- **Zoom and reflow:** content works at 200% zoom and reflows at a 320 CSS px viewport without horizontal scrolling (WCAG 1.4.10). Never disable zoom in the viewport meta tag.
- **Consistent help** (WCAG 3.2.6): help links sit in the same place on every page.
- **Automated checks are a floor:** run axe on every route in Playwright (section 16) with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, and fail the test on any violation. Then do a manual keyboard pass of each key flow and note it in your report. Automated tools find only part of the issues.

---

## 7. Responsive layout and themes

- **Mobile first.** Write base styles for the narrowest screen and add `min-width` media queries or container queries as space allows. Test at 320, 375 or 390, 768, 1024, 1280 and 1440 CSS px.
- **Fluid by default:** `max-width` containers, `clamp()`, grid and flexbox, no fixed widths on content; long words and URLs wrap (`overflow-wrap: anywhere`).
- **Use the UI builder's tokens** (CSS custom properties); no hard-coded hex values in pages.
- **Light and dark themes:** follow `prefers-color-scheme` by default, allow an explicit choice persisted in a cookie (so the server renders the right theme with no flash) or local storage with a small inline script in `<head>`, and set `color-scheme` so form controls and scrollbars match.
- **Viewport:** `<meta name="viewport" content="width=device-width, initial-scale=1">`; use `dvh` for full-height mobile layouts and respect safe-area insets.

---

## 8. Performance budgets (Core Web Vitals)

Performance is a requirement only when a check fails if you miss it.

- **Targets at the 75th percentile, mobile:** Largest Contentful Paint 2.5 s or less, Interaction to Next Paint 200 ms or less, Cumulative Layout Shift 0.1 or less. These are Google's "good" thresholds.
- **Lab budgets in CI** (record them in ACCEPTANCE via the lead): Lighthouse performance score of at least 90 on mobile emulation for key routes, initial JavaScript for a content page in the tens of kilobytes compressed and for an app route under roughly 200 KB compressed, no render-blocking third-party scripts, and total page weight stated per key route. Set your own numbers from the SPEC and keep them.
- **Measure:** run Lighthouse against a production build (`npm run build` then the framework's start or preview command), never the dev server. For example `npx lighthouse http://localhost:3000/ --output=json --output-path=reports/web/lighthouse/home.json --chrome-flags="--headless=new"`. Lighthouse CI (`@lhci/cli`, `lhci autorun`) can assert budgets in CI.
- **Usual causes:** large client bundles (use the bundle analyser), unoptimised hero images, blocking fonts, images without dimensions, late banners, heavy hydration, and sequential data fetches (fetch in parallel).
- **Caching:** hashed static assets get `Cache-Control: public, max-age=31536000, immutable`. HTML gets a short or no-cache policy appropriate to its rendering mode. Never cache personalised responses in a shared cache (`private` or `no-store`).
- **INP:** keep event handlers short, defer non-urgent work (`startTransition`, `requestIdleCallback`, or yielding), and virtualise long lists.

---

## 9. SEO and metadata

- **Every public page has** a unique `<title>`, a meta description, a canonical URL, `lang` on `<html>`, Open Graph and Twitter card tags, and a share image of 1200 by 630 px. Use the framework's metadata API (Next.js `metadata` or `generateMetadata`, SvelteKit `<svelte:head>`, Astro layout props).
- **`robots.txt` and `sitemap.xml`** are generated from the route list, with absolute URLs on the production origin. Private and authenticated pages are excluded and marked `noindex`.
- **Preview and staging deployments send `X-Robots-Tag: noindex`** so they never compete with production.
- **Structured data** (JSON-LD with schema.org types such as `Organization`, `Article`, `Product`, `BreadcrumbList`) only where it truthfully describes the page. Validate it with Google's Rich Results Test before claiming it works.
- **Real status codes:** a missing page returns 404, a moved page returns 301 or 308 to its new URL, and an error returns 5xx. A "not found" page served with 200 is a soft 404.

---

## 10. Images, fonts and assets

- **Images:** always set `width` and `height` (or `aspect-ratio`) to prevent layout shift. Serve AVIF or WebP with responsive `srcset` and `sizes` through the framework's image component (`next/image`, Astro `<Image>`, `@sveltejs/enhanced-img`). Lazy-load below the fold. Give the likely LCP image `fetchpriority="high"` and do not lazy-load it.
- **Fonts:** self-host (the framework font loader such as `next/font` does this), subset to the scripts you need, use at most two families and few weights (or one variable font), set `font-display: swap`, and use a size-adjusted fallback to limit shift. Check the font licence allows web embedding.
- **Real content only:** copy from the SPEC or the UI builder, no lorem ipsum, no placeholder stock images, nothing you lack rights to. If assets are missing, use a neutral designed treatment and tell the lead.

---

## 11. Environment variables and secrets

- **Secrets never reach the client bundle.** Only variables with the framework's public prefix are exposed to the browser: `NEXT_PUBLIC_` in Next.js, `PUBLIC_` in SvelteKit (`$env/static/public`) and Astro, `VITE_` in Vite. Anything with that prefix is public. API keys, database URLs, signing secrets and tokens never get it.
- **Verify after building:** search the built client output for secret names and value patterns, for example `grep -rE "sk_live_|sk_test_|DATABASE_URL|PRIVATE_KEY" .next/static dist build 2>/dev/null` (adjust to your framework's output folder). The check must find nothing. Add it to your checks.
- **Validate configuration at startup** with a schema (required variables, formats) and fail fast with a clear message naming the missing variable but never printing its value.
- **Commit `.env.example`** with every variable name, a comment, and a safe placeholder. Never commit `.env`, `.env.local` or any file with a real value. Confirm `.gitignore` covers them.
- **Real keys come from the human only.** Ask once with `helm_need {about: "credentials"}`, then keep building with test-mode keys, local services, or a clearly marked disabled state. Never paste a key into code, a test, a report, or a commit message.
- **Hosting secrets** live in the host's or CI's secret store, set by the human. List the variable names per environment in `deploy/README.md`.

---

## 12. Security headers, CSP, CSRF and cookies

Coordinate with the Security agent: they review and file findings; you implement the controls in your scope.

- **Headers on every response,** set in middleware, the framework config, or the host config:
  - `Content-Security-Policy`: start from `default-src 'self'`, use nonces with `'strict-dynamic'` for scripts where the framework supports it, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` (or the allowed embedders), `form-action 'self'`. No `'unsafe-inline'` for scripts and no wildcard sources. Roll a new CSP out with `Content-Security-Policy-Report-Only` first if the app is already live.
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains` on HTTPS production only. Add `preload` only with the human's agreement, because it is hard to undo.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that disables features you do not use (camera, microphone, geolocation), and `X-Frame-Options: DENY` for older browsers.
- **Verify** with `curl -sI http://localhost:3000/ | grep -iE "content-security|strict-transport|x-content-type|referrer|permissions|x-frame"` against the production build, and commit the output.
- **Cookies:** session cookies are `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`), `Path=/`, and use the `__Host-` prefix when no `Domain` is needed. Never store tokens in `localStorage`.
- **CSRF:** every state-changing request uses POST, PUT, PATCH or DELETE, never GET. Keep the framework's built-in protection on (Next.js Server Actions compare `Origin` with the host; SvelteKit's `checkOrigin` is on by default). Custom endpoints that use cookie auth check `Origin` or use a CSRF token.
- **XSS:** let the framework escape output. `dangerouslySetInnerHTML`, `{@html}` and `set:html` are allowed only for sanitised HTML (DOMPurify or a server-side sanitiser) with a comment saying where it was sanitised.
- **Redirects:** check any redirect target from a query parameter against an allowlist of relative paths.
- **CORS:** same-origin by default. If the API must be called cross-origin, allow exact origins, and never reflect `Origin` together with credentials.

---

## 13. Error, 404 and degraded states

- **Custom 404 and error pages** in the framework's convention (Next.js `not-found.tsx`, `error.tsx`, `global-error.tsx`; SvelteKit `+error.svelte`; Astro `404.astro` and `500.astro`), styled with the site shell, a clear sentence, a link home or to search, and the correct status code.
- **Error pages never show stack traces, SQL, internal paths or environment details.** Show a short reference ID that matches a server log entry.
- **Error boundaries** around independent regions, so one failed widget does not blank the page.
- **Server errors are logged on the server** with the request ID and without personal data or secrets (`helm-backend` section 15).
- **Network failure:** failed fetches show a retry action and keep the user's input. Register a service worker only if the SPEC requires offline support, with a tested update path.

---

## 14. Analytics only with consent

- **No analytics, tracking pixels, session replay, or marketing scripts unless the SPEC asks for them.** If it does, nothing non-essential loads or sets cookies before the user agrees.
- **Consent banner:** equal-weight Accept and Reject buttons, no pre-ticked boxes, a way to change the choice later (a footer link), and the choice stored in a first-party cookie. It must be keyboard-accessible and must not cover focused content.
- **Prefer privacy-friendly, cookieless analytics** with no personal data. Never send emails, names, user IDs, free text, or full URLs with tokens or IDs in their query strings to an analytics provider.
- **Third-party scripts** load only after consent, `async` or deferred, are listed in the CSP, and are in the data inventory in SECURITY.md (send the list to the Security agent).
- **An analytics account is the human's** (`helm_need {about: "privacy"}` for collecting data, and `credentials` for the site key).

---

## 15. Checks and CI

- **Scripts in `package.json`:** `build`, `lint` (ESLint with the framework's config, plus `eslint-plugin-jsx-a11y` for React), `typecheck` (`tsc --noEmit`, or `svelte-check` for SvelteKit, `astro check` for Astro), `test` (Vitest for units), and `test:e2e` (Playwright).
- **Declare them in `.helm/checks.json`.** The lead owns that file. Send the lead the exact commands, or write them yourself if you are the solo lead. Example:

  ```json
  {
    "build":     {"command": "npm --prefix apps/web run build", "tier": "local", "timeoutSec": 900, "category": "build"},
    "lint":      {"command": "npm --prefix apps/web run lint", "tier": "local"},
    "typecheck": {"command": "npm --prefix apps/web run typecheck", "tier": "local"},
    "test":      {"command": "npm --prefix apps/web test -- --run", "tier": "local"},
    "e2e":       {"command": "npm --prefix apps/web run test:e2e", "tier": "local", "timeoutSec": 1200},
    "slop-scan": {"command": "helm_slop_scan", "tier": "local"}
  }
  ```

  Commands must run something real. Use `"tier": "ci"` only for checks this machine truly cannot run, and say so in your report.
- **Run checks through the wrapper** so they are inspectable: `.helm/run-check.sh e2e -- npm --prefix apps/web run test:e2e`. Commit first so the trailer records a clean commit.
- **A CI workflow** (GitHub Actions, if `.github/**` is in your scope or the lead agrees) installs with `npm ci`, runs the same commands, installs browsers with `npx playwright install --with-deps chromium`, uploads the Playwright report on failure, and sets `permissions: contents: read`.

---

## 16. Browser testing and screenshots

The gates judge what they can see. Screenshots and an e2e run are your primary evidence.

- **Playwright for e2e:** configure `webServer` in `playwright.config.ts` to start the production build, `baseURL` to its address, and projects for Chromium plus WebKit and Firefox where available. Cover every ACCEPTANCE flow: sign up and sign in if present, the main create, read, update and delete flows, form errors, 404, and permission denied.
- **Select by role and label** (`getByRole`, `getByLabel`), not CSS classes.
- **Accessibility in e2e:** `@axe-core/playwright` on each route, for example `const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze(); expect(results.violations).toEqual([]);`.
- **Screenshots at three widths in both themes** for every key route: mobile 390 by 844, tablet 768 by 1024, desktop 1440 by 900. In Playwright, `await page.setViewportSize({ width: 390, height: 844 })`, `await page.emulateMedia({ colorScheme: 'dark' })`, then `await page.screenshot({ path: 'reports/web/screens/home-390-dark.png', fullPage: true })`. Wait for fonts and data (`await page.waitForLoadState('networkidle')` or a specific visible element) before capturing.
- **BB browser automation:** if the project tools list `plugin:browser-automation`, you may use it to open a headless session (`bb browser-automation open --backend local --headless --machine <host-id> --json`), navigate to the local preview, snapshot, act, and capture screenshots. Copy captures into `reports/web/` before closing the session, because closing removes its temporary files. Run `bb browser-automation --help` for exact flags rather than guessing. Use the local or headless backend, not the user's signed-in desktop browser, unless your brief says otherwise. If the plugin is not listed, use Playwright.
- **Look at your screenshots** for overflow, clipped text, overlaps, poor dark-mode contrast and placeholder content. A screenshot you did not inspect is not evidence.
- **Test with realistic dev data** (clearly fake people, `example.com` addresses), including long names, empty lists and many items.

---

## 17. Deployment

- **Default: local production build plus preview.** Without credentials, "deployed" means `npm run build` succeeds, the production server or static preview runs locally, the e2e suite passes against it, and the deploy configuration is committed and ready.
- **Choose a target by need and record it via the lead:** Vercel or Netlify for framework-native hosting with preview deployments, Cloudflare Pages or Workers for edge and static sites, Fly.io or any container host for long-running servers, websockets, or background workers alongside the web app. Use the framework's official adapter for the target.
- **Containers:** a multi-stage `Dockerfile` that runs as a non-root user, copies only the build output and production dependencies, exposes one port, and has a health check. Verify it with `docker build` and a local run if Docker is listed in the project tools.
- **Real accounts, real domains, and paid plans need the human.** Deploying to a real account, attaching a real domain, changing DNS, or anything that can bill needs `helm_need` (`credentials` for tokens, `spending` for paid plans, `access` for DNS or an organisation). Ask once, keep building locally, and never create accounts or enter payment details yourself.
- **Configuration as code** under `deploy/` or `infra/`: the host config file (`vercel.json`, `netlify.toml`, `wrangler.toml`, `fly.toml`, or the Dockerfile), headers, redirects, and a `deploy/README.md` listing each environment, its required variables (names only), and the exact deploy and rollback steps.
- **Environments:** previews use test-mode keys and a separate database. Production deploys come from the integration branch through CI, not a laptop.
- **After an approved real deploy,** smoke-test the live URL (status codes, headers, key flow) and commit the output.

---

## Done means

**Stack and structure**
- [ ] The stack, rendering model per route, hosting target and Node version are recorded in ARCHITECTURE.md and DECISIONS.md (by the lead, or by you as solo lead). The lockfile is committed.
- [ ] Every SPEC screen has a route, URLs are stable and readable, and shareable state lives in the URL.
- [ ] Every data load and mutation checks the session and ownership on the server.

**Wiring and forms**
- [ ] All API calls go through one typed client matching the current CONTRACT version. No invented endpoints or fields.
- [ ] Every data view has loading, empty, error, permission-denied and not-found states, and every CONTRACT error code maps to a state.
- [ ] Key forms submit with JavaScript disabled, validate on the server, show accessible field errors, and keep input after failure.

**Accessibility and layout**
- [ ] axe reports zero violations for WCAG 2.2 A and AA tags on every route, and a manual keyboard pass of key flows is recorded.
- [ ] Focus is visible and not obscured, targets are at least 24 px, contrast passes in both themes, and reduced motion is honoured.
- [ ] Layouts work from 320 px to 1440 px with no horizontal scroll, and light and dark themes render with no flash.

**Performance and SEO**
- [ ] Lighthouse on the production build meets the ACCEPTANCE budgets on key routes, with no layout shift from images or fonts.
- [ ] Public pages have unique titles, descriptions, canonical URLs and share images. `robots.txt` and `sitemap.xml` exist. Previews are `noindex`. 404s return 404.

**Security and privacy**
- [ ] No secret in the client build (grep check passes), `.env.example` is committed, and no `.env` file is tracked.
- [ ] CSP, HSTS (production), nosniff, Referrer-Policy, Permissions-Policy and frame protection are present on responses. Cookies are HttpOnly, Secure and SameSite. CSRF protection is on.
- [ ] No analytics or third-party script loads before consent, and any that exist are listed for SECURITY.md.

**Checks and deployment**
- [ ] `build`, `lint`, `typecheck`, `test` and `e2e` exist, are declared in `.helm/checks.json`, and exited 0 through `.helm/run-check.sh` on your last commit.
- [ ] `helm_slop_scan` is clean for your files: no placeholders, lorem ipsum, mock data on shipped paths, debug logging or secrets.
- [ ] Deploy configuration and `deploy/README.md` are committed. Any real deployment, domain or paid plan was approved through `helm_need`.

## Evidence to commit

Under `reports/web/` (for example `reports/web/<task>/`):
- `screens/<route>-<width>-<theme>.png` for every key route at 390, 768 and 1440 px, light and dark, plus 404 and one form error state.
- `e2e/summary.txt`: the Playwright run summary (passed, failed, skipped per project) and the browsers used. Commit the HTML report only if it is small.
- `a11y/axe-summary.json` (or a text summary per route) and `a11y/keyboard-pass.md`: the routes and flows checked by keyboard and what was found.
- `lighthouse/<route>.json` (or a summary of the four category scores and the Core Web Vitals lab metrics per route) and the budgets they were compared against.
- `headers.txt`: `curl -sI` output for the home page and one authenticated route, showing the security headers and cookie attributes.
- `bundle.txt`: the client-bundle secret grep (empty result) and the main route bundle sizes.
- `ENV.txt`: Node, package manager, framework version, browsers, OS, and the exact commands run.
- If deployed with approval: `deploy/smoke.txt` with the live URL's status codes and headers.

## Sources

- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- What's new in WCAG 2.2: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- WAI-ARIA Authoring Practices Guide: https://www.w3.org/WAI/ARIA/apg/
- web.dev, Core Web Vitals: https://web.dev/articles/vitals
- MDN, Content Security Policy: https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
- MDN, Set-Cookie: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
- OWASP HTTP Security Response Headers Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
- OWASP Cross-Site Request Forgery Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Next.js documentation: https://nextjs.org/docs
- SvelteKit documentation: https://svelte.dev/docs/kit
- Astro documentation: https://docs.astro.build/
- Playwright documentation: https://playwright.dev/docs/intro
- Playwright accessibility testing: https://playwright.dev/docs/accessibility-testing
- Lighthouse CI: https://github.com/GoogleChrome/lighthouse-ci
- Google Search Central, SEO starter guide: https://developers.google.com/search/docs/fundamentals/seo-starter-guide
- European Data Protection Board, guidelines on consent: https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en
