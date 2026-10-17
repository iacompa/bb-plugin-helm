---
name: helm-test
description: Craft method for turning ACCEPTANCE criteria into a traceable test plan and behaviour-focused tests (unit, property, contract, integration, and UI) that run headless, are proven able to fail, stay non-flaky, and produce failing-test reports an owner can act on immediately. Use when you are a Helm Test agent.
---

# Helm Test: craft method

`helm-specialist` covers how you work inside Helm. This skill covers how to test well: what to test, at which level, how to make sure each test means something, and how to report failures so they get fixed rather than argued about.

You write into `tests/**` and `reports/tests/**` only. That affects your method in two ways. First, you never change production code to make it testable. If you need a seam, a test ID, or a debug hook, ask the owner for it through your lead. Second, your tests are the independent check on everyone else's claims, so they have to reflect what ACCEPTANCE and `CONTRACT.md` say, not what the code happens to do.

---

## 1. The non-negotiables

Every test must be able to fail. Concretely:

- **No empty or vacuous assertions.** A test needs at least one assertion about an observable outcome. `expect(x).toBeDefined()`, `assert result`, `XCTAssertNotNil` on something that can't be nil, and "it didn't throw" are not enough on their own. They only count when the behaviour under test really is "returns something" or "does not throw".
- **No mocking the unit under test.** Replace collaborators at the edges (network, clock, randomness, filesystem, OS services), never the thing you're testing. If a test only checks that a mock was called with whatever the mock was set up to return, it tests nothing.
- **No snapshot-everything.** Snapshots are allowed only for small, stable, reviewed output where the whole output *is* the contract: a serialised payload, a rendered string, a small component in one state. Never snapshot whole screens or large objects that get rubber-stamped with `-u`.
- **No skipped tests left in.** No `.skip`, `xit`, `@Ignore`, `@Disabled`, `XCTSkip`, `pytest.mark.skip`, or `.only`/`fit` left in committed code. If a test can't pass yet because the feature is missing, it should fail, and it goes in your report. If it's blocked by the environment, leave it out of the commit and record the gap.

Corollaries:

- No conditional logic that can bypass the assertion (`if (el) expect(el)...`).
- No `try/catch` that swallows the failure.
- No assertion on a value the test itself computed with the same code under test (a tautological oracle).
- No sleeps used as synchronisation.

---

## 2. Workflow

### Step 1: Read the spec, not the code

Read ACCEPTANCE and `CONTRACT.md` first. Pull out every **observable behaviour**: inputs, outputs, state changes, error cases, limits, and timing promises. Write them down as the user or the caller would see them. Read the implementation only afterwards, to find seams and risky branches. Otherwise you end up testing the code's mistakes as features.

If a criterion is ambiguous or can't be tested ("should be fast", "intuitive UI"), propose a measurable version to your lead ("cold start under 2 s on the reference simulator") and don't invent one silently.

### Step 2: Survey what exists

- Find the test runner and conventions that are already in place (`package.json` scripts, `jest.config`/`vitest.config`, `pytest.ini`/`pyproject`, Xcode test targets, `build.gradle` test dependencies, `playwright.config`). Use them. Add a new framework only when nothing existing can cover a level, and justify it in the plan.
- Run the existing suite once, headless, and record the baseline: pass, fail, skip, and duration. Report pre-existing failures as a baseline, not as your findings.
- List any existing tests that break the non-negotiables. Report them to the owner. You may fix them only if they live in `tests/**`.

### Step 3: Write the test plan

Write `reports/tests/PLAN.md` before writing tests. Structure:

```markdown
# Test plan: <app/feature> @ <commit>

## Scope and levels
- Static: typecheck + lint (owned by build; we rely on it, not duplicate it)
- Unit/property: pure logic in <modules>
- Integration: <module> + real DB (SQLite in-memory/Testcontainers), HTTP via local server
- Contract: CONTRACT.md §API, §IPC, §file formats
- UI/E2E: <critical journeys only>
- Out of scope (and why): <...>

## Traceability
| AC id | Behaviour (observable) | Level | Cases | Oracle | Test location | Status |
|------|------------------------|-------|-------|--------|---------------|--------|
| AC-3 | Login rejects wrong password with message X, no token stored | integration + UI | happy, wrong pw, locked acct, empty fields, network down | message text + keychain empty | tests/auth/login.test.ts; tests/ui/LoginTests.swift | failing (see F-2) |

## Fixtures and data
## Environments and commands
## Risks / not testable / needs seams from owners
```

For each criterion, derive cases using these lenses:

- **Happy path:** the canonical example from the criterion itself.
- **Boundaries:** empty, one, many, the maximum, max+1, zero, negative, very long strings, Unicode/emoji/RTL text, time zones and DST changes, leap days, locale formats.
- **Errors:** invalid input, a missing resource, permission denied, a network failure or timeout, a server 4xx/5xx, a malformed payload.
- **State:** first run versus returning user, offline then online, interrupted operation, concurrent edits, app backgrounded or killed mid-flow.
- **Adversarial (coordinate with Security):** another user's id, oversized payloads, injection strings. These test correct rejection. They are not pen-tests.
- **Invariants:** properties that should hold for all inputs (section 4.2).

Each row names its **oracle**, meaning how the test knows the answer is right. The oracle should come from the spec: a literal from ACCEPTANCE, a schema from CONTRACT, a hand-computed example, or a reference implementation. It should never come from running the code and pasting its output.

### Step 4: Choose the level

Test each behaviour at the **lowest level that can actually show it**, and put most of your effort where confidence per unit of cost is highest:

- **Static checks** (types, lint) catch whole classes of bugs for free. Don't write tests for what the type system already guarantees.
- **Unit and property tests** are for pure logic: parsing, validation, calculations, state machines, formatting, reducers. They are fast and precise.
- **Integration tests** are for behaviour that lives in the wiring: a repository with a real (local) database, an HTTP handler through the real router and middleware, a view model with a real store and a fake network. For most app work this layer gives the best return, because the bugs are in the wiring.
- **Contract tests** are for every boundary declared in `CONTRACT.md` (section 4.3).
- **UI and end-to-end tests** are for a small number of **critical user journeys** only: sign-in, the core create/read/update flow, purchase, onboarding. They are slow and the most expensive to keep stable, so don't use them to check edge cases that a lower level can cover.

The pyramid (many unit tests, few E2E) and the trophy (static base, widest at integration) agree on the main point: lean on cheap, fast tests, keep a real middle layer, and keep E2E thin. Choose based on where this codebase's risk actually is.

### Step 5: Write the tests

- **Name tests after behaviour:** `rejects_expired_token_with_401`, `"shows empty state when there are no notes"`. Avoid `test1` and `testHandleClick`.
- **Arrange, act, assert.** One behaviour per test, and one reason to fail. Several assertions are fine when they describe the same outcome.
- **Assert on outcomes the user or caller can see:** return values, persisted state, emitted events, rendered text, HTTP status and body. Don't assert on private fields, call order, or internal method calls unless the call *is* the contract, for example "sends exactly one analytics event named X".
- **Keep tests independent.** Each test sets up its own state and cleans up after itself, and must pass alone, in any order, and in parallel.
- **Keep tests readable.** A failing test should explain itself through its name, its data, and the assertion message. Use helpers only where they add clarity. Too much DRY in tests hides the case being tested.

### Step 6: Prove each test can fail

A test you have never seen fail hasn't shown you anything. For every new test, do one of the following and record which one in the plan:

1. **Red first:** the behaviour isn't implemented yet, so the test fails for the right reason, with an assertion failure rather than a compile error or a missing fixture. Then it passes once the owner implements the behaviour.
2. **Sabotage the expectation:** temporarily change the expected value or input *in the test* (for example, expect 401 instead of 200), confirm it fails with a clear message, then revert.
3. **Mutation testing:** run a mutation tool against the module (Stryker for JS/TS, mutmut or cosmic-ray for Python, PIT for JVM/Kotlin, cargo-mutants for Rust, go-mutesting for Go). These work in a sandbox copy or in memory, so you don't edit production files. Surviving mutants in critical code mean assertions are missing. Run it per module, not on every change, because it is slow.

Never edit production source, even temporarily, to prove a test can fail. That's outside your write scope. Use options 1 to 3.

### Step 7: Run headless, repeatedly

- Run the full suite with the commands in section 6, in CI mode with no watch mode, no interactive prompts, and machine-readable reports.
- Run new tests **at least 3 to 5 times**, ideally in random order and in parallel, before you call them stable (section 5).
- Save results, coverage, and UI artifacts (traces, screenshots, `.xcresult` bundles) under `reports/tests/<run-id>/`.

### Step 8: Read coverage as a signal

Coverage tells you which code your tests never ran. It doesn't tell you that the code they ran is correct. Use it to:

- Find **untested critical branches** (error handling, authorisation paths, money and data-loss paths) and add behaviour tests for them.
- Spot dead code and pass it to the owner as an observation.

Don't add tests just to raise the percentage, don't test trivial getters to hit a threshold, and don't treat 100% as done. A suite that hits every line with weak assertions is worse than one at 70% with sharp ones, because it creates false confidence. When you report coverage, report it per risk area ("auth module 92% branch; payment retry path 0%: added F-4"), not as a single number.

### Step 9: Report

Update the traceability table status for every AC: passing, failing (with a link to the failure), blocked (with the reason), or not testable (with your proposal). File each failure using section 7.

---

## 3. Test doubles and fixtures

**Where to put doubles.** Replace only things that are slow, nondeterministic, external, or have side effects:

| Collaborator | Preferred double |
|---|---|
| Remote HTTP API | Local stub server or request interception (MSW, `page.route`, WireMock, OkHttp MockWebServer, `URLProtocol` stub) driven by CONTRACT examples |
| Database | Real engine, local and ephemeral (SQLite in memory, Testcontainers, a throwaway schema). A fake is fine for pure unit tests |
| Clock / timers | Injected clock or fake timers. Never real `now()` in assertions |
| Randomness / UUIDs | Seeded generator or injected provider |
| Filesystem | Temp directory per test, deleted afterwards |
| OS services (keychain, notifications, location) | Fake behind the app's own protocol/interface. Request the seam if it doesn't exist |

**Prefer fakes over mocks.** A fake is a small working implementation, such as an in-memory repository. It lets you assert on resulting state instead of on calls, which keeps tests from breaking every time the code is refactored. Use mocks or spies only where the interaction itself is the behaviour.

If the code under test can't be tested without mocking its internals, that's a design problem. Report it as a request for a seam. Don't route around it.

**Fixtures:**

- Build data with **builders or factories** that have sensible defaults and explicit overrides (`aUser({ locked: true })`), so each test shows only the fields that matter to it.
- Keep golden files and sample payloads small, human-readable, and next to the tests that use them, under `tests/fixtures/`. Derive them from CONTRACT examples.
- Never use real personal data, real credentials, or production dumps. Generate synthetic data. Use reserved domains (`example.com`) and documentation IP ranges.
- Give each test its own data, and use unique ids when tests share a database, so parallel runs don't collide.

---

## 4. Techniques

### 4.1 Behaviour-focused unit tests

Test through the public interface of a module. A good test survives a refactor that keeps behaviour the same and fails when behaviour changes. If renaming a private method breaks your test, the test is coupled to the implementation.

### 4.2 Property-based testing

Use property tests where an invariant holds across a large input space: parsers, serialisers, validators, sorting and merging, money arithmetic, date maths, sync and conflict resolution. Libraries: fast-check (JS/TS), Hypothesis (Python), SwiftCheck or swift-testing with parameterised arguments (Swift), Kotest property testing or jqwik (Kotlin/JVM), proptest or quickcheck (Rust), `testing/quick` or rapid (Go).

Useful property patterns:

- **Round trip:** `decode(encode(x)) == x`. Start here. It's cheap and catches a lot.
- **Invariant:** the output always satisfies a rule (sorted, unique, within bounds, total preserved).
- **Idempotence:** `f(f(x)) == f(x)`. Use it for normalisation, migrations, and retry-safe operations.
- **Oracle / model:** the fast implementation agrees with a simple, obviously correct reference.
- **Metamorphic:** a known change to the input causes a predictable change in the output (adding an item increases the count by one).

Keep generators realistic but broad. Over-constrained generators never reach the edge cases. Pin the seed in CI output so failures can be reproduced. When the tool shrinks a failure to a minimal counterexample, add that case as an explicit example test.

### 4.3 Contract tests

`CONTRACT.md` is the source of truth for every interface, so test it from both sides:

- **Provider side:** run the real server or handler locally and check every endpoint in the contract. Check the status codes, response shape against the schema (OpenAPI/JSON Schema validation), required fields, error format, and auth requirements. Include error responses, not just 200s.
- **Consumer side:** check that the client parses every documented response, including optional fields that are absent, unknown extra fields, error bodies, and empty lists. Then check that it builds requests that match the schema.
- **Schema drift:** if the code exposes a machine-readable spec, diff it against `CONTRACT.md`. A mismatch is a finding for whoever owns the drift.
- When consumer and provider are developed separately, consumer-driven contracts (Pact-style) record what the client really uses, and the provider replays it. Use them only if the project has already adopted them. Otherwise schema validation against CONTRACT examples does the job with less machinery.
- Match on structure and types, not on incidental values like timestamps or generated ids.

### 4.4 UI tests

Keep the number small, and focus them on journeys. Find elements the way a user or assistive technology would, and wait on state, not on time.

**Web and desktop renderers (Playwright, including Electron via `_electron`):**
- Locator priority: `getByRole` with an accessible name, then `getByLabel`/`getByText`/`getByPlaceholder`, then `getByTestId`. Use CSS or XPath only as a last resort.
- Use web-first assertions (`await expect(locator).toHaveText(...)`) that retry automatically. Never `waitForTimeout`. Don't treat `networkidle` as "ready". Assert on the visible state you need.
- Isolate state with a fresh context per test. Reuse auth through a setup project and `storageState`. Stub third-party network calls with `page.route`.
- Turn on traces and screenshots on failure (`trace: 'retain-on-failure'`).

**iOS (XCUITest):**
- Query by `accessibilityIdentifier` for stability and by label for user-visible text. Identifiers must be added in app code, so request them from the UI owner and list the ones you need in the plan.
- Wait with `waitForExistence(timeout:)` or expectations on predicates, never with `sleep`.
- Use launch arguments and environment variables (`app.launchArguments`) for deterministic state such as a stubbed backend, a reset store, disabled animations, and a fixed locale. The app must support them, so request that too.
- Assert that exactly one matching element exists before interacting with it.

**Android (Compose testing / Espresso):**
- Prefer semantic matchers (`onNodeWithText`, `onNodeWithContentDescription`, role matchers). Use `onNodeWithTag` with `Modifier.testTag` when text is localised or dynamic. For UiAutomator, tags must be exposed through `testTagsAsResourceId`.
- Rely on Compose's idling synchronisation and `waitUntil` with a condition. For Espresso, register idling resources for background work.
- Run JVM-level Compose UI tests with Robolectric where possible, for speed. Keep device or emulator tests for journeys that need real platform behaviour.

**Accessibility as a side effect:** role- and label-based locators that can't find an element often point to a real accessibility defect. Report it to the UI owner.

### 4.5 Snapshot and visual tests (narrow use)

Allowed when the snapshot is small, deterministic (fixed fonts, locale, time, and data), reviewed line by line when created, and covers a contract-level output. Every snapshot update needs a sentence in your report explaining why the change is intended. A snapshot nobody reads isn't a test.

---

## 5. Flakiness: prevent, detect, handle

The most common causes of flakiness are async waits, concurrency, and dependence on test order. Time and environment come next. Countermeasures:

- **Async:** wait on conditions (retrying assertions, `waitFor`, expectations, idling resources), never on fixed sleeps. Await every promise. Flush fake timers explicitly.
- **Order and shared state:** no shared mutable globals or singletons left dirty, a fresh database or schema or transaction per test, temp dirs per test. Run with random ordering to expose hidden dependencies (`vitest --sequence.shuffle`, `jest --randomize`, `pytest -p randomly`, `go test -shuffle=on`).
- **Time:** inject a clock. Pin `TZ=UTC` and the locale in the test environment, and add explicit tests for other time zones and DST where the behaviour depends on them.
- **Randomness:** seed it and print the seed.
- **Network:** no real external services in the default suite. Use local stubs. Any live smoke tests are opt-in and go in a separate command.
- **Concurrency:** use the race detector where one exists (`go test -race`, Thread Sanitizer in Xcode schemes). Use unique resource names per worker.
- **UI:** disable animations, give each test a fresh app state, and use stable locators.

**Detection:** before you commit, run new or changed tests repeatedly (`playwright test --repeat-each=5`, `vitest run --retry=0` in a loop, `pytest --count=5` with pytest-repeat, `go test -count=5`, `xcodebuild test-without-building` with `-test-iterations 5 -retry-tests-on-failure` for diagnosis only).

**Handling:** a flaky test is a bug, either in the test or in the product. Never hide it with retries in the committed config or a skip. Find the cause. If it's a product race, file it as a failure with its frequency ("fails 3/20 runs"). If you can't fix it this cycle, leave it out of the commit and report it as an open item.

---

## 6. Headless commands

Use the project's scripts if they exist (`npm test`, `make test`). Otherwise use the following. All of them run non-interactively.

```bash
# JS/TS
npx vitest run --reporter=default --reporter=junit --outputFile=reports/tests/junit.xml --coverage
npx jest --ci --coverage --reporters=default --reporters=jest-junit   # jest-junit if installed
npx playwright test --reporter=line,html --trace=retain-on-failure    # headless by default
npx playwright test --repeat-each=5 tests/e2e/login.spec.ts           # flake check
npx stryker run                                                      # mutation, per module

# Python
python -m pytest -q -p no:cacheprovider --junitxml=reports/tests/junit.xml --cov=src --cov-branch --cov-report=term-missing
python -m pytest -p randomly --count=5 tests/test_parser.py          # needs pytest-randomly, pytest-repeat

# Swift / iOS / macOS
swift test --parallel
xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' \
  -resultBundlePath reports/tests/ios.xcresult -enableCodeCoverage YES CODE_SIGNING_ALLOWED=NO | xcbeautify
xcrun simctl list devices available                                  # pick a destination that exists
xcrun xccov view --report reports/tests/ios.xcresult

# Android / Kotlin
./gradlew testDebugUnitTest                                          # JVM + Robolectric
./gradlew connectedDebugAndroidTest                                  # needs a running emulator
./gradlew <device>DebugAndroidTest                                   # Gradle Managed Device, headless emulator
emulator -avd <name> -no-window -no-audio -no-boot-anim &            # if you must start one manually

# Rust / Go / Flutter
cargo test --all-features -- --nocapture
go test ./... -race -count=1 -shuffle=on -coverprofile=reports/tests/cover.out
flutter test --coverage

# Desktop
npx playwright test -c playwright.electron.config.ts                 # Electron via _electron.launch
cargo test --manifest-path src-tauri/Cargo.toml                      # Tauri Rust side; UI via WebDriver if configured
```

Set `CI=true` and `TZ=UTC` in the environment for consistency. If a level can't run in this environment (no simulator runtime, no emulator image), record it as **blocked** with the exact error. Don't report it as passing.

---

## 7. Failing-test report

Every failure you report should be reproducible in one command, show expected versus actual, and point to the acceptance criterion it violates. Treat suspected causes as hypotheses.

```
[F-2] AC-3 violated: wrong password stores a token anyway
Test: tests/auth/login.integration.test.ts › "rejects wrong password and stores no token"
Repro: CI=true TZ=UTC npx vitest run tests/auth/login.integration.test.ts -t "rejects wrong password"
Commit: <sha>   Frequency: deterministic (5/5)   Level: integration

Expected (AC-3 / CONTRACT §Auth.login): 401 {code:"INVALID_CREDENTIALS"}; secure store empty
Actual: 401 returned, but secureStore.get("refresh") === "<redacted, 64 chars>"

Minimal input: user "a@example.com" (fixture aUser()), password "wrong"
Evidence: reports/tests/2026-10-17-1/login.log (lines 40-58)

Suspected location (hypothesis, not verified): app/src/auth/session.ts:77 —
refresh token is persisted before the status check at :81.
Owner (suggested): Code agent (auth)
Proven-can-fail: yes (sabotage check; passes with a correct fake server)
```

Rules:

- **Title:** the violated criterion plus the observed misbehaviour, in user terms.
- **Repro:** a copy-paste command scoped to the single test, with the environment variables it needs.
- **Expected:** quoted or paraphrased from ACCEPTANCE or CONTRACT, with the reference. Not "what I thought it should do."
- **Actual:** the concrete observed value, with secrets redacted.
- **Frequency:** deterministic, or n/m runs. Flaky failures are still failures.
- **Location:** a `path:line` hint labelled as a hypothesis. Point to it, don't patch it.
- **Artifacts:** paths under `reports/tests/`: logs, traces, screenshots, `.xcresult`.
- **One failure per root cause.** Group tests that fail for the same reason.

The run summary in `reports/tests/<run-id>/SUMMARY.md` gives the totals (pass, fail, blocked), the AC status table, coverage by risk area, the flake check results, and baseline failures that predate your work.

---

## 8. Pitfalls

- **Testing the implementation, not the spec.** Reading the code first and asserting whatever it currently does turns bugs into enshrined behaviour.
- **Mock-heavy "unit" tests** that pass while the real wiring is broken. If every collaborator is mocked, an integration test is probably what you need.
- **Asserting on call counts and private state,** which makes tests break on every refactor and teaches the team to ignore them.
- **E2E for everything.** A slow, flaky suite gets disabled. Push edge cases down to unit and integration tests.
- **Bulk-updating snapshots** to make CI green.
- **Coverage theatre:** tests that run lines without asserting anything about them.
- **Retries to hide flakiness,** which turns a product race condition into an invisible one.
- **Shared fixtures that drift,** where one test changes a shared object and another breaks three files away.
- **Testing on the developer's clock and locale,** so tests pass in one time zone and fail in CI.
- **Silent blocked levels:** reporting "all green" when the UI suite never ran.
- **Real data in fixtures,** meaning PII or real credentials copied from logs or production.
- **Asking for nothing:** working around a missing test ID or seam with brittle selectors instead of requesting it from the owner.

---

## 9. Self-review checklist

Before reporting, confirm every item:

- [ ] `reports/tests/PLAN.md` maps every ACCEPTANCE criterion to its tests, level, cases, oracle, and status. Criteria that can't be tested have a proposed measurable version.
- [ ] Every oracle comes from ACCEPTANCE, CONTRACT, or a hand-worked example, never from the code's own output.
- [ ] Cases cover happy path, boundaries, errors, state transitions, and relevant invariants. Property tests exist where an invariant spans a large input space.
- [ ] Every boundary in `CONTRACT.md` has provider-side and consumer-side checks, including error responses.
- [ ] UI tests cover only critical journeys, use role, label, or ID locators, and contain no sleeps.
- [ ] Every test asserts on an observable outcome. No vacuous assertions, no mocking the unit under test, no broad snapshots, no skip or only markers, no assertion-bypassing conditionals.
- [ ] Every new test was seen to fail (red first, sabotage, or mutation), and the plan records which method.
- [ ] New tests passed at least 3 to 5 repeated runs in random order with `TZ=UTC`. No retries hide flakiness.
- [ ] Fixtures are synthetic, built with builders or factories, isolated per test, and cleaned up.
- [ ] I read coverage per risk area, and critical uncovered branches got tests or were reported.
- [ ] Every failure report has a one-command repro, expected versus actual with a spec reference, frequency, artifacts, and a `path:line` labelled as a hypothesis.
- [ ] Blocked levels are reported with exact errors. Baseline failures are separated from new ones.
- [ ] I changed nothing outside `tests/**` and `reports/tests/**`. Seams and test IDs I need are requested from owners.

---

## Sources

- Ham Vocke, "The Practical Test Pyramid" (martinfowler.com): https://martinfowler.com/testing
- Testing trophy versus pyramid discussion: https://www.augmentcode.com/guides/is-the-test-pyramid-dead
- Stryker Mutator documentation (coverage versus mutation score): https://stryker-mutator.io/docs/
- Coverage and Goodhart's law: https://about.codecov.io/?p=7367
- Property-based testing patterns (Trail of Bits skill): https://mintlify.com/trailofbits/skills/plugins/property-based-testing
- Contract testing practices and Pact workflow: https://tessl.io/skills/github/secondsky/claude-skills/api-contract-testing
- Playwright waiting and locator guidance: https://www.browserstack.com/guide/playwright-wait-types and https://www.skills.sh/checkly/docs/playwright-best-practices-for-agents
- Jetpack Compose testTag and interoperability testing: https://composables.com/docs/androidx.compose.ui/ui/properties/testTag and https://developer.android.google.cn/develop/ui/compose/testing/interoperability
- XCUITest element queries and accessibility identifiers: https://www.simplified.guide/_export/xhtml/xcuitest/ui-element-query
- Flaky test causes (multivocal review; Luo et al. lineage): https://arxiv.org/pdf/2212.00908 and https://arxiv.org/pdf/2103.02669
