# Native Android design (helm-ui reference)

Written for Helm. The method (direction, target, compare and fix, native audit) follows the same adapted Uizze and Impeccable guidance as `ios.md`; the Android detail is Helm's own, from Material Design 3 and the Android developer guides. See THIRD_PARTY_NOTICES.md.

Follow the app's existing Android conventions first, then Material 3's. A native Android screen is edge to edge, adapts from a small phone to a tablet or unfolded foldable, answers the system back gesture, and uses the platform's colour, type and motion systems rather than a port of the iOS design.

Check the app's **minimum and target SDK** and its Compose Material 3 version before using an API below. Material 3 Expressive components and motion appear in recent Compose Material 3 releases: use them consistently if the project has them, and never hand-build imitations of components the library provides.

---

## 1. Structure

| Need | Use | Not |
|---|---|---|
| Top-level places (3 to 5) on a phone | Navigation bar (`NavigationBar`), with the selected item's icon filled and an active indicator | An iOS-style tab bar with tiny labels; a hamburger plus a bottom bar for the same places |
| Top-level places on medium and larger widths | Navigation rail, or a navigation drawer for many places or expanded widths (`NavigationSuiteScaffold` switches between bar, rail and drawer by window size) | A bottom bar stretched across a tablet |
| Screen title and actions | Top app bar: small for most screens, center-aligned for a top-level or brand screen, medium or large collapsing on scroll for top-level content; at most 2 or 3 action icons, the rest in an overflow menu | A row of six icons; centred titles on every screen |
| The screen's primary constructive action | One floating action button (extended with a label when space allows) | Two FABs, or a FAB for a secondary action |
| Sibling views of the same content | Tabs (`PrimaryTabRow`) or a segmented button for 2 to 5 options | Tabs that navigate to unrelated places |
| A short task or extra options | Modal bottom sheet (`ModalBottomSheet`) | A full-screen route for picking one value |
| A decision that blocks | Dialog (`AlertDialog`), title optional, the confirming action named ("Delete trip") | Dialogs for information that can be shown inline |
| Brief feedback, optionally undoable | Snackbar via `SnackbarHostState`, with one action ("Undo", "Retry") | Custom toasts; a snackbar for an error that needs the user's attention on the field |
| Filters and quick choices | Chips (filter, assist, input) | A row of outlined buttons pretending to be chips |
| List and detail on large screens | `ListDetailPaneScaffold` (and supporting-pane layouts) | Pushing the detail as a full screen on a tablet |

- **System back** returns up the hierarchy and closes sheets and dialogs. Never trap it, never make it exit from a nested screen. Opt in to **predictive back** (`android:enableOnBackInvokedCallback="true"` where the target SDK does not already enable it) and use `BackHandler` or `PredictiveBackHandler` only for real in-screen state (an open search, a selection mode). The navigation library's predictive back animations (Navigation 3, or Navigation Compose 2.8 and later) should play on every route.
- Keep state through configuration changes, process death (`rememberSaveable`, `SavedStateHandle`), back and tab switches.

## 2. Edge to edge and insets

- Draw behind the system bars (`enableEdgeToEdge()`; apps targeting Android 15 and later are edge to edge by default). There are no grey or black bars above and below the app.
- Pad content with insets: `Scaffold` passes them to its content; elsewhere use `WindowInsets.safeDrawing`, `Modifier.windowInsetsPadding`, and `Modifier.imePadding()` for the keyboard. Lists scroll under the navigation bar but their last item clears it (`contentPadding`).
- Handle display cutouts and the gesture area: nothing interactive under the gesture handle; no custom horizontal swipe from the screen edges, where system back lives.
- Test with gesture navigation and with three-button navigation.

## 3. Colour

- Build on the **Material 3 colour roles**: `primary`, `onPrimary`, `primaryContainer`, `onPrimaryContainer`, `secondary` and `tertiary` with theirs, `surface`, `onSurface`, `onSurfaceVariant`, the surface containers (`surfaceContainerLowest` to `surfaceContainerHighest`), `outline`, `outlineVariant`, `error`, `errorContainer`. Components use roles, never raw colours.
- Generate the scheme from a brand seed colour (Material Theme Builder or `dynamicColorScheme`-style tooling) instead of hand-picking 30 roles.
- **Dynamic colour** (`dynamicLightColorScheme`, `dynamicDarkColorScheme`, Android 12 and later) takes the user's wallpaper colours. Decide per app: personal utilities usually follow it; strong brands may keep their scheme. Write the decision in DIRECTION.md and provide the brand scheme as the fallback either way. Check contrast with dynamic colour from a few very different wallpapers.
- **Elevation is tonal.** Higher surfaces use higher surface-container roles; shadows are rare and soft. Hard drop shadows look foreign.
- Light and dark schemes are both designed; high-contrast variants exist in the Material tooling.

## 4. Typography

- Use the **Material type roles** in `sp`: `displayLarge/Medium/Small`, `headlineLarge/Medium/Small`, `titleLarge/Medium/Small`, `bodyLarge` (16sp), `bodyMedium` (14sp), `bodySmall`, `labelLarge` (14sp, buttons), `labelMedium`, `labelSmall`. Map your named styles onto them in `Typography`.
- Roboto or Roboto Flex is the native default. A brand face must load reliably (downloadable or bundled fonts), cover the app's languages, and scale.
- **Font scale to 200%** (Android 14 and later scale non-linearly): nothing clipped, rows wrap or stack, no text sized in `dp`, no fixed heights on text containers. Also test the largest Display size.

## 5. Shape, spacing and layout

- Shapes from the theme's shape scale (extra small 4dp, small 8dp, medium 12dp, large 16dp, extra large 28dp), applied by role: a card and a dialog are not the same radius.
- A 4dp grid with 8dp steps; side margins of 16dp on compact widths and 24dp from medium up.
- **Touch targets at least 48x48dp** with 8dp between them. Material components enforce this (`minimumInteractiveComponentSize`); custom ones must too.
- **Window size classes:** compact under 600dp, medium 600 to 840dp, expanded 840dp and up (newer Material guidance adds large and extra-large widths for big tablets and desktop windows). Use the canonical layouts (list-detail, supporting pane, feed) and change navigation from bar to rail to drawer as width grows. Foldables: respect the hinge and the tabletop posture where the app has a reason to.

## 6. Components and states

- Lists: `ListItem` with leading icon or avatar, headline, supporting text and trailing control; whole-row tap targets; checkboxes, switches and radio buttons are native here (a checkbox list is fine on Android).
- Text fields: outlined or filled consistently across the app, label in the field, supporting text for help and errors, the right `KeyboardOptions` (type, IME action, capitalisation) and autofill (`contentType` semantics or the autofill APIs).
- Loading: a linear progress indicator under the top bar for screen loads, circular for small areas, placeholders shaped like content for lists; pull to refresh (`PullToRefreshBox`) with cached content visible.
- Empty and error states: a domain message, a clear action, retry on errors; a snackbar with "Retry" for transient failures.
- Permissions: ask in context; explain first when `shouldShowRequestPermissionRationale` is true; after "Don't allow" twice, the system stops asking, so offer a button to the app's settings page. Notifications (Android 13 and later) and photo access (the photo picker needs no permission) are asked only when needed.
- Offline: cached content readable, queued writes shown as pending.

## 7. Icons

- **Material Symbols** in one style (outlined, rounded or sharp) and one weight across the app; the selected navigation item uses the filled variant. No emoji as icons.
- The launcher icon is an adaptive icon with a monochrome layer so themed icons work.

## 8. Motion and haptics

- Material motion: emphasized easing for most transitions (emphasized decelerate for entering, emphasized accelerate for exiting); short durations (50 to 200ms) for small changes, medium (250 to 400ms) for transitions, long (450 to 600ms) only for large ones. Shared-element and container-transform transitions (`SharedTransitionLayout`) connect a list item to its detail.
- Material 3 Expressive, where the project uses it, brings spring-based motion and shape changes: use its motion scheme rather than hand-tuned curves.
- Haptics confirm outcomes (`HapticFeedbackConstants.CONFIRM`, `REJECT` on API 30 and later, or Compose's haptic types). Never on every tap.
- Test with **Remove animations** on (Settings, Accessibility, Color and motion): nothing may depend on an animation finishing, and infinite or looping animations must stop.

## 9. Accessibility specifics

- `contentDescription` on meaningful images and icon-only buttons (the action, not the glyph); `null` for decorative ones.
- Merge a row into one TalkBack stop (`Modifier.semantics(mergeDescendants = true)`, or `toggleable`/`clickable` on the whole row with the right `Role`); `semantics { heading() }` for section titles; `stateDescription` for custom states; `customActions` for swipe or long-press actions.
- Focus order follows reading order for TalkBack, keyboard and D-pad; a dialog or sheet takes focus and returns it.
- Contrast on real backgrounds in light, dark and dynamic schemes.
- Test: Accessibility Scanner on each screen, Compose or Espresso accessibility checks in UI tests where the project's test versions support them, then one flow with TalkBack at 200% font scale in dark theme. Switch Access and an external keyboard must reach every control.

## 10. The platform test: what makes an Android screen feel wrong

- iOS chevrons with "Back" text, an iOS tab bar, Cupertino switches, pickers or action sheets, iOS-style grouped tables everywhere.
- Grey bars above and below the app, or content hidden under the navigation bar.
- Shadows doing the work of tonal elevation; hard offset shadows.
- Custom toasts for errors; alerts for things a snackbar or inline message should say.
- Centre-aligned titles on every screen; a top bar full of icons; two FABs.
- Text in `dp`, targets under 48dp, text clipped at 200% font scale.
- A phone layout stretched across a tablet or unfolded foldable.
- Custom edge swipes that fight system back, or a back press that exits from deep inside the app.

## 11. Capturing on the emulator

```bash
avdmanager list device | grep -i pixel                 # device profiles (Samsung models: nearest profile, named in INDEX.md)
avdmanager create avd -n helm-pixel-9 -d pixel_9 -k "system-images;android-36;google_apis;arm64-v8a"   # once; use an installed image
emulator -avd helm-pixel-9 -no-window -no-audio -no-boot-anim &
adb wait-for-device; until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -a android.intent.action.VIEW -d "<scheme>://<route>"   # jump to a screen if the app has deep links

# a clean, consistent status bar (demo mode)
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false

adb shell cmd uimode night yes                          # dark theme ("no" for light)
adb shell settings put system font_scale 2.0            # largest text; reset with 1.0
adb shell pm revoke <package> android.permission.CAMERA # the permission-denied state
adb exec-out screencap -p > reports/ui/home--default--pixel-9--dark.png

adb shell am broadcast -a com.android.systemui.demo -e command exit
adb emu kill
```

The waiting loop above runs only while the emulator boots; it is not polling for work. Switch navigation mode with the system overlays where the image has them (`adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural`, or `...navbar.threebutton`). Roborazzi or Paparazzi render Compose screens per device, theme and font scale on the JVM; they count as evidence only once you have looked at them.

A matched still does not prove the interaction: also press back (and watch the predictive back preview), open and dismiss sheets, raise the keyboard, rotate, unfold or resize, and change font scale, and say which of these you exercised. A browser preview is never native evidence.
