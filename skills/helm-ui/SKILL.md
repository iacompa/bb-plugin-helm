---
name: helm-ui
description: Native-quality UI for iOS, Android, web and desktop (direction, tokens, every state, WCAG 2.2 AA, captures on the human's devices, native audit). Use when you are a Helm UI builder.
---

# Helm UI craft

Parts of this skill (the direction, target, compare-and-fix and native-audit method) are adapted from Uizze's ui-taste and ios-design skills and Impeccable by Paul Bakaus (both Apache-2.0), changed for Helm. See Sources below and THIRD_PARTY_NOTICES.md.

This skill covers what good interface work looks like and the loop that gets you there. `helm-specialist` covers how you work inside Helm (scope, commits, reports). The bar is a product a senior iOS or Android designer would ship under their own name: built from a system, true to its domain and its platform, complete in every state, and usable by everyone, on the smallest phone, with VoiceOver or TalkBack, at the largest text size, in dark mode.

Two tests run through everything you make:

- **The swap test.** If changing the logo would make your screen fit another app, it is generic. Do it again.
- **The platform test.** If an iPhone user would feel they are in a website, or an Android user in an iPhone app, it is not native. Do it again.

---

## 0. What to read, and when

| When | Read |
|---|---|
| You design or build any iOS or iPadOS screen | `reference/ios.md` |
| You design or build any Android screen | `reference/android.md` |
| You choose a direction, refine or simplify a screen, or check your work for template habits | `reference/craft.md` |
| Before you report done on a phone or tablet app (always) | `reference/native-audit.md` |

These files sit in this skill's folder. If your provider shows you only SKILL.md, run `bb skill list | grep helm-ui` for the id, then `bb skill show <id> --path reference/ios.md` (and so on). Your BRIEF names the app's platforms. An app on iOS and Android gets **two native designs that share one identity** (palette, type personality, content, voice), never one design forced onto both.

---

## 1. The loop

Every key screen goes through these steps. A small fix starts at step 5.

1. **Read.** BRIEF, SPEC flows and "content and tone", CONTRACT data shapes, existing screens, tokens and assets.
2. **Direction.** Write the direction contract (section 2) in `reports/ui/DIRECTION.md`.
3. **Target.** Adopt or make a visual target for each key screen (section 3).
4. **System, then screens.** Tokens, then components, then screens with every state (sections 4 to 12).
5. **Capture** on the human's devices, in both themes (section 15).
6. **Compare and fix** each capture against its target, in a fixed order, in bounded passes (section 14).
7. **Audit** with `reference/native-audit.md` and write `reports/ui/AUDIT.md`. Fix every P0 and P1.
8. **Report** what you built, captured and checked, and what is still open. Claim only what your evidence shows.

---

## 2. Direction before pixels

### Visual authority: what you may change

- **Preserve.** The app already has an identity: new screens and states inherit it. Do not restyle what you were not asked to touch.
- **Expand.** A partial brand (a logo, a colour, a typeface): keep what exists and write the missing rules around it.
- **Replace.** Only when SPEC or the human approves a redesign. Keep content, behaviour and contracts; the old look is evidence, not a rule.
- **Create.** No identity yet: choose one on purpose, from the domain. Not a template.

### Surface purpose: what the screen is for

- **Operate** (most app screens). Users recognise the navigation, controls and state before they notice the style. Familiar platform patterns, density that fits the work, colour that carries state.
- **Read.** Start from the reader's question. A calm column at a comfortable measure; identity in headers and section openers, not in the body text.
- **Persuade** (onboarding, paywall, store screenshots). Make the real offer clear, show credible proof, put the actual primary control on screen. True claims only.
- **Experience** (games, media, creative tools). The work leads the first screen; navigation and actions stay findable and accessible.

### The direction contract

Write it before the first component, in `reports/ui/DIRECTION.md`. Half a page is enough:

- **Thesis.** The idea this app owns and the habitual layout it avoids ("a climbing log that reads like a guidebook page, not a fitness dashboard of cards").
- **World.** Palette with roles, type pairing and why, shape language (radii, borders, elevation), icon set, and one signature move. Everything else stays quiet.
- **Domain.** Vocabulary, artefacts and density taken from the subject: grades, crags and attempts; shifts, cover and handovers; debits, periods and reconciliations.
- **Authority and purpose**, from the lists above.
- **Platforms.** What differs on iOS and on Android (navigation, controls, type, motion, haptics) while the identity stays the same.
- **First screen.** What leads, where the primary action sits, what the user does next.
- **Finish.** The devices, themes, states and checks that make it done.

For an open brief, sketch several **structures** for the main screen (different organisations of the task, not different colours) and keep the one that serves the primary job best; record the runner-up in one line. For a brand-new identity, gather 5 to 7 visual sources from the domain's own artefacts (guidebooks, receipts, tide tables, lab notebooks) instead of the category default or its predictable opposite. `reference/craft.md` has the full method.

Read CONTRACT.md before you design. Field lengths, optionality, enums and list sizes decide layouts: a 200-character `title` or a list of 10,000 rows is a design input, not a QA surprise.

---

## 3. A visual target for each key screen

A target is an image of the actual screen at the actual device size: straight on, real copy, real controls, the platform's real bars. Not a poster, a mood board, a tilted mockup, or a web page in a phone frame.

- **The human or SPEC supplied a design or screenshot:** that is the target. Do not regenerate or reinterpret it. Fix only real errors (a false label, an unsafe area, unreadable text) and say which.
- **You have an authorized image-generation tool** (it is in your tool list): generate a target for each key screen before writing its UI code. Inspect it at full size and correct false labels, impossible controls, a missing primary action, content under the status bar or home indicator, and text too small to read, before it becomes the spec. Use representative fixtures, never real personal data or secrets. An image cannot add a feature, a price or an asset licence that the product does not have.
- **You have no such tool:** do not install one or ask for one. Write the target as a layout spec in DIRECTION.md (regions top to bottom, relative sizes, the primary action, the bars) and build from it. Say "no image target" in your report and never claim a 1:1 match.
- **A small fix, a new state, or a refinement:** the current capture is the baseline. Describe only what changes, and check that the rest did not drift.

Save targets in `reports/ui/targets/<screen>--<device>.png` and note each one's real pixel size, device, orientation and theme in DIRECTION.md. Helm keeps that folder out of Screens. Keep a target stable while you build; a material change to it is a decision you record, not a quiet swap to hide a mismatch.

---

## 4. Design tokens first

Hard-coded values are the main cause of inconsistent UI. Define tokens before components; components consume only tokens.

1. **Primitive** (raw palette and scales): `blue-600`, `space-4`, `radius-2`. Never used directly by components.
2. **Semantic** (role-based): `color.bg.surface`, `color.text.secondary`, `color.border.subtle`, `color.action.primary`, `color.status.danger`, `space.inset.card`, `radius.control`. Components use these.
3. **Component** (only where a component needs its own knob): `button.primary.bg`.

Themes swap the semantic layer. A `#hex` or a magic number in a component is a bug. Put tokens in one place per platform (a Swift `Theme` plus asset-catalogue colours, a Compose `ColorScheme` plus `Typography` and `Shapes`, CSS custom properties, a TS object), named by role, never by appearance (`text.secondary`, not `grey-text`). Head the token file with the plan: the colours and their roles, the type scale, the spacing scale, radii, elevation, motion durations, and one paragraph on the visual idea. Need a value that does not exist? Add a token; never inline it.

On native platforms the semantic layer maps onto the system's own roles (iOS semantic colours and text styles, Material 3 colour and type roles). Do not rebuild what the platform already gives you; theme it.

---

## 5. Typography

- **One or two families.** An expressive face for display and headings and a highly legible one for UI and body. On iOS and Android the system face (SF Pro, Roboto or Roboto Flex) is the right default for UI text; a custom face must earn its place and still scale. Choose a face because it suits the domain, not the one every AI demo uses.
- **A deliberate scale** of 5 to 7 named styles. On native, map them to the platform roles (iOS text styles, Material type roles). Every text element uses a named style.
- **Hierarchy through weight and colour before size.** Primary text in full-contrast colour, secondary in a muted role that still passes contrast. Not everything bold, not everything large.
- **Measure and leading.** Body lines of 45 to 80 characters on wide screens; line height about 1.4 to 1.6 for body and 1.1 to 1.25 for large headings.
- **Numbers.** Tabular figures for anything compared in columns; right-align numeric columns; format numbers, dates, currencies and units with the platform's locale formatters, never hand-built strings.
- **Sentence case** for headings, buttons and labels. No all-caps tracked eyebrow over every heading.
- **Scalable text is mandatory.** Dynamic Type on iOS, `sp` and font scale on Android, `rem` on web (section 11).

---

## 6. Colour

- **A palette with roles:** background, surface, raised surface, primary text, secondary text, border, primary action, focus, and status (success, warning, danger, info). Each role has a light and a dark value, and a high-contrast value where the platform supports it.
- **Neutrals with a slight temperature** chosen for the brand, not lifeless mid-greys. No pure `#000` background in dark mode: use a very dark surface so elevation can show.
- **One primary accent, used sparingly**, for the primary action and the current selection. If everything is accented, nothing is. On Android, decide whether the app follows the wallpaper's dynamic colour or holds its brand scheme, and write that decision down.
- **Never colour alone.** Status also gets an icon, a label or a pattern (WCAG 1.4.1).
- **Contrast is a hard gate:** 4.5:1 for body text, 3:1 for large text and for control boundaries, icons and focus indicators (WCAG 1.4.3, 1.4.11). Measure against the real composited background (materials, translucency, images, overlays) in both themes, including placeholders, text on the accent colour and text on images.
- **Dark mode is its own design.** Lower accent saturation, show elevation with lighter surfaces instead of shadows, re-check every pair, and give images and illustrations dark variants where needed.
- **Respect high-contrast settings**: Increase Contrast and Reduce Transparency on iOS, high-contrast text on Android, `prefers-contrast` and `forced-colors` on web. Borders and focus rings must survive them.

---

## 7. Spacing and layout

- **One spacing scale** on a 4 or 8 base (4, 8, 12, 16, 24, 32, 48, 64). Every margin, padding and gap comes from it.
- **Proximity carries meaning.** Space inside a group is clearly smaller than space between groups. Most "this looks off" feedback is ambiguous grouping.
- **Alignment with intent.** Left-align text and forms by default (leading edge, so it mirrors in right-to-left). Centre only short, isolated moments: an empty-state message, a confirmation.
- **Group with space and alignment before borders, cards or backgrounds.** Cards are for discrete, actionable objects; plain lists for homogeneous rows; open sections for prose.
- **Real lengths:** long names, translations (German runs about 30% longer), missing optional fields, one item, ten thousand items. Truncate deliberately, never the part that tells items apart, and make the full value reachable.
- **Safe areas and system bars:** notches and the Dynamic Island, the home indicator, rounded corners, Android's status, navigation and gesture areas, display cutouts, and the keyboard. Decorative backgrounds may run edge to edge; text and controls stay clear. The focused field and the primary action stay visible above the keyboard.

---

## 8. Components

- **A small kit, composed into screens:** buttons (primary, secondary, tertiary, destructive), text field, picker, checkbox or toggle, list row, card, sheet, dialog, transient feedback, tabs or segmented control, navigation bar, empty state, error state, loading placeholder, avatar, badge, icon. Stop there until a screen needs more.
- **Native controls first**, themed to the identity. They bring accessibility, keyboard support and platform feel. A custom control needs the right role, name, value and state (WCAG 4.1.2) and full keyboard and switch operation.
- **Every interactive component has every state:** default, pressed, focused (a visible ring at least 2px and 3:1), disabled, loading, selected, error, and hover on pointer platforms. A component missing a state is unfinished.
- **Buttons say what they do:** "Save shift", "Send invite", "Delete 3 photos", never "Submit" or "OK". Destructive actions name what they destroy; prefer undo to confirmation.
- **Icons:** one set (SF Symbols on iOS, Material Symbols on Android, one of Lucide or Phosphor on web) at consistent sizes and weights. **Never emoji as UI icons.** Icon-only buttons need an accessible label.
- **Forms:** visible, persistent labels; required or optional marked consistently; validate on blur or submit, not per keystroke; errors beside the field, in words, saying how to fix it; keep the user's input; correct keyboard types, content types and autofill; never ask again for data the app has (WCAG 3.3.7) and never block paste in password or code fields (WCAG 3.3.8).

---

## 9. Every state, every screen

A screen is not done when the happy path renders. Build and capture these for every screen that loads or changes data:

| State | What good looks like |
|---|---|
| **Loading** | Placeholders shaped like the real layout; a spinner only for short, unshaped waits. Show cached data at once with a quiet refresh indicator. Never a blank screen; past about 10 seconds, say what is happening. |
| **Empty, first use** | What will appear here and one clear action to create the first item, in domain words ("No climbs logged yet. Log your first session"). |
| **Empty, no results** | Echo the query or filters; offer to clear or broaden. A different state from first use. |
| **Partial** | Show what loaded and mark what is missing inline. |
| **Error** | What happened in plain words, what the user can do, and a retry button. Keep context and input. Separate "you can fix this" from "we are on it". |
| **Offline** | A persistent, quiet indicator; cached content stays readable; writes queue as pending and confirm when synced; only network-only actions disable, with the reason on interaction. |
| **Permission denied or locked** | Explain the value before the system prompt; after a denial, say what is unavailable and link to Settings. For roles without access, say who can grant it. |
| **Success** | Feedback in proportion: an inline change for small actions, an undoable confirmation for reversible ones, a dedicated screen only for milestones. |
| **Extremes** | Very long text, 0, 1 and 10,000 items, the largest text size, the smallest device, right-to-left if localisation is in scope. |

Wire states to real conditions (slow network, airplane mode, revoked permission, empty database). Where that is impractical, add preview or fixture variants (SwiftUI previews, Compose `@Preview`, Storybook) so every state can be rendered and captured on demand. Do not invent states the product cannot reach.

---

## 10. Motion

- **Motion explains change**: where something came from, where it went, what is connected. If removing an animation loses no meaning, remove it.
- **Short and platform-true.** About 100 to 200ms for small state changes, 200 to 350ms for elements entering or leaving, up to about 500ms for large transitions; exits faster than entrances. Prefer the platform's own transitions and springs (navigation push, sheets, Material container transforms) over custom choreography.
- **One considered moment, not effects everywhere.** A fade-and-slide on every section and a lift on every card are template tells.
- **Haptics confirm, they do not decorate**: success, a toggle, a snap point. Never on every tap.
- **Reduced motion** (iOS Reduce Motion, Android "Remove animations", `prefers-reduced-motion`): replace movement, parallax and zoom with instant changes or short cross-fades, keeping the state feedback. Nothing flashes more than three times a second (WCAG 2.3.1). Never block input on decorative animation.

---

## 11. Accessibility (WCAG 2.2 AA is the floor)

Acceptance criteria, not polish.

**Perceivable.** Every meaningful image has a text alternative; decorative ones are hidden. Icon-only controls are labelled by action ("Delete shift"), not glyph ("trash"). Contrast as in section 6. Text scales to at least 200% without loss (WCAG 1.4.4): test the largest accessibility Dynamic Type size on iOS and 200% font scale on Android; on web, 200% zoom and 320 CSS px reflow (WCAG 1.4.10). Rows stack, text wraps, no text container has a fixed height. Text-spacing overrides do not break layout (1.4.12).

**Operable.** Targets at least 44x44pt on iOS and 48x48dp on Android, measured as the real hit area (the WCAG 2.5.8 floor of 24x24 CSS px is not the goal). Everything works by keyboard, switch and Voice Control where the platform offers them, with no traps and visible focus. Focus order follows the reading order; sheets and dialogs take and contain focus, then return it. Sticky bars never cover the focused element (2.4.11). Every drag or swipe action has a single-pointer alternative (2.5.7). No time limits, or let users extend them.

**Understandable.** Headings and landmarks reflect the structure (heading traits on native). Labels stay visible. Instructions never rely on colour, shape or position alone. Navigation and help sit in consistent places (3.2.3, 3.2.6). Errors are identified in text, tied to their field, and announced.

**Robust.** Correct role, name, state and value on every control. Status changes without a focus change (saved, results count) are announced (4.1.3). A list row reads as one sensible sentence, not six fragments.

**Test it.** Run the platform checker (Accessibility Inspector or an XCUITest accessibility audit on iOS, Accessibility Scanner or Compose and Espresso accessibility checks on Android, axe or Lighthouse on web) and fix what it flags. Then walk one core flow with VoiceOver or TalkBack at the largest text size in dark mode. Automated tools catch roughly a third of real problems; an inspected accessibility tree is not a screen-reader session, so say which you did.

---

## 12. Adaptive layout

Design for size classes, not single devices.

| Class | Width | Typical layout |
|---|---|---|
| **Compact** | under 600 (phones) | One column; tab bar (iOS) or navigation bar (Android); sheets for secondary tasks; primary actions within thumb reach. |
| **Medium** | 600 to 840 (small tablets, foldables, narrow windows) | List and detail side by side where useful; navigation rail on Android, sidebar or split view on iPad; constrained reading width. |
| **Expanded** | 840 and up (tablets landscape, desktop) | Persistent sidebar or rail, list-detail or multi-column layouts, a constrained content width, pointer and keyboard affordances. |

Change the structure at breakpoints, not just the scale: a phone layout stretched to a tablet is not a tablet design. Test in-between widths, rotation, split screen, foldable postures and resizable windows without losing state. A phone-only app still survives the smallest and largest phones it supports.

---

## 13. Content: real, specific, domain-true

- **No lorem ipsum, "John Doe", "Item 1" or "Acme".** Fixtures come from the domain and the CONTRACT models: names from many cultures, believable amounts in the right currency format, real dates and durations, long and short values side by side.
- **Awkward data on purpose:** a 60-character name, a missing avatar, a zero balance, a negative number, emoji in user content (fine in content, never as UI icons), right-to-left text where relevant.
- **Microcopy** is plain and specific, in active voice: "3 shifts need cover this week", not "You have notifications". No marketing tone on working screens, and none of the stock phrases the Slop Hunter flags ("seamless", "unlock your potential", "effortless").
- **One term per concept** across the app, matching CONTRACT and SPEC.
- **Images:** real or purpose-made assets. With none, an honest placeholder (a tinted block with an icon from the set), never stock clichés or generated imagery with garbled text. Check every asset's origin and licence.

---

## 14. Compare, fix, and stop

Close the loop on every key screen, and keep the loop bounded.

1. **Capture valid evidence** (section 15): the right screen, state, device and theme, after fonts and images load and motion settles. A blank, half-loaded, wrong-screen or wrong-size capture is invalid evidence, not a design result: recapture it before judging.
2. **Compare with the target** side by side, full screen and detail crops (a side-by-side image under `reports/ui/evidence/` helps the reviewer). Fix in this order: **layout and proportions, then typography, then spacing, then colour, then assets and details.** A spacing tweak cannot rescue a wrong structure.
3. **Check what a still cannot show:** tap the real controls, push and pop, swipe back, open sheets, raise the keyboard, rotate, switch theme and text size.
4. **Batch fixes, then recapture the affected screens.** Plan one inspection pass and one confirmation pass. If two passes in a row change nothing material, stop and report the open mismatch instead of looping or declaring a pass.
5. **Run `reference/craft.md`'s habit check** on the result: would each visual decision exist if the app were about something else?
6. **Remove one thing** before finishing: an extra shadow, a redundant divider, a label that repeats its heading.

A later edit invalidates earlier captures of the screens it touched. Code review, a clean build and a passing scan are not visual evidence.

---

## 15. Screenshot evidence (Helm's rules)

Screenshots are how the reviewers and the human judge your work without running it.

**What to capture.**
- **A phone or tablet app:** every page on **each of the human's devices**, light and dark. Your BRIEF's "Screenshots on these phones" lists them (the human ticks them in Screens, Devices; an iOS app gets the Apple ones, an Android app the Android ones). Never a landscape or computer-sized capture of a phone app.
- **A computer or web app:** the window sizes in your BRIEF's "Screenshots at these window sizes" (1440x900, 1920x1080, and 390x844 for web), light and dark.
- **States** (loading, empty, error, offline, permission-denied) for every data screen on the first listed device in at least one theme, plus one capture at the largest accessibility text size.

**Names.** `reports/ui/<screen>--<state>--<device or size>--<theme>.png`, with the device as a slug:

```
reports/ui/home--default--iphone-18-pro--light.png
reports/ui/home--default--samsung-galaxy-s25--dark.png
reports/ui/shift-list--offline--iphone-18-pro--dark.png
reports/ui/shift-list--default--iphone-18-pro--light--a11y-xxxl.png
reports/ui/home--default--1440x900--light.png
```

**How.**
- Capture from the running app on its own platform: the iOS simulator (`xcrun simctl io <simulator> screenshot reports/ui/<name>.png`), the Android emulator (`adb exec-out screencap -p > reports/ui/<name>.png`), or automated snapshot tests (swift-snapshot-testing, Paparazzi or Roborazzi, Playwright), never mockups. Automated capture doubles as a regression test. `reference/ios.md` and `reference/android.md` give the commands for themes, text size and a clean status bar.
- One simulator or emulator per device model, made once and reused (`xcrun simctl create helm-<phone> "<model>"`), booted only to capture and shut down after. A model that is not installed: use the closest installed one and name it in `reports/ui/INDEX.md`.
- A phone app is never captured as a web build in a desktop browser. If a web preview is the only way to run it, use a 390x844 viewport, save it as a phone capture, and say in INDEX.md that it is not native evidence.
- **A plugin or extension:** only its own window or panel, cropped to it; never the host app around it.
- **A website:** the page itself at each size, without browser toolbars.
- **Nothing else under `reports/ui/` but pages.** Targets go in `reports/ui/targets/`, comparisons and probes in `reports/ui/evidence/` (or `reports/<your task>/evidence/`). Anything named with a commit, a date or a time is evidence. Helm keeps all of these out of Screens.
- Every capture uses realistic fixture data. A screenshot full of placeholder text is not evidence.
- `reports/ui/INDEX.md` lists each screen, its captures, the target it was compared with, and known gaps. Never hide a gap.

**Screen map (what the human clicks through).** The Helm panel's **Screens** view shows each app as pages: your screenshots, in a phone frame for a phone app. With a screen map, **its pages are the only pages**. Write `reports/screens/screens.json` so the pages link like the real app:

```json
{
  "start": "shift-list",
  "screens": [
    { "id": "shift-list", "name": "Shifts", "image": "reports/ui/shift-list--default--iphone-18-pro--light.png",
      "links": [ { "to": "settings", "x": 0.86, "y": 0.04, "w": 0.12, "h": 0.06, "label": "Settings" },
                 { "to": "shift-detail", "x": 0.04, "y": 0.18, "w": 0.92, "h": 0.1, "label": "First shift" } ] },
    { "id": "settings", "name": "Settings", "image": "reports/ui/settings--default--iphone-18-pro--light.png",
      "links": [ { "to": "shift-list", "x": 0.02, "y": 0.04, "w": 0.14, "h": 0.06, "label": "Back" } ] }
  ]
}
```

- One entry per screen; `id` matches the `<screen>` part of its file names, so every device, theme and state is offered automatically. `image` is the first device's light default capture, relative to the repository root.
- `links` are the tappable areas in that image as fractions (0 to 1) of its width and height from the top-left: one for each button, tab, row or back control that opens another screen. Every `to` is another screen's `id`.
- Include **every page the app has** (onboarding, each tab, detail pages, settings, paywall, empty states that are their own page) and update the map when you add a screen or move a control. Commit it with the screenshots.
- Open it the way the human will: `bb helm screens --app <app>` lists the pages and says what was left out and why. Fix anything left out that should be a page.
- **Look at every screenshot yourself** before reporting: clipped text, misalignment, dark-mode contrast, overlap at the smallest device, content under system bars. Screenshots you have not looked at are not evidence.

---

## 16. Platform notes beyond iOS and Android

- **Web:** semantic HTML first (`button`, `a`, `label`, `nav`, `main`, headings), ARIA only to fill gaps. CSS custom properties for tokens, `prefers-color-scheme`, `prefers-reduced-motion`, `prefers-contrast`, `rem` units, container queries for components that adapt on their own, `:focus-visible` rings, reserved dimensions for images and async content so nothing shifts.
- **macOS and Windows:** follow the platform's own design language (macOS HIG, Fluent). Menu bar or command bar, keyboard shortcuts for frequent actions, hover states, resizable windows that keep state, native window chrome.
- **Cross-platform frameworks** (React Native, Flutter, Compose Multiplatform): map tokens to the framework theme, use the platform-adaptive widgets where they exist, and verify on each OS with its real screen reader. A cross-platform app still uses each platform's navigation and back behaviour.

---

## 17. Before you report done

**Direction and identity**
- [ ] `reports/ui/DIRECTION.md` holds the contract; targets are in `reports/ui/targets/` (or "no image target" is stated).
- [ ] The screen passes the swap test: domain vocabulary, artefacts and density are visible.
- [ ] The platform test passes on each platform: native navigation, back behaviour, controls, type and icons.
- [ ] No template habits from `reference/craft.md`: no stock gradients, no decorative glass, no emoji icons, no eyebrow labels, no identical icon cards, no everything-centred layout.

**System**
- [ ] Every colour, space, radius, type style and duration comes from a token; a search for raw hex values or magic numbers in components finds nothing.
- [ ] 7 or fewer named type styles, mapped to platform roles; both themes designed and rendered.

**States and content**
- [ ] Loading, first-use empty, no-results, error, offline, permission-denied and success exist for every data screen and are reachable.
- [ ] Every interactive component has its states. Buttons name their actions; errors say what happened and how to fix it.
- [ ] Fixtures include long, short, missing and extreme values; no placeholder copy.

**Accessibility**
- [ ] Contrast measured on real backgrounds in both themes; targets at least 44pt or 48dp.
- [ ] The largest text size works with no clipping or overlap of essential text.
- [ ] Labels, roles and states on every control; focus order and containment correct; reduced motion respected; drag actions have alternatives.
- [ ] The platform checker passes and one core flow was walked with VoiceOver or TalkBack (or the report says what was not).

**Evidence**
- [ ] Every page on every listed device in both themes, the state captures and one large-text capture, named by the rules, listed in INDEX.md, mapped in `screens.json`.
- [ ] Each key screen was compared with its target and the open mismatches are listed.
- [ ] `reports/ui/AUDIT.md` covers the five native dimensions with coverage, and no P0 or P1 is open.
- [ ] I looked at every screenshot and fixed what I saw.

In your `helm_report`, cite the commit, DIRECTION.md, AUDIT.md, INDEX.md and the key captures. Say plainly what you could not check (no simulator for a model, no screen-reader session, no image target). An honest partial result is worth more than a claimed pass.

---

## Sources

- Apple Human Interface Guidelines, including Accessibility: https://developer.apple.com/design/human-interface-guidelines/
- Material Design 3 and Android adaptive layouts: https://m3.material.io/ and https://developer.android.com/develop/ui/compose/layouts/adaptive
- WCAG 2.2 (W3C Recommendation): https://www.w3.org/TR/WCAG22/
- Refactoring UI: https://www.refactoringui.com/
- Anthropic frontend-design skill: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- The direction, target, compare-and-fix and native-audit method is adapted from Uizze's ui-taste and ios-design skills (Apache-2.0), which adapt Impeccable by Paul Bakaus (Apache-2.0) and include material from ehmo's platform-design-skills (MIT). Helm changed them: rewritten for Helm's agents, scopes, capture rules and Screens; the image step made optional with a no-tool path; Uizze's paid connection removed; Android guidance added. See THIRD_PARTY_NOTICES.md.
