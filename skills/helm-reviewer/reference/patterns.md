# Review patterns by language and area (helm-reviewer reference)

Adapted from Seth Hobson's `code-review-excellence` skill and its references (MIT, Copyright (c) 2024 Seth Hobson). Changed for Helm: Swift, Kotlin and Compose patterns added for Helm's native apps, every pattern phrased as something you can prove at a line, and the checklists cut to what a gate can verify at one commit. See THIRD_PARTY_NOTICES.md.

Each item is a lead to check at the judged commit, not a finding until you can quote the line and show its effect. Things a linter, formatter or compiler already reports in a check you recorded are not findings.

---

## TypeScript and JavaScript

- `any` (or `as unknown as X`) at a boundary: data from the network, storage, a file or a message used without validation. Look for `JSON.parse`, `await res.json()` and `as Type` with no schema check before use.
- A promise nobody awaits or catches: a missing `await` before a call whose result or failure matters; `forEach(async ...)` expecting to wait; a floating promise in an event handler.
- `fetch` treated as throwing on HTTP errors: no `res.ok` check, so a 500 body is parsed as data.
- React: props or state mutated in place (`user.lastViewed = ...`, `items.push`); effects with missing or wrong dependencies (stale closures); an array index as `key` on a list that reorders; state set after unmount; derived state copied into `useState` and never updated.
- `==` where types differ; `||` used for defaults where `0` or `""` is valid (`??` intended).
- Dates built from strings without a zone; money in floating point.

## Swift and SwiftUI

- Force unwraps (`!`, `try!`, `as!`) on values that can be absent: network fields CONTRACT marks optional, user input, file reads.
- `try?` discarding an error on a path the user cares about (save, delete, sync), so failure looks like success.
- Retain cycles: escaping closures, timers, Combine sinks or notification observers capturing `self` strongly in long-lived objects; observers never removed.
- Concurrency: UI state mutated off the main actor; a `Task {}` started in a view that is never cancelled when the view goes; actor reentrancy assumptions across an `await`; `@unchecked Sendable` hiding a race.
- SwiftUI ownership: `@ObservedObject` (or a plain property) for a model the view creates, so it is recreated on every redraw (`@StateObject` or `@State` with `@Observable` intended); heavy work in `body`; `onAppear` loading again on every appearance without a guard.
- Sensitive values in `UserDefaults` instead of the Keychain; `print` or `NSLog` of models in release builds.

## Kotlin and Jetpack Compose

- `!!` on values that can be null; `lateinit` read before it is set on some path.
- Coroutines: `GlobalScope`, `runBlocking` on the main thread, a scope not tied to a lifecycle, exceptions lost in `launch` without a handler, `catch (e: Exception)` swallowing `CancellationException`.
- Flows collected in the UI without lifecycle awareness (`collectAsStateWithLifecycle` or `repeatOnLifecycle` intended); a `MutableStateFlow` exposed publicly so views can write state.
- Compose: `remember` without the keys the value depends on; `LaunchedEffect(Unit)` capturing a value that later changes; state that should survive rotation or process death held in `remember` instead of `rememberSaveable` or the ViewModel; side effects in composition.
- `runCatching { }.getOrNull()` on a save or network call, hiding the failure.
- Sensitive values in plain `SharedPreferences`; `Log.d` of models or tokens in release.

## Python

- Mutable default arguments (`def f(items=[])`) shared across calls.
- Bare `except:` or `except Exception: pass`; catching broadly around code that should fail loudly.
- Mutable class attributes shared across instances; late-binding closures in loops.
- `is` used for value comparison; naive datetimes mixed with aware ones.

## Tests

- Does the test describe behaviour or implementation? A test asserting internal state or a private method breaks on refactors and misses real bugs; one that drives the public interface and checks what the user or caller sees is the target.
- The mutation question: what change to the code under test would make this test fail? If none would, it is hollow (S11 when it is slop).
- Error and empty paths are covered, not only the happy path.
- Tests are independent and deterministic: no shared mutable state between tests, no order dependence, no wall-clock time, network or developer-machine paths.
- Names say what behaviour is expected.

## Security checklist (always skim; apply fully when the squad has no Security agent)

- Authentication required where SPEC says, and authorization checked on the server for every action that reads or changes another user's data, not only in the UI.
- Tokens validated properly (signature, expiry, audience), stored in the Keychain or Keystore, never logged.
- Input from users, files, deep links, URLs and IPC validated before use; queries parameterised; output escaped; file paths not built from raw input.
- No dynamic code execution on input (`eval`, string-built shell commands).
- No secrets in source, config or history (`helm_slop_scan` covers S6).
- CSRF protection on state-changing cookie-authenticated routes; rate limits on login, reset and other expensive public endpoints.
- Passwords hashed with a slow algorithm (bcrypt, scrypt, argon2); sensitive data encrypted at rest where SPEC or the platform requires it; TLS everywhere.
- Uploads restricted by size and type and stored safely.

## Performance checklist (report only what is observable or measured)

- Queries or requests inside loops (N+1); missing indexes on columns the main flows filter by; whole tables loaded where a page would do.
- Large lists without pagination or virtualisation.
- Blocking I/O, decoding or parsing on the main thread or in a request's hot path.
- Expensive results recomputed on every render or request where a cache or memo fits the data's lifetime.
- Network calls with no timeout; retries with no backoff or cap.
- Listeners, timers and subscriptions never removed.
