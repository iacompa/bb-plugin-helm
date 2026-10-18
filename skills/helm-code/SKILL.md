---
name: helm-code
description: Core code craft (models, storage, migrations, sync, errors, concurrency, tests, dependencies). Use when you are a Helm Core builder.
---

# Helm Core Craft

This skill covers what excellent core code looks like. `helm-specialist` covers how you work inside Helm. Your code is the layer the UI and every other builder depend on. It holds the user's data, so bugs here lose data, corrupt state, or leak information. Optimise for correctness first, then clarity, then speed, and prove each with tests.

The standard: another engineer can use the core from its public API and README alone, and trust it never to silently lose or corrupt data.

---

## 1. Design from the CONTRACT

CONTRACT.md defines the data models and their meaning. Your job is to make that contract executable and enforced.

- **Map the CONTRACT to types first, before any logic.** Each entity, value object, enum, and relationship becomes a type. Make the types say what the CONTRACT says: required fields are non-optional, enums are closed sum types (not strings), identifiers are distinct types (`ShiftId`, not `String`), and money is integer minor units plus a currency code (never floating point).
- **Make illegal states unrepresentable.** If a `Booking` is either `pending`, `confirmed(at:)`, or `cancelled(reason:)`, model it as a tagged union with per-case data, not as three nullable fields and a status string. If a list must be non-empty, use a type that guarantees it or validate at construction.
- **Parse, don't validate.** Turn untrusted input (network, disk, user, other modules) into domain types at the boundary, once. Inside the core, functions accept already-valid types and do not re-check. Constructors or factory functions return a result (`Result<Email, ValidationError>`), so you cannot hold an invalid `Email`.
- **Separate wire, storage, and domain shapes when they differ.** DTOs for JSON, rows or records for the database, and domain types for logic, with explicit mapping functions between them and tests for each mapping. Do not let a database column name or an API quirk leak into the domain.
- **Treat ambiguity in the CONTRACT as a defect.** If the CONTRACT does not say whether a field can be empty, how long it can be, what timezone a timestamp uses, or what happens on deletion, do not guess silently. Raise it, and meanwhile choose the safest interpretation and record it.
- **Times:** store instants in UTC (ISO 8601 or epoch milliseconds) and store the user's IANA timezone separately when local wall-clock time matters (recurring events, "9am every Monday"). Never store local time without its zone. Use a monotonic clock for durations and timeouts, never wall-clock time.
- **Identifiers:** generate them on the client (UUIDv7 or ULID, which sort by time) so records can be created offline and merged without collisions. Never use auto-increment IDs as cross-device identity.

---

## 2. Structure: small, pure, layered

- **Functional core, imperative shell.** Keep business rules (validation, calculations, state transitions, conflict resolution, sorting and filtering) in pure functions that take values and return values, with no I/O, clock, randomness, or globals. Put I/O (storage, network, filesystem, time) in a thin shell that calls the core. Pure functions are easy to test exhaustively, and the shell is easy to fake.
- **Inject effects.** Pass the clock, ID generator, random source, storage, and network client as parameters or through a small protocol or interface. Tests then control time and IDs deterministically.
- **Keep functions small and named for what they decide:** `nextOccurrence(after:rule:zone:)`, `resolveConflict(local:remote:base:)`, `isOverdue(task:now:)`. If a function needs a comment to explain what its body does, split it or rename it. Comments explain *why* (an invariant, a trade-off, a link to the CONTRACT section), not *what*.
- **Make modules deep, not wide.** Default to private or internal. Every public symbol is a promise to the UI builder.
- **No speculative generality.** No plugin systems, generic repositories, or abstract factories for one implementation.
- **Immutability by default.** Domain values are immutable, and updates return new values. Mutable state lives in one owned place (a store or actor) with explicit transitions.

---

## 3. Errors: explicit, typed, never swallowed

Silent failure is the worst kind of bug in a data layer. Every failure is either handled with a deliberate decision or propagated with its context.

- **Model expected failures as types:** use `Result`/`Either`, typed throws, sealed error hierarchies, or discriminated unions. Group them by what the caller can do about them, not by where they came from:
  - `ValidationError` (with field and reason): the user can fix it.
  - `NotFound`, `Conflict`, `PermissionDenied`: the caller decides what to show.
  - `Transient` (network, timeout, lock busy): safe to retry with backoff.
  - `Corruption` and `MigrationFailed`: stop, preserve data, surface it loudly.
  - `Bug` (invariant violated): crash in debug builds, report in release.
- **Never swallow errors.** No empty `catch {}`, no `try?` or `catch (_)` that discards the error without a comment explaining why that is safe, no `.catch(() => null)`, and no logging and continuing as if nothing happened. If you truly intend to ignore an error, write down why at that line.
- **Add context when propagating:** wrap with what was being attempted ("loading shift 0193… for week 2026-W42") while keeping the original error as the cause. Do not replace a specific error with a generic one.
- **Fail fast at boundaries, recover deliberately inside.** Reject invalid input at the edge with a precise error. Retry only idempotent operations, with exponential backoff and jitter, a maximum number of attempts, and a total deadline.
- **Errors carry machine-readable codes and human-safe messages.** The UI maps codes to copy. Core error messages must never include secrets, tokens, or personal data.
- **Partial failure is a first-class result.** Batch operations return per-item outcomes (`[(id, Result)]`) instead of failing the whole batch because one item failed, or claiming success when some failed.
- **Resource safety:** close files, cursors, and connections, and release locks on every path, including error paths (`defer`, `use`, `with`, try-with-resources, `finally`).

---

## 4. Storage

- **Choose boring, proven storage.** SQLite (directly or through a well-maintained wrapper such as GRDB, Room, SQLDelight, Drizzle, or better-sqlite3) is the default for local structured data. Use the platform keychain or keystore for secrets, never plain preferences or files. Use files for large blobs, with the database holding references and checksums.
- **Use transactions for every multi-step write.** A write that touches two tables, or a record plus its outbox entry, either fully succeeds or fully fails. Enable WAL mode for SQLite where supported, and turn on foreign-key enforcement explicitly.
- **Put constraints in the schema, not only in code:** `NOT NULL`, `UNIQUE`, `CHECK`, foreign keys with deliberate `ON DELETE` behaviour. The database is the last line of defence against bugs elsewhere.
- **Index for your actual queries.** Every query used by a list screen or sync path has an index that supports it. Verify with `EXPLAIN QUERY PLAN` (or the equivalent) and record it in a test or a comment.
- **Use parameterised queries only.** Never build SQL or query strings by concatenating input (OWASP injection).
- **Write files atomically** (temp file, flush, rename). Never rewrite a user's data file in place.
- **Deletion:** decide per entity between hard delete and soft delete (tombstones). Anything that syncs needs tombstones so deletions propagate. Define and test retention and purge rules.
- **Encryption at rest** where the CONTRACT or platform requires it. Use platform data protection, never home-made cryptography.

---

## 5. Migrations and versioning

Users will open the new version of the app with data written by every older version. Migrations are the most dangerous code you write, so treat them that way.

- **Version everything persistent:** schema version in the database (`PRAGMA user_version` or a migrations table), a version field on serialised documents and exports, and a version on sync payloads.
- **Migrations are ordered, append-only, and immutable once released.** Never edit a shipped migration. Fix forward with a new one.
- **Each migration runs in a transaction and is idempotent where possible.** On failure, roll back, keep the original data untouched, and surface `MigrationFailed`. Do not leave a half-migrated store, and do not delete and recreate the database to "fix" a failure.
- **Back up before destructive steps.** Copy the store (or the affected tables) before dropping columns or tables or transforming data. Keep the backup until the next successful launch.
- **Use expand, migrate, contract for breaking changes,** especially where other devices or a server may still run the old version:
  1. **Expand:** add the new column, table, or field alongside the old one, and write to both.
  2. **Migrate:** backfill existing data, and switch reads to the new shape.
  3. **Contract:** remove the old shape only when no supported client still depends on it.
- **Readers must tolerate unknown fields** from newer versions (preserve them on round-trip if possible) and missing fields from older versions (with defined defaults). Never fail a whole sync because of one unknown field.
- **Test every migration path with real fixtures.** Keep a fixture database or document for each released schema version under test fixtures. Test that migrating from each old version to the current one preserves every record and every field, with counts and spot values checked. Test that migrating twice is safe, and that a failure mid-migration leaves the original intact.
- **Downgrades:** decide explicitly. Either support reading the newer format read-only or refuse to open with a clear error. Never silently corrupt data on downgrade.

---

## 6. Offline-first and sync

Assume the network is absent, slow, or lying. The local store is the source of truth for the UI. Sync is a background process that reconciles it.

**Local-first architecture**
- The UI reads from and writes to the local store only. Writes succeed locally immediately and are queued for sync. The UI should never wait on the network to show the user's own data.
- **Use an outbox.** Each local mutation writes the change and an outbox entry in the same transaction. A sync worker drains the outbox with retries. The outbox survives app restarts.
- **Every mutation is idempotent.** Each change carries a client-generated operation ID, so replaying it (after a timeout, crash, or retry) has no additional effect. The server or peer deduplicates by that ID.
- **Track sync state per record** (`synced`, `pending`, `failed(reason)`, `conflict`) and expose it through the public API so the UI can show pending and failed states honestly.
- **Pull incrementally.** Use a server cursor or change token, not "fetch everything" and not client timestamps. Handle cursor expiry with a full resync that is safe to run at any time.

**Choosing a conflict strategy.** Decide per entity, and per field where it matters, and write the decision in code comments and the README:

| Strategy | Use when | Watch out for |
|---|---|---|
| **Last-writer-wins (per record)** | Low-contention, single-owner data (settings, a user's own profile). | Silent loss of concurrent edits. Use a hybrid logical clock or server-assigned version, never raw device wall clocks, which drift. |
| **Per-field LWW / merge** | Records where different fields are usually edited independently (title on one device, due date on another). | Needs per-field versions or a base snapshot for three-way merge. |
| **Three-way merge with base** | Structured records where you can compare both sides with the common ancestor. | You must store the base version you last synced. |
| **CRDTs** (counters, sets, sequences, text) | Collaborative or multi-device editing of the same item, offline for long periods. | More storage and complexity. Use a proven library (Automerge, Yjs, or similar) rather than writing your own. |
| **Server-authoritative with rejection** | Invariants that cannot be merged (inventory counts, unique booking slots, money movement). | The client must handle rejection gracefully: roll back optimistic state and explain it. |
| **Surface to user** | Conflicting edits to high-value content where any automatic choice could destroy work. | Keep both versions, show a resolution UI, and never discard either side silently. |

- **Deletions vs edits:** decide whether an edit resurrects a concurrently deleted record or the delete wins. Write a test for it, because this is the most commonly forgotten case.
- **Clocks:** order events with version vectors, hybrid logical clocks, or server sequence numbers. Never rely on device time for correctness. Users change it, and devices drift.
- **Conflict resolution is a pure function** (`resolve(base, local, remote) -> Resolution`), which makes it ideal for exhaustive and property-based testing (section 9).
- **Sync must converge.** Two devices applying the same set of changes in any order must reach the same state. Test that directly.

---

## 7. Concurrency

- **Have one owner per piece of mutable state:** an actor, a serial queue, a single-writer database connection, or a store with a mutex. Document which one. Data races are bugs even when tests pass.
- **Use the platform's structured concurrency** (Swift `async`/`await` and actors, Kotlin coroutines with structured scopes, JS `async` with an explicit `AbortController`, Rust `async` or threads with ownership). Avoid detached or fire-and-forget tasks, which hide errors. If you launch work, something awaits it or handles its failure.
- **Support cancellation and timeouts.** Long operations check for cancellation and stop cleanly. Every network or I/O call has a timeout. Cancelled work must not leave partial writes, so pair it with transactions.
- **Protect read-modify-write cycles.** Use transactions, compare-and-swap with version checks (optimistic concurrency), or serialised access. "Read, then await something, then write" is a race.
- **Never block the main or UI thread** with I/O, parsing large payloads, or heavy computation. Expose async APIs to the UI.
- **Turn on the strict checkers** (Swift strict concurrency, Thread Sanitizer, Go `-race`, lint rules for floating promises) and fix warnings instead of suppressing them.
- **Test concurrency deliberately:** run concurrent writers against the same record in a loop and assert the invariants hold (no lost updates, no duplicates, consistent counts).

---

## 8. Validation

- **Validate at every trust boundary:** user input, network responses (including your own server), files on disk, deep links, push payloads, inter-process messages, and data from other modules. "It came from our backend" is not a reason to trust its shape.
- **Use allowlists, not denylists.** Define what is valid (type, length range, character set, format, range, enum membership) and reject everything else. Check length before running expensive checks such as regexes, and avoid regexes that are vulnerable to catastrophic backtracking.
- **Normalise before comparing:** Unicode NFC, trimmed whitespace, case-folding for case-insensitive keys such as emails, and canonical forms for phone numbers and URLs. Store the normalised form and keep the original only if display requires it.
- **Return all field errors at once,** with stable field paths and codes, so the UI can show every problem in a single pass.
- **Keep validation rules in the domain constructors** and expose them so the UI reuses them instead of reimplementing them.
- **Set size limits on everything:** maximum payload sizes, maximum list lengths, and maximum string lengths, matching the CONTRACT. Unbounded input is a denial-of-service and memory risk.

---

## 9. Tests that can fail

A test is only worth having if a plausible bug would make it fail. Coverage percentages are a side effect, not a goal.

**What to test**
- **Every public API function:** the happy path, each documented error, and the boundaries (empty, one, many, maximum, just over maximum, Unicode, timezone and DST transitions, leap days, negative and zero amounts).
- **Every CONTRACT invariant,** stated as a test name: `test_booking_cannot_be_confirmed_after_cancellation`.
- **Every migration path** with fixtures (section 5).
- **Every conflict-resolution rule,** including delete-versus-edit (section 6).
- **Every bug you fix:** write the failing test first, then fix the bug.

**How to write them**
- **Assert behaviour, not implementation.** Test through the public API. Prefer fakes (in-memory store, fake clock) to deep mocks, and mock only true external boundaries.
- **Keep tests deterministic.** Inject the clock, IDs, and randomness, and keep `sleep` out of tests. Flaky tests are bugs. Fix the cause, do not add retries.
- **Prove each test can fail.** For each important test, briefly break the code (flip a condition, remove a line), watch the test fail, then restore it. A test that passed before you wrote the feature is suspect. Use mutation testing (Stryker, mutmut, PIT, cargo-mutants) on critical modules where it is available.
- **Avoid tautologies:** no `assert(true)`, no asserting a value against itself, no snapshot tests of data structures nobody reviews, and no tests that only check "does not throw" when the output matters.

**Property-based tests where the input space is large.** Use Hypothesis, fast-check, SwiftCheck, Kotest property, proptest, or the equivalent:
- **Round-trips:** `decode(encode(x)) == x` for every serialisation format, and `fromRow(toRow(x)) == x`.
- **Migration preserves data:** for generated records in schema N, migrating to N+1 keeps every field.
- **Sync convergence:** applying a generated set of operations in any order gives the same final state. Merge is commutative, associative, and idempotent where the strategy claims it is.
- **Invariants hold under random sequences of operations:** balances never go negative, sort order is stable, IDs stay unique.
- **Parsers never crash** on arbitrary input. They return either a value or a typed error.

**Integration tests** run against the real storage engine (an in-memory or temp-file SQLite, not a mock) for queries, constraints, transactions, and migrations.

---

## 10. Performance budgets as tests

Performance is a requirement only if a test fails when you miss it.

- **Set explicit budgets** from the brief or sensible defaults, and encode them as tests or benchmarks that run in CI. Example defaults for a mobile or desktop app with realistic data volumes:
  - Cold open of the local store and first query: under 100ms with 10,000 records.
  - List query for one screen (paged): under 16ms on the main thread budget, or done off the main thread entirely.
  - Single write including the outbox entry: under 10ms.
  - Sync of 1,000 pending changes: under 5s on a normal connection, with bounded memory.
  - Migration of the largest expected store: under 2s, or run with progress and resumability.
- **Benchmark against realistic volumes** (10 times the expected size), not three rows.
- **Measure, don't guess.** Profile before optimising. Use the platform's benchmark harness (XCTest `measure`, Jetpack Microbenchmark, `pytest-benchmark`, Vitest bench, criterion) and assert thresholds with headroom for CI noise.
- **Watch the usual suspects:** N+1 queries, missing indexes, loading whole tables to filter in memory, unbounded caches, re-parsing on every access, serialising on the main thread, and quadratic loops over lists.
- **Paginate and stream.** No public API returns an unbounded list. Use cursors or pages, or async sequences.

---

## 11. Dependencies: minimal and verified

Every dependency is code you ship, cannot fully review, and must keep patched. AI-suggested package names are a known attack vector ("slopsquatting"). Research has found that a meaningful share of package names suggested by code models do not exist, and attackers register those names.

- **Prefer the standard library and platform SDKs.** Add a dependency only for substantial, risky work (crypto, CRDTs, database drivers, time zones), not for 30 lines you can write and test.
- **Never invent a package.** Before adding any dependency, verify it in the official registry (npm, PyPI, crates.io, Maven Central, Swift Package Index, pub.dev): it exists under that exact name, it has the expected publisher or repository, it has a real release history and recent maintenance, it has meaningful usage, and its licence is compatible with MIT distribution (prefer MIT, Apache-2.0, BSD, ISC, and flag GPL/AGPL). Watch for names that are one character off a popular package.
- **Verify the API you call exists** in the version you install. Read its docs or source, and do not rely on remembered method names.
- **Pin and lock.** Commit the lockfile (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`/`uv.lock`, `Cargo.lock`, `Package.resolved`, Gradle lockfiles or a version catalog). Install from the lockfile in CI (`npm ci`, `--frozen-lockfile`). Check that the lockfile diff contains only what you intended, with no surprise transitive additions.
- **Run the ecosystem's audit tool** (`npm audit`, `pip-audit`, `cargo audit`, OSV-Scanner, Dependabot alerts) and resolve high and critical findings before reporting.

---

## 12. Logging and observability without PII

- **Use structured logging** (key-value or JSON) with levels: `error` for failures needing attention, `warn` for degraded but handled conditions, `info` for significant lifecycle events (migration started or finished, sync completed with counts), and `debug` for development detail (off in release builds).
- **Log events, not data.** Log what happened and to which entity by opaque ID: `sync.push.failed op=0193… entity=shift attempt=3 code=timeout`. Do not log the shift's contents.
- **Never log:** passwords, tokens, API keys, session IDs, connection strings, keys, payment or health data, government IDs, precise location, user-authored content, or full request and response bodies. Emails, names, and phone numbers are personal data too: omit them, or pseudonymise with a salted hash if correlation is truly needed. Keep secrets out of source as well.
- **Redact by construction.** Wrap sensitive values in types whose string or debug representation is `[redacted]`, so accidental interpolation is safe. Add a test that logs a sample domain object and asserts that no sensitive field appears.
- **Make logs useful for diagnosis:** a correlation ID per user action or sync run, app and schema versions, and durations for slow operations.
- **Logging must never throw, block the main thread, or grow without bound.** Cap local log files.

---

## 13. Public API and README

The UI builder and future maintainers consume your work through its public API. Design it for them.

**API design**
- Name things in the CONTRACT's domain language, consistently. If the CONTRACT says `Shift`, the API says `Shift`, not `WorkBlock`.
- Keep the surface small and task-oriented: `createShift(draft) async -> Result<Shift, ShiftError>`, `observeShifts(week:) -> AsyncStream<[Shift]>`, `syncStatus() -> SyncStatus`.
- Expose observation (streams, flows, observables, signals) for data the UI displays, so screens update when sync lands without polling.
- Return domain types and typed errors, never raw rows, HTTP responses, or untyped maps. Enforce authorisation here (`PermissionDenied`), not only by hiding UI.
- Document thread and actor expectations, cancellation behaviour, and whether a call touches the network.
- Version the API surface. Breaking changes follow expand, migrate, contract and are called out in the changelog.

**README "API" section.** Required, and kept in sync with the code:
- A one-paragraph overview of what the core owns: data, persistence, sync, and validation.
- Each public type and function: signature, purpose, parameters, return value, errors it can produce and what each means for the caller, and threading or async notes.
- A short, runnable usage example for the main flows: create, read or observe, update, delete, and handling a conflict or validation error.
- The sync and conflict strategy per entity, in a table.
- The schema version, migration policy, and how to add a migration.
- Performance budgets and how to run the benchmarks.
- Dependencies and why each exists.
- How to run tests, including property and migration tests.

Doc comments on public symbols should match the README, and examples should compile (doctests where supported).

---

## 14. Self-review checklist (run before reporting done)

**Contract and design**
- [ ] Every CONTRACT entity, field, enum, and invariant maps to a type or a constructor check. Ambiguities were raised, not guessed.
- [ ] Illegal states are unrepresentable where practical. IDs are typed, money is integer minor units, and times are UTC instants with a zone where needed.
- [ ] Business logic lives in small pure functions, and I/O, clock, and IDs are injected.
- [ ] The public surface is minimal and named in domain language.

**Errors**
- [ ] No empty catches, no discarded errors, and no "log and continue" without a written reason.
- [ ] Errors are typed by what the caller can do, carry context and cause, and contain no PII or secrets.
- [ ] Batch operations report per-item results, and every resource is released on error paths.

**Data safety**
- [ ] Multi-step writes are transactional, and the schema enforces constraints and foreign keys.
- [ ] Every migration is versioned, transactional, and append-only, backs up before destructive steps, and is tested from every released version with fixtures.
- [ ] Unknown and missing fields are tolerated, and the downgrade behaviour is explicit.

**Sync and concurrency**
- [ ] Writes are local-first with an outbox, mutations are idempotent with operation IDs, and sync state is exposed per record.
- [ ] A conflict strategy is chosen and documented per entity, delete-versus-edit is tested, and ordering does not depend on device wall clocks.
- [ ] Convergence is tested. Mutable state has one owner, and nothing blocks the main thread.
- [ ] Cancellation and timeouts are handled, and the race and concurrency checkers are on and clean.

**Tests and performance**
- [ ] Tests cover the happy path, every documented error, boundaries, invariants, migrations, and conflicts.
- [ ] I broke the code on purpose and saw the key tests fail. There are no tautological or flaky tests.
- [ ] Property tests cover round-trips, migrations, merge laws, and parser robustness where relevant.
- [ ] Performance budgets are encoded as tests or benchmarks against realistic volumes, and they pass.

**Dependencies and logging**
- [ ] Every new dependency was verified in its official registry (exact name, publisher, maintenance, licence) and its API checked against the installed version.
- [ ] The lockfile is committed and its diff reviewed, and the audit tool is clean for high and critical findings.
- [ ] Logs are structured, use opaque IDs, and contain no secrets or PII. A redaction test exists.

**Docs**
- [ ] The README API section documents every public symbol, its errors, threading notes, examples, the sync strategy table, the migration policy, budgets, dependencies, and how to run the tests.
- [ ] Doc comments match the README, and examples compile.

---

## Sources

- Google Engineering Practices, What to look for in a code review: https://google.github.io/eng-practices/review/reviewer/looking-for.html
- Microsoft Engineering Fundamentals Playbook: https://microsoft.github.io/code-with-engineering-playbook/
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OWASP Input Validation Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- OWASP SQL Injection Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- Ink & Switch, Local-first software: https://inkandswitch.com/local-first/
- Martin Fowler / Danilo Sato, Parallel Change (expand and contract): https://martinfowler.com/bliki/ParallelChange.html
- Thoughtworks Technology Radar, API expand-contract: https://www.thoughtworks.com/radar/techniques/api-expand-contract
- Alexis King, Parse, don't validate: https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
- Hypothesis (property-based testing): https://hypothesis.readthedocs.io/
- SQLite, Write-Ahead Logging: https://www.sqlite.org/wal.html
- Cloud Security Alliance, Slopsquatting research note: https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-slopsquatting-ai-coding-assistant-supply-c/
- FOSSA, Slopsquatting and AI hallucinations: https://fossa.com/blog/slopsquatting-ai-hallucinations-new-software-supply-chain-risk/
- awesome-cursorrules: https://github.com/PatrickJS/awesome-cursorrules
