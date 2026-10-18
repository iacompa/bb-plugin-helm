# Native audit before you report (helm-ui reference)

Adapted from Uizze's `reference/audit.native.md` (Apache-2.0, adapting Impeccable by Paul Bakaus, Apache-2.0). Changed for Helm: extended from iOS to Android, written as a self-audit the UI builder runs on its own work, priorities mapped to Helm severities, and the report fixed to `reports/ui/AUDIT.md`. See THIRD_PARTY_NOTICES.md.

Run this on your own build before `helm_report` done, for every phone or tablet app (and adapted, for desktop apps). It is how you find what the Reviewer and the Slop Hunter would otherwise find for you. Audit the real app on a simulator or emulator, plus the source; fix what you find inside your scope, then re-audit the affected screens. Ask your lead about anything outside your scope.

---

## 1. Record what you are auditing

Before checking anything, write the coverage header of `reports/ui/AUDIT.md`:

- the commit, the platform and minimum OS, the devices and simulators or emulators used, orientations and window sizes;
- the screens and states in scope (every SPEC screen, and the states section 9 of the skill requires);
- the appearances (light, dark, increased contrast), text sizes (default, largest) and input methods (touch, screen reader, keyboard or switch) you will use.

Do not invent requirements for an unsupported device, theme or orientation.

**What is not a clean audit.** A browser rendering or web preview of a native app, a failed launch, an empty accessibility tree, a missing screenshot, or a tool you could not run is not evidence that anything passes. An inspected accessibility tree is not a VoiceOver or TalkBack session. A screenshot cannot prove navigation, focus order, keyboard handling or gestures. Say exactly what you inspected and what stays unknown.

## 2. Walk the real task

Walk each SPEC flow on the device: arrival, navigation, input, save and cancel, dismissal, error and recovery. Visit loading, empty, no-results, error, offline, permission-denied, disabled and long-content states where they are reachable; do not claim states you could not reach.

Check scroll regions, lists, bars, sheets, dialogs, menus and the keyboard in the states users meet. Tell apart intentional truncation with a way to see the full value from essential content that is clipped, hidden behind another surface, or unreachable. A view can exist in source and in the accessibility tree while being invisible on screen; hidden views must not stay in the focus order.

Measure contrast against the real composited background: semantic colours, opacity, materials and glass, overlays, gradients and images, in light, dark and increased contrast. Never assume a white background or compare token names. If you cannot measure a pair reliably, mark it "needs manual check", not passed.

## 3. Five dimensions

### 3.1 Accessibility
- Labels, roles or traits, values, and selected, disabled and expanded states on every control; icon-only controls named by action; images described or hidden; errors and status changes not conveyed by colour alone.
- Screen reader (VoiceOver or TalkBack): reading order, nothing unreachable or duplicated, sheets and dialogs contain focus, focus lands sensibly after push, pop and dismissal, meaningful changes are announced. If you inspected only labels, say so.
- Largest text size: labels, values, buttons, sheets and errors stay readable and reachable, with no overlap or essential truncation.
- Targets: at least 44x44pt (iOS) or 48x48dp (Android), measured as the real hit area, with space between neighbours. Points and dp are not screenshot pixels.
- Reduced motion, reduced transparency and increased contrast keep the interface usable and the state feedback intact.
- External keyboard, switch access or D-pad where the platform supports them; mark "untested" if you used touch only.

### 3.2 Performance
- Time to usable content at launch, scrolling a long realistic list, image loading, keyboard appearance, navigation and gesture response.
- In source: heavy work at launch, synchronous main-thread work in scroll or gesture paths, unbounded lists, unstable row identity, needless recomposition or re-render, full-size image decoding for thumbnails, missing caching.
- Separate measured problems from source-level risks. A simulator or emulator does not certify physical-device frame rate, thermals or touch latency.

### 3.3 Appearance and theming
- Real text, controls, bars, overlays and focus in every supported appearance, not just token definitions.
- Stale theme values, crude inversion, unreadable dark content, glass or translucency losing contrast over busy content.
- Custom type, icons and components judged against the app's own system and platform usability; an approved brand choice is not a defect, a concrete legibility or consistency failure is.

### 3.4 Platform navigation and interaction
- Top-level places, hierarchy and focused tasks navigate predictably; tabs and navigation items are places, not actions; sheets and dialogs have clear complete, cancel and dismiss behaviour.
- iOS: the edge-swipe back gesture works on every pushed screen, including ones with horizontal scrollers. Android: system back and the predictive back preview work everywhere, and back never exits from deep inside the app.
- Safe areas and insets: status bar, Dynamic Island or cutout, home indicator or gesture area, rounded corners, the keyboard. Decoration may run edge to edge; text and controls stay usable.
- Standard controls behave like the platform's: selection, menus, pickers, text editing, feedback.
- Dismissal never loses work silently; recovery is possible; completion is not claimed when it did not happen.

### 3.5 Device adaptivity and keyboard
- The smallest and largest supported phones, tablets where supported, orientations, split screen or resizable windows, foldable postures where relevant.
- Larger screens use the intended adaptive structure (split view, rail, list-detail), not a stretched phone layout.
- With the keyboard up: the focused field scrolls into view, errors stay visible, submit and cancel stay reachable, fields advance in order with the right return or IME action, and dismissing the keyboard keeps the input.
- Re-check after rotation, resizing, keyboard show and hide, navigation and interrupted gestures. A keyboard-hidden screenshot is not keyboard coverage.

## 4. Priorities

| Priority | Meaning | Helm severity it maps to |
|---|---|---|
| **P0** | Blocks the task or risks data loss | blocker |
| **P1** | Materially impairs use, or a confirmed accessibility or platform failure | major |
| **P2** | Friction with a workaround | minor |
| **P3** | Polish | nit |

Fix every P0 and P1 inside your scope before reporting done, then re-audit those screens. List open P2 and P3 items in AUDIT.md and INDEX.md; never hide them. Preference-only notes are not findings.

## 5. AUDIT.md

```markdown
# UI audit: <app> @ <commit>

## Coverage
| Dimension | Method | Devices / OS | States | Settings | Status |
|---|---|---|---|---|---|
| Accessibility | XCUITest audit + VoiceOver on onboarding and add-trip | iPhone 18 Pro, iOS 26 sim | all SPEC states | AX5, dark | done |
| Performance | scrolled 2,000-trip fixture; launch timed 3x | iPhone 18 Pro sim | default | - | partial: no physical device |
| ... | | | | | |

## Findings
- **P1, accessibility.** Trip list, default state, `apps/ios/ui/TripRow.swift:42`. The delete icon has no label; VoiceOver reads "button". Evidence: audit output in reports/ui/evidence/a11y-audit.txt. Fix: label it "Delete trip". Status: fixed in <sha>, re-checked.
- **P2, adaptivity.** ...

## Patterns and what to keep
Recurring root causes, deliberate exceptions, and native practices that work and should stay.

## Not checked
What could not run, and why (no Galaxy S25 profile installed, no TalkBack session on the tablet layout).
```

Each finding has the dimension, the exact screen and state, the source location when known, where the evidence came from (source, simulator or emulator, device, accessibility tool), the user impact, and the smallest correct fix. Keep suspected risks apart from confirmed defects.

If nothing material is found, write "no material findings in the inspected scope", list that scope, and keep every limit you recorded. Never present a source-only review, a missing tool or an empty scan as a clean native audit.
