---
name: helm-ui
description: Interface craft (tokens, type, colour, layout, every state, both themes, WCAG 2.2 AA, screenshots on the human's devices). Use when you are a Helm UI builder.
---

# Helm UI Craft

This skill covers what good UI work looks like. `helm-specialist` covers how you work inside Helm. The goal is a product a professional designer would sign off on: built from a system, true to its domain, complete in every state, and usable by everyone, on a small phone, with a screen reader, or at 200% text size.

The standard is simple. If someone could swap your screen into a different app by changing only the logo, the screen is generic. Do it again.

---

## 1. Start from the domain, not a template

Before writing any UI code, spend five minutes on these questions and write the answers down:

- **Who is the user, and what is their main job on this screen?** Name one primary action per screen. Everything else is secondary and should look it.
- **What vocabulary, artefacts, and habits does the domain have?** A climbing log has grades, crags, and attempts. A clinic rota has shifts, cover, and handovers. A ledger has debits, reconciliations, and periods. Use these words in labels, empty states, and sample data, and let them shape the layout. A ledger wants dense, aligned tabular numbers. A journaling app wants generous measure and a quiet page.
- **What does the user already know?** Follow platform conventions (iOS navigation, Material components, standard web forms). Spend originality on identity and content, not on reinventing a back button.
- **What is the one memorable thing?** Choose a single place to be bold, such as a distinctive typeface pairing, a signature colour, an unusual data visualisation, or a characteristic illustration style. Keep everything else quiet. Boldness everywhere reads as noise.

Read the data shapes in CONTRACT.md before designing. Field lengths, optionality, enums, and list sizes decide your layouts. A `title` that can be 200 characters long, or a list that can hold 10,000 rows, is a design input, not a surprise to discover in QA.

---

## 2. Design tokens first

Hard-coded values are the main cause of inconsistent UI. Define tokens before components, and make components consume only tokens.

**Token layers**

1. **Primitive** (raw palette and scales): `blue-600`, `space-4`, `radius-2`. Never referenced directly by components.
2. **Semantic** (role-based): `color.bg.surface`, `color.text.secondary`, `color.border.subtle`, `color.action.primary`, `color.status.danger`, `space.inset.card`, `radius.control`. Components use these.
3. **Component** (optional, where a component needs its own knob): `button.primary.bg`.

Themes, light and dark, swap the semantic layer. If a component has a `#hex` or a magic number in it, it is a bug.

**Rules**

- Put tokens in one file or module per platform (CSS custom properties, a Swift `Theme`, a Compose `ColorScheme` plus `Typography`, a TS object). Name them by role, never by appearance: `text.secondary`, not `grey-text`.
- Keep a short written token plan at the top of the token file: 4 to 8 named colours with their roles, the type scale, the spacing scale, and the radius and elevation values. One paragraph explaining the visual idea is enough.
- If you need a value that does not exist, add a token. Do not inline it.

---

## 3. Typography

Type does most of the work in an interface. Get it right and plain layouts look designed.

- **One or two families at most.** A good pairing is one expressive face for display and headings and one highly legible face for UI and body text. On native platforms, the system font (SF Pro, Roboto) is a strong default for UI text, so use a custom face only where it earns its place. Avoid defaulting to the same geometric sans every AI demo uses. Choose a face because it suits the domain.
- **A deliberate scale.** Pick a ratio (around 1.2 to 1.25 for dense apps, around 1.333 for editorial ones) and stop at 5 to 7 sizes, for example caption, footnote, body, callout, title-3, title-2, title-1, display. Every text element maps to a named style.
- **Hierarchy through weight and colour before size.** Primary text uses full-contrast colour, secondary text uses a muted semantic colour that still passes contrast, and labels use medium weight. Do not make everything bold and do not make everything large.
- **Line length** for body text should be 45 to 80 characters. Constrain the width of reading columns on large screens.
- **Line height** should be about 1.4 to 1.6 for body text and 1.1 to 1.25 for large headings. Serif body text needs a little more leading than sans.
- **Numbers:** use tabular figures for anything compared in columns (prices, times, scores), and right-align numeric columns. Format numbers, dates, currencies, and units for the user's locale. Never hand-build date strings.
- **Sentence case** for headings, buttons, and labels. Avoid all-caps tracked "eyebrow" labels above every heading. That pattern is a strong template tell.
- **Scalable text is mandatory.** Use platform text styles (Dynamic Type on iOS, `sp` and Material type roles on Android, `rem` on web). Section 9 covers the details.

---

## 4. Colour

- **Build a palette with roles:** background, surface, raised surface, primary text, secondary text, border, primary action, focus ring, and status colours (success, warning, danger, info). Each role needs a light and a dark value.
- **Use neutrals with a slight temperature,** warm or cool, chosen to suit the brand, rather than pure mid-greys, which look lifeless. Avoid a pure `#000` background in dark mode. Use a very dark surface so elevation can show through lighter layers.
- **Use one primary accent and use it sparingly.** It marks the primary action and the current selection. If everything is accented, nothing is.
- **Never rely on colour alone.** Status needs an icon, a label, or a pattern as well as colour (WCAG 1.4.1). A red border on an invalid field also gets an error message and an icon.
- **Contrast is a hard gate:** 4.5:1 for body text, 3:1 for large text (about 24px regular or 19px bold and up) and for UI component boundaries, icons, and focus indicators (WCAG 1.4.3 and 1.4.11). Check every text-on-background pair in both themes, including placeholder text, disabled-looking text that is still meaningful, text on images, and text on the accent colour.
- **Dark mode is a separate design, not an inversion.** Lower saturation for accents on dark surfaces, because saturated colours vibrate. Show elevation with lighter surfaces instead of shadows. Re-check every contrast pair. Images and illustrations may need dark variants.
- **Respect high-contrast settings:** Increase Contrast on iOS, `prefers-contrast: more` and `forced-colors` on web, and high-contrast text on Android. At minimum, make sure borders and focus rings survive them.

---

## 5. Spacing and layout

- **Use a single spacing scale on a 4 or 8 unit base:** 4, 8, 12, 16, 24, 32, 48, 64. Every margin, padding, and gap comes from it.
- **Proximity carries meaning.** Space inside a group must be clearly smaller than space between groups. Most "this looks off" feedback is ambiguous grouping.
- **Use alignment with intent.** Left-align text and forms by default. Centring is for short, isolated moments such as an empty-state message, a single-action splash, or a modal confirmation. A screen where everything is centred is a template tell, and it hurts scanning.
- **Use a grid.** Pick a column grid for each size class and snap content to it. Use consistent gutters, and keep content edges aligned down the page.
- **Avoid card soup.** Use cards for discrete, actionable objects, plain lists for homogeneous rows, and open sections for prose. Vary density with the content.
- **Design for real lengths:** long names, translated strings (German runs about 30% longer), missing optional fields, a single item, and thousands of items. Truncate deliberately, with the full value available on focus, tap, or tooltip, and never truncate the part that distinguishes items.
- **Safe areas and system bars:** respect notches, home indicators, rounded corners, and on-screen keyboards. Forms must scroll the focused field into view above the keyboard.

---

## 6. Components

- **Build a small kit and compose screens from it.** Typical kit: button (primary, secondary, tertiary or ghost, destructive), text field, select or picker, checkbox, radio, switch, list row, card, sheet or dialog, toast or snackbar, tabs or segmented control, navigation bar, empty state, error state, skeleton, avatar, badge, and icon. Stop there until a screen genuinely needs more.
- **Every interactive component has every state:** default, hover (pointer platforms), pressed, focused (visible focus ring, at least 2px, at least 3:1 against adjacent colours), disabled, loading or busy, selected or checked, and error where relevant. A component missing a state is unfinished.
- **Prefer native controls,** or wrap them, rather than rebuilding them. Native controls come with accessibility, keyboard behaviour, and platform feel. If you must build a custom control, give it the correct role, name, value, and state (WCAG 4.1.2) and full keyboard operation.
- **Buttons say what they do:** "Save shift", "Send invite", "Delete 3 photos". Avoid "Submit", "OK", and "Click here". Destructive actions say exactly what is destroyed, and irreversible ones ask for confirmation or offer undo. Undo is usually better than confirmation.
- **Icons:** use one consistent icon set (SF Symbols, Material Symbols, Lucide, Phosphor, or similar) at consistent sizes and stroke weights. **Never use emoji as UI icons.** Emoji render differently on every platform, cannot be themed, and look like a placeholder. Icon-only buttons need an accessible label, and on pointer platforms a tooltip.
- **Forms:** visible labels above or beside fields, not placeholder-as-label. Mark required or optional fields consistently, marking whichever is the minority. Validate on blur or submit, not on every keystroke. Put the error message next to the field, in words, saying how to fix it. Keep user input when an error occurs. Use correct input types, autofill hints, and keyboard types (email, numeric, one-time code). Do not ask users to re-enter information the app already has (WCAG 3.3.7), and do not block paste in password or code fields (WCAG 3.3.8).

---

## 7. Every state, every screen

A screen is not done when the happy path renders. Build and capture each of these for every screen that loads or changes data:

| State | What good looks like |
|---|---|
| **Loading** | Skeletons that match the real layout for content areas, and a spinner only for short, unshaped waits. Show cached data immediately if you have it, with a subtle refresh indicator. Do not show a blank screen or block the whole UI for a partial load. If a wait exceeds about 10 seconds, say what is happening. |
| **Empty, first use** | Explain what will appear here and give one clear action to create the first item, written in domain language ("No climbs logged yet. Log your first session"). Use an illustration only if it fits the visual identity. |
| **Empty, no results** | Echo the query or filters, and offer to clear filters or broaden the search. This is a different state from first use. |
| **Partial** | Some items failed to load, or some fields are missing. Show what you have and mark what is missing inline. |
| **Error** | Say what happened, in plain words, without stack traces or codes as the headline. Say what the user can do (retry, check connection, contact support). Keep the user's context and input. Show retry as a button. Distinguish "you can fix this" from "we are on it". |
| **Offline** | Show a persistent but unobtrusive indicator. Keep cached content readable. Queue writes and show them as pending, then confirm when they sync. Disable only the actions that truly need the network, and explain why on interaction. |
| **Permission denied or locked** | For OS permissions (camera, location, notifications): explain the value before the system prompt. After denial, explain what is unavailable and link to Settings. For authorisation (role lacks access): say so, and say who can grant it. Do not show a generic error. |
| **Success and confirmation** | Give feedback proportional to the action: inline state change for small actions, a toast with undo for reversible ones, a dedicated screen only for milestones. |
| **Overflow and extremes** | Very long text, 0 items, 1 item, 10,000 items, maximum text size, smallest supported width, and right-to-left if localisation is in scope. |

Wire states to real conditions: a slow network, airplane mode, revoked permissions, and an empty database. Do not just add a debug toggle. Where real conditions cannot be reproduced, add preview or fixture variants (SwiftUI previews, Compose `@Preview`, Storybook stories) so every state can be rendered and screenshotted on demand.

---

## 8. Motion

- **Motion explains change.** Use it for where something came from, where it went, and what is connected to what. It is not decoration. If removing an animation loses no meaning, remove it.
- **Keep durations short:** about 100 to 200ms for small state changes (press, toggle), 200 to 350ms for elements entering or leaving, and up to about 500ms for large screen transitions. Exits should be faster than entrances. Use standard easing curves from the platform or a token (`motion.duration.short`, `motion.easing.standard`). Do not use linear easing for spatial movement.
- **Choreograph once, not everywhere.** One considered transition beats a fade-and-slide-up on every section and a hover lift on every card. Both of those are template tells.
- **Respect reduced motion** (`prefers-reduced-motion`, iOS Reduce Motion, Android remove animations). Replace movement, parallax, zoom, and auto-advancing carousels with instant changes or short cross-fades. Nothing should flash more than three times per second (WCAG 2.3.1).
- **Never block input on decorative animation,** and never auto-play content longer than 5 seconds without pause or stop controls (WCAG 2.2.2).

---

## 9. Accessibility (WCAG 2.2 AA is the floor)

Treat these as acceptance criteria, not polish.

**Perceivable**
- Every image has a text alternative. Decorative images are hidden from assistive technology. Meaningful icons and icon-only buttons have labels that describe the action ("Delete shift"), not the glyph ("trash").
- Contrast meets the thresholds in section 4, in both themes.
- **Large text:** support at least 200% text scaling without loss of content or function (WCAG 1.4.4). On iOS, test the largest accessibility Dynamic Type sizes. On Android, test 200% font scale. On web, test 200% zoom and 400% zoom at 320 CSS px wide with no horizontal scrolling for reading content (WCAG 1.4.10). Layouts must reflow: horizontal rows stack vertically, and text wraps instead of truncating. Never fix the height of a text container.
- **Text spacing overrides** must not break layout (WCAG 1.4.12).

**Operable**
- **Touch targets:** at least 44x44pt on iOS and 48x48dp on Android, and treat 44x44 CSS px as the target on touch-first web. The WCAG 2.2 AA minimum is 24x24 CSS px with spacing (2.5.8), but treat that as a hard floor, not the goal. The visual element can be smaller if the hit area is padded.
- **Keyboard and switch access:** everything operable by pointer is operable by keyboard (web, desktop, iPad with keyboard). There are no keyboard traps. Focus is always visible.
- **Focus order** follows the visual and reading order. When a dialog or sheet opens, focus moves into it and is contained there. When it closes, focus returns to the element that opened it. After navigation, focus lands at the start of the new content or its heading.
- **Focus not obscured:** sticky headers, footers, and toasts must not cover the focused element (WCAG 2.4.11).
- **Dragging alternatives:** every drag interaction (reorder, slider, swipe-to-delete) has a single-pointer or button alternative (WCAG 2.5.7). Swipe actions also appear in a context menu or an edit mode.
- **No time limits** on reading or input, or allow them to be extended.

**Understandable**
- Headings and landmarks reflect the structure. Use real heading levels on web and accessibility headings or traits on native, so screen-reader users can jump between sections.
- Labels are visible and persistent. Instructions do not depend on shape, position, or colour alone ("tap the green button" is not an instruction).
- Navigation and help are in consistent places across screens (WCAG 3.2.3 and 3.2.6).
- Errors are identified in text, linked to their field, and announced.

**Robust**
- Correct roles, names, states, and values on every control. Status changes that appear without a focus change (toast, "saved", result counts) are announced through live regions or accessibility announcements (WCAG 4.1.3).
- Group related elements so that a list row reads as one sensible sentence to a screen reader, not as six fragments.

**Test it, do not assume it**
- Run the platform's automated checker: Accessibility Inspector or XCUITest audits on iOS, Accessibility Scanner or Espresso checks on Android, axe or Lighthouse on web. Fix everything it flags.
- Then do a manual pass: navigate one core flow with VoiceOver or TalkBack, or with keyboard only on web, at the largest text size, in dark mode. Automated tools catch roughly a third of real problems.

---

## 10. Responsive and adaptive layout

Design for size classes, not devices. Capture and verify three widths:

| Class | Width | Typical layout |
|---|---|---|
| **Compact** | under 600dp/pt/px (phones, e.g. 375 to 430 wide) | Single column, bottom navigation or tab bar, sheets for secondary tasks, full-width primary actions within thumb reach. |
| **Medium** | 600 to 840 (small tablets, foldables, narrow windows, e.g. 768) | Two panes where useful (list plus detail), navigation rail, wider margins, constrained reading width. |
| **Expanded** | 840 and up (tablets landscape, desktop, e.g. 1280 to 1440) | Persistent sidebar or rail, list-detail or multi-column layouts, constrained content width (do not stretch a form to 1400px), hover and keyboard affordances. |

- Change layout structure at the breakpoints, not just the scale. A phone layout blown up to 1440px is not a desktop design.
- Use fluid widths between breakpoints and test the in-between sizes (for example 700 and 1000), where most layout bugs live.
- Handle orientation changes, split-screen and multi-window modes, and window resizing on desktop without losing state.

---

## 11. Content: real, specific, domain-true

Copy and sample data are part of the design. Placeholder content hides layout problems and makes everything look like a demo.

- **No lorem ipsum, no "John Doe", no "Item 1, Item 2", no "Acme Corp".** Write realistic fixtures from the domain and the CONTRACT models: plausible names from a range of cultures, real-looking addresses, believable amounts with correct currency formatting, real dates and durations, and long and short values side by side.
- Include awkward data in fixtures: a 60-character name, a missing avatar, a zero balance, a negative number, a value with emoji in user content (fine in content, never as UI icons), and a right-to-left string if relevant.
- **Microcopy** is plain, specific, and in the user's voice. Use active voice and present tense. Name the thing: "3 shifts need cover this week", not "You have notifications". Keep marketing tone out of utility screens.
- Use one term per concept across the whole app. If the CONTRACT calls it a `Session`, do not call it a "workout" on one screen and an "entry" on another unless the brief defines a user-facing term.
- Images: use real or purpose-made assets. If none exist, use neutral, honest placeholders, such as a tinted block with an icon from the set. Do not use stock-photo clichés or AI imagery with garbled text.

---

## 12. Avoiding AI-generic design

These patterns signal "generated, not designed". Do not use them unless the brief explicitly asks for one:

- Purple-to-blue (or any stock two-stop) gradients on hero sections, buttons, or text.
- Glassmorphism or frosted blur with no layering reason. Blur is for content scrolling beneath persistent chrome, not for decorating cards.
- Everything centred: hero, headings, body text, cards.
- A grid of identical rounded cards with the same soft shadow and an icon-in-a-circle on top.
- Emoji as icons, bullets, or section markers.
- Hero sections with a giant number, a tiny label, three stats, and a gradient blob.
- Uniform large border radius on everything, including inputs, tables, and images.
- All-caps tracked eyebrow labels over every heading, and a single highlighted word in each headline.
- Fade-and-slide-up on every section, and hover-lift on every card.
- "01 / 02 / 03" step markers on content that is not a sequence.
- Decorative arrows appended to every link or button label.
- Generic copy: "Unlock your potential", "Seamless experience", "Get started today".
- Dark mode that is `#111` with neon accents.

Before you commit, ask of every visual decision: *would this exist if the app were about something else?* If the answer is yes for most decisions, the design has no identity. Bring in the domain: its colours, its artefacts, its density, its vocabulary.

Restraint is part of the craft. Before finishing, remove one decorative element, such as an extra shadow, a redundant divider, a gratuitous gradient, or a label that repeats the heading.

---

## 13. Platform notes

- **iOS / SwiftUI:** use semantic system colours or asset-catalogue colours with light and dark variants. Use `.font(.body)` and other text styles, not fixed sizes. Use `@ScaledMetric` for spacing that should grow with text. Set `accessibilityLabel`, `accessibilityHint` sparingly, and `accessibilityElement(children: .combine)` for rows. Use `ViewThatFits` or size-class checks to reflow at large text sizes. Follow the HIG for navigation, sheets, and swipe actions.
- **Android / Compose:** use `MaterialTheme` colour schemes (light, dark, and dynamic colour where appropriate) and Material 3 type roles in `sp`. Enforce minimum interactive size (48dp). Use `Modifier.semantics` with `contentDescription` and merged descendants. Use `WindowSizeClass` for adaptive layouts and edge-to-edge insets.
- **Web:** use semantic HTML first (`button`, `a`, `label`, `nav`, `main`, headings) and ARIA only to fill gaps. Use CSS custom properties for tokens, `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, and `rem` units. Use container queries where components adapt independently. Use `:focus-visible` rings. Avoid layout shift by reserving image and async content dimensions.
- **Cross-platform frameworks** (React Native, Flutter): map tokens to the framework theme, and verify that accessibility props reach the native layer. Test with the real screen reader on each OS, not only one.

---

## 14. Screenshot evidence

Screenshots are how reviewers and the user judge your work without running it. Make them complete and easy to scan.

**Capture matrix, for each key screen:**
- Three sizes: compact (for example 390x844), medium (for example 820x1180 or 768 wide), and expanded (for example 1440x900). For an **iOS or Android app**, all three are upright devices: a small phone, a large phone and a tablet held upright. Never a landscape or computer-sized capture: Helm hides those for a phone app.
- Both themes: light and dark.
- That is six images per screen. Then add state captures (loading, empty, error, offline, permission-denied) at compact size in at least one theme, plus one capture at the largest accessibility text size.

**Location and naming:** save under `reports/ui/`, with predictable names:

```
reports/ui/<screen>--<state>--<size>--<theme>.png
reports/ui/shift-list--default--compact--light.png
reports/ui/shift-list--default--expanded--dark.png
reports/ui/shift-list--offline--compact--dark.png
reports/ui/shift-list--default--compact--light--a11y-xxxl.png
```

- Capture from the running app, simulator, or emulator, or from automated snapshot tests (swift-snapshot-testing, Paparazzi or Roborazzi, Playwright), never from mockups. Automated capture is preferred because it doubles as a regression test.
- **Capture the app on its own device, showing only its UI (strict, set by the human):**
  - **iOS:** the iPhone simulator (`xcrun simctl io <simulator> screenshot reports/ui/<name>.png`). **Android:** the emulator (`adb exec-out screencap -p > reports/ui/<name>.png`).
  - **On each of the human's devices.** Your brief's "Screenshots on these phones" lists them (the human ticks them in Screens → Devices; an iOS app gets the Apple ones, an Android app the Android ones, for example iPhone 18 Pro, iPhone Air, Pixel 9). Capture every page on each, with the device in the file name as a slug: `reports/ui/<screen>--<state>--<device>--<theme>.png`, for example `home--default--iphone-18-pro-max--light.png` or `home--default--samsung-galaxy-s25--dark.png`. A computer or web app has "Screenshots at these window sizes" instead (1440x900, 1920x1080, and 390x844 for web), named with the size: `home--default--1440x900--light.png`. One simulator per model, made once and reused (`xcrun simctl create helm-<phone> "<model>"`), booted only to capture and shut down after. A model that is not installed: the closest installed one, named in `reports/ui/INDEX.md`. Screens lets the human switch phones or see one page on all of them side by side. A phone app is never captured as a web build in a desktop browser. If a web preview is the only way to run it, use a phone viewport (390x844) and still save it as a phone capture.
  - **A plugin or extension** (audio plugin, browser extension, editor plugin): only the plugin's own window or panel, cropped to it (the standalone build, or `screencapture -l <window id>` on macOS). Never the host app (the DAW, the browser, the editor) around it, and never other plugins.
  - **A website:** the page itself at each size, without the browser's own toolbars.
  - **Nothing else under `reports/ui/` or `reports/<platform>/`.** Before/after comparisons, probes, repro shots and anything named with a commit, a date or a time are evidence: put them under `reports/<your gate or task>/evidence/`. Helm keeps them out of Screens either way.
- Use realistic fixture data in every capture. A screenshot full of placeholder text does not count as evidence.
- Add a short `reports/ui/INDEX.md` listing each screen, its captures, and any known gaps. Never hide gaps.

**Screen map (what the human clicks through).** The Helm panel's **Screens** view shows each app as pages: your screenshots, in a phone frame for a phone app, nothing running. With a screen map, **its pages are the only pages**: a capture whose screen is not in the map is left out. Write `reports/screens/screens.json` so its pages link like the real app:

```json
{
  "start": "shift-list",
  "screens": [
    { "id": "shift-list", "name": "Shifts", "image": "reports/ui/shift-list--default--compact--light.png",
      "links": [ { "to": "settings", "x": 0.86, "y": 0.04, "w": 0.12, "h": 0.06, "label": "Settings gear" },
                 { "to": "shift-detail", "x": 0.04, "y": 0.18, "w": 0.92, "h": 0.1, "label": "First shift" } ] },
    { "id": "settings", "name": "Settings", "image": "reports/ui/settings--default--compact--light.png",
      "links": [ { "to": "shift-list", "x": 0.02, "y": 0.04, "w": 0.14, "h": 0.06, "label": "Back" } ] }
  ]
}
```

- One entry per screen; `id` matches the `<screen>` part of its file names, so every size, theme and state is offered automatically. `image` is the compact light capture, relative to the repository root.
- `links` are the tappable areas in that image: `x`, `y`, `w`, `h` are fractions (0 to 1) of the image's width and height, measured from the top-left. Add one for each button, tab, row or back control that opens another screen. Every `to` must be another screen's `id`.
- Include **every page the app has** (onboarding, each tab, detail pages, settings, paywall, empty states that are their own page), and update the map whenever you add a screen or move a control. Commit it with the screenshots.
- Then open it the way the human will: `bb helm screens --app <app>` lists the pages and says what was left out and why. Fix anything left out that should be a page.
- Look at every screenshot yourself before reporting. Check for clipped text, misalignment, contrast problems in dark mode, and overlapping elements at compact size. Screenshots you have not looked at are not evidence.

---

## 15. Self-review checklist (run before reporting done)

**System**
- [ ] All colours, spacing, radii, type, and motion values come from tokens. A search for raw hex values or magic numbers in component code finds nothing.
- [ ] The type scale has 7 or fewer named styles, and every text element uses one.
- [ ] Light and dark themes are both designed, not inverted, and every screen renders correctly in both.

**Identity and content**
- [ ] The screen could not be mistaken for another app. Domain vocabulary, artefacts, and density are visible.
- [ ] There is no lorem ipsum, no "John Doe" or "Item 1", no emoji icons, no stock gradients, no meaningless blur, and no everything-centred layout.
- [ ] Button labels name their actions, and error messages say what happened and how to fix it.
- [ ] Fixtures include long, short, missing, and extreme values.

**States**
- [ ] Loading, first-use empty, no-results empty, error, offline, permission-denied, and success states exist for every data-driven screen and are reachable through real conditions or previews.
- [ ] Every interactive component has default, pressed, focused, disabled, and loading states, plus hover on pointer platforms.

**Accessibility**
- [ ] Text contrast is at least 4.5:1, and large text and UI parts are at least 3:1, verified in both themes.
- [ ] Touch targets are at least 44pt (iOS) or 48dp (Android), and never below 24px on web.
- [ ] Everything works at 200% text or the largest Dynamic Type size, with reflow and no clipped or truncated essential text.
- [ ] Every control has an accessible name, role, and state. Icon-only buttons are labelled. Images have alternatives or are hidden.
- [ ] Focus order is logical, focus is visible, dialogs trap and restore focus, and focus is never hidden behind sticky UI.
- [ ] Reduced motion is respected, and no essential information is conveyed by motion or colour alone.
- [ ] Drag interactions have a non-drag alternative.
- [ ] The automated accessibility checker passes, and one core flow was tested manually with a screen reader or keyboard.

**Responsive**
- [ ] Layout structure adapts at compact, medium, and expanded sizes, and in-between widths were checked.
- [ ] Safe areas, the keyboard, orientation, and window resizing are handled.

**Evidence**
- [ ] `reports/ui/` contains each key screen at three sizes in both themes, plus state captures and one large-text capture, named consistently and listed in `INDEX.md`.
- [ ] I looked at every screenshot and fixed what I saw.

---

## Sources

- Anthropic frontend-design skill: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
- Apple HIG, Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Material Design 3: https://m3.material.io/
- Android window size classes: https://developer.android.com/develop/ui/compose/layouts/adaptive/window-size-classes
- WCAG 2.2 (W3C Recommendation): https://www.w3.org/TR/WCAG22/
- What's new in WCAG 2.2 (W3C WAI): https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- What's new in WCAG 2.2 (TetraLogical): https://tetralogical.com/blog/2023/10/05/whats-new-wcag-2.2
- WCAG 2.2 updates (Deque): https://dequeuniversity.com/resources/wcag-2.2
- Refactoring UI: https://www.refactoringui.com/
- awesome-cursorrules: https://github.com/PatrickJS/awesome-cursorrules
