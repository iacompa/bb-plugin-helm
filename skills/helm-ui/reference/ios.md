# Native iOS and iPadOS design (helm-ui reference)

Adapted from Uizze's `ios-design` skill and `reference/ios.md` playbook (Apache-2.0, adapting Impeccable by Paul Bakaus, Apache-2.0, with material from ehmo's platform-design-skills, MIT). Changed for Helm: rewritten around Helm's UI builder, capture rules and Screens; component, API and capture detail added; Uizze's paid reference connection removed. See THIRD_PARTY_NOTICES.md.

Follow the app's existing iOS conventions first, then Apple's. A native screen feels predictable before it feels distinctive: spend originality on content, type, colour and one signature moment, never on reinventing navigation.

Check the app's **deployment target** before using any API below, and the current Human Interface Guidelines for anything newer than this file. Do not give an older target the newest appearance by imitation; give it the system look of its own OS version.

---

## 1. Structure

| Need | Use | Not |
|---|---|---|
| Top-level places (2 to 5) | Tab bar (`TabView`) | A hamburger menu; a tab that performs an action instead of showing a place |
| Drill-down hierarchy | Navigation stack (`NavigationStack`, large title on top-level screens, inline title on detail) | Custom back buttons, hidden bars that break the edge swipe |
| A self-contained task (compose, filter, edit) | Sheet with detents (`.presentationDetents([.medium, .large])`), Cancel leading, the confirming action trailing | A full new screen pushed for a quick edit; sheets stacked three deep |
| Immersive or blocking flow (camera, onboarding) | `.fullScreenCover` with a clear way out | A sheet the user can swipe away mid-payment without warning |
| A destructive or multi-choice decision from a button | `.confirmationDialog` | An alert with four buttons |
| Something critical the user must acknowledge | `.alert`, one or two buttons, the destructive one with the destructive role | Alerts for routine confirmations or tips |
| Secondary actions on an item | `.contextMenu` and `.swipeActions`, both, with the same actions in an edit mode or the detail screen | Swipe-only actions (no alternative) |
| Search | `.searchable` in the navigation bar (or a search tab) | A custom search field floating over content |
| iPad and large windows | `NavigationSplitView` (sidebar, content, detail), pointer hover, keyboard shortcuts | A phone layout letterboxed in the middle of an iPad |

- **Preserve the edge-swipe back gesture.** Never hide the system back button to draw your own. Check nested horizontal scrollers and drag gestures do not swallow it.
- **Keep state through navigation.** Back, tab switches and sheet dismissal return the user to where they were, with their scroll position and drafts. Swiping a sheet with unsaved changes asks first (`.interactiveDismissDisabled` plus a confirmation) rather than discarding.
- **One primary action per screen**, in the place iOS users expect: the trailing navigation-bar button for "Save", "Done", "Add"; a prominent button at the bottom of a sheet or form for a flow's main step.

## 2. Controls

- Prefer native controls themed with the app's tint: `List` and `Form` with grouped or inset-grouped style for settings and data entry, `Toggle` (not checkboxes), checkmarks for single choice in a list, `Picker` (menu, segmented or wheel by context), `DatePicker`, `Stepper`, `Slider`, `Menu`, `ShareLink`, `PhotosPicker`.
- Buttons: one prominent style per screen for the primary action (`.borderedProminent`, or the glass prominent style on iOS 26 and later), bordered or plain for the rest, the destructive role for deletion.
- Segmented controls switch views of the same content (2 to 5 segments), never navigate elsewhere.
- **SF Symbols** for icons, sized with the text they sit beside (`.imageScale`, symbol weights matching the font weight), in the variant iOS uses for the context (filled for a selected tab). Custom icons are drawn on the same grid and weight. No emoji as icons.
- Text fields: the right `keyboardType`, `textContentType` (for autofill: `.username`, `.password`, `.oneTimeCode`, `.emailAddress`, address parts), `submitLabel`, and focus moving field to field with `@FocusState`.

## 3. Typography

- Use **text styles**, never fixed sizes: `.largeTitle` (34pt at the default size), `.title` (28), `.title2` (22), `.title3` (20), `.headline` (17 semibold), `.body` (17), `.callout` (16), `.subheadline` (15), `.footnote` (13), `.caption` (12), `.caption2` (11).
- A custom face scales with `Font.custom(_:size:relativeTo:)`. Spacing and icon sizes that should grow with text use `@ScaledMetric`.
- **Dynamic Type to the largest accessibility size** (AX5) without clipped or overlapping essential text: labels wrap (no `lineLimit(1)` on meaningful text), horizontal rows become vertical at accessibility sizes (`ViewThatFits`, or check `dynamicTypeSize.isAccessibilitySize`), and fixed heights go.
- Bold Text, Larger Text and Button Shapes are user settings: test that your custom components honour them.

## 4. Colour and materials

- Build on **semantic system colours** (`label`, `secondaryLabel`, `tertiaryLabel`, `systemBackground`, `secondarySystemBackground`, `systemGroupedBackground`, `separator`) or asset-catalogue colours with Any, Dark and High Contrast variants. The app's accent is the tint, used for interactive elements and selection.
- **Liquid Glass (iOS 26 and later).** Apple's current design language puts navigation and controls on a glass layer that floats above content. Building with the current SDK, the system bars, tab bar, toolbars, sheets and many controls adopt it automatically. Let them: do not paint opaque custom backgrounds behind system bars, do not put glass on glass, and keep glass for the functional layer (bars, floating controls), never for content cards. Apply custom glass (`.glassEffect`) sparingly to a floating control that genuinely sits above content. Check text and icons on glass over your busiest content, and with Reduce Transparency and Increase Contrast on.
- On older deployment targets, use the system materials of that OS (`.regularMaterial` and friends) for bars and overlays only where content scrolls beneath; do not fake glass with a blur on cards.
- Dark mode uses elevated surface colours rather than shadows. Smart Invert should leave photos and media alone (`accessibilityIgnoresInvertColors`).

## 5. Layout

- Respect **safe areas** (status bar, Dynamic Island, home indicator, rounded corners). Backgrounds may extend edge to edge; text and controls may not. Never draw a fake status bar, home indicator or device frame inside the app.
- Margins follow the system layout margins (about 16pt on iPhone) and readable content width on iPad; lists use the system insets.
- **Keyboard:** the focused field and the primary action stay visible; `.scrollDismissesKeyboard(.interactively)` on scrolling forms; bottom actions sit in `.safeAreaInset(edge: .bottom)` so they ride above the keyboard. Do not add your own keyboard padding on top of the system's.
- Prefer content-driven layout and scrolling to fixed screen heights. Check the smallest supported iPhone (an SE-class or mini-class height) and the longest realistic content.
- iPad: sidebars and split views, popovers for small choices anchored to their control, resizable windows and Stage Manager sizes, pointer hover effects (`.hoverEffect`), and keyboard shortcuts (`.keyboardShortcut`) for frequent actions.

## 6. States

- Empty and no-results: `ContentUnavailableView` (iOS 17 and later; there is a search variant) with a domain message and one action.
- Loading: content-shaped placeholders (`.redacted(reason: .placeholder)` over real layout) or `ProgressView` for short waits; `.refreshable` for pull to refresh with cached content showing.
- Errors: inline beside the failed control or as the screen's content with a retry, never an alert for every network hiccup.
- Permissions: a short explanation screen before the system prompt, asked at the moment of need (not at launch); after a denial, the feature explains what is off and offers a button to the app's Settings page.
- Offline: cached content readable, a quiet indicator, queued changes shown as pending.
- iOS has **no system toast.** Confirm small actions inline (the row updates, a checkmark appears) and offer undo where it matters; reserve banners for genuinely global events.

## 7. Motion and haptics

- Use the system transitions (push, sheet, zoom navigation transition on iOS 18 and later with `.navigationTransition(.zoom(...))` and `.matchedTransitionSource`) and springs. One custom moment is plenty.
- Haptics confirm meaningful outcomes: `.sensoryFeedback(.success, trigger:)` after a save, selection feedback on a picker snap. Never on every tap.
- With **Reduce Motion** on, replace slides, zooms and parallax with cross-fades or instant changes and keep the state feedback (`@Environment(\.accessibilityReduceMotion)`).

## 8. Accessibility specifics

- `accessibilityLabel` on icon-only controls (the action, not the glyph), `accessibilityValue` for values, `accessibilityHint` only when the result is not obvious.
- Combine a row into one element (`.accessibilityElement(children: .combine)`) so VoiceOver reads one sentence; mark section titles as headers (`.accessibilityAddTraits(.isHeader)`) so the rotor can jump between them.
- Swipe and context actions are also `accessibilityAction`s. Custom controls declare their traits (button, selected, adjustable).
- Voice Control works from visible labels: keep the accessible name matching the visible text, and add `accessibilityInputLabels` for icon buttons.
- Hit areas at least 44x44pt (`.contentShape` and padding enlarge a small glyph's target without enlarging its artwork), with room between adjacent targets.
- Test: an XCUITest accessibility audit (`try app.performAccessibilityAudit()`, Xcode 15 and later) catches missing labels, small targets, contrast and clipped text; Accessibility Inspector inspects one screen; then walk one flow with VoiceOver at AX5 in dark mode.

## 9. The platform test: what makes an iOS screen feel wrong

- A hamburger menu, a floating action button, Material ripples, Android-style top tabs, snackbars.
- A custom back button or hidden navigation bar that breaks the edge swipe.
- A website in a phone: a centred hero with "Get started", a footer, breadcrumbs, hover-only affordances.
- Checkboxes in settings, a dropdown where a menu or picker belongs, a modal alert for routine success.
- Fixed font sizes, text cut off at large sizes, controls smaller than 44pt.
- Opaque custom bars fighting the system glass, glass stacked on glass, frosted cards for decoration.
- A permission prompt on first launch, before the user knows why.
- An onboarding carousel of three marketing slides before the user can do anything.

## 10. Capturing on the simulator

```bash
xcrun simctl list devicetypes | grep -i iphone          # exact model names
xcrun simctl create helm-iphone-18-pro "iPhone 18 Pro"  # once per model; reuse it after
xcrun simctl boot helm-iphone-18-pro
xcrun simctl install helm-iphone-18-pro path/to/App.app
xcrun simctl launch helm-iphone-18-pro <bundle id>
xcrun simctl openurl helm-iphone-18-pro "<scheme>://<route>"   # jump to a screen if the app has deep links

# a clean, consistent status bar for every capture
xcrun simctl status_bar helm-iphone-18-pro override --time "9:41" --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3
xcrun simctl ui helm-iphone-18-pro appearance dark      # or light
xcrun simctl ui helm-iphone-18-pro content_size accessibility-extra-extra-extra-large   # largest text; "large" is the default
xcrun simctl privacy helm-iphone-18-pro revoke photos <bundle id>   # the permission-denied state
xcrun simctl io helm-iphone-18-pro screenshot reports/ui/home--default--iphone-18-pro--dark.png
xcrun simctl shutdown helm-iphone-18-pro
```

Run `xcrun simctl ui` with no further arguments to see which options your Xcode supports (Increase Contrast is one on recent versions). Reduce Motion and Reduce Transparency are in the simulator's Settings, Accessibility. Clear the status-bar override when done (`xcrun simctl status_bar <sim> clear`). Snapshot tests (swift-snapshot-testing) can render each screen per device, theme and text size without a booted simulator; they still count only if you look at them.

A matched still does not prove the interaction: also push, pop, swipe back, open and dismiss sheets, raise the keyboard, rotate (on iPad) and switch text size, and say which of these you exercised. A browser preview is never native evidence.
