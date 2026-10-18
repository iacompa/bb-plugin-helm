---
name: helm-automation
description: Automation craft (jobs, workflows, bots, pipelines, webhooks, CLIs, BB automations; idempotent, retried, observable). Use when you are a Helm Core builder on automation.
---

# Helm Automation Craft

An excellent automation does the same correct thing whether it runs once, twice, late, after a crash or after a week offline. It never sends a message twice, charges twice or deletes the wrong thing; it says loudly when it fails and also when it silently stops running; and someone who has never seen it can pause, replay and re-key it from the runbook. `helm-specialist` covers how you work inside Helm.

Automations act on the outside world with nobody watching. Every rule below exists because an unattended job did something at 3 a.m. that no one could undo. Optimise for safety of effects first, then recoverability, then speed.

---

## 1. Pin down the trigger and the contract first

Before code, write the job's contract in SPEC.md (through the lead if SPEC is not yours) and the data shapes in CONTRACT.md:

- **Trigger:** one of schedule (cron expression **and timezone**), webhook (sender, signature scheme, event types), queue or stream (broker, topic, delivery guarantee), file drop (location, naming, completion signal), or manual/CLI (command and flags). Name the exact source; "runs periodically" is not a trigger.
- **Inputs and outputs:** what it reads, what it writes, and the shape of each.
- **Side effects:** every external action (message sent, record created, payment made, file deleted, email delivered), with who receives it and whether it can be undone.
- **Timing:** expected duration, deadline (data must land by 07:00 local), and what happens if a run is still going when the next one is due (skip, queue or run in parallel; the default is **skip and alert**).
- **Missed runs:** after downtime, does it catch up every missed window, run once for the latest, or skip? Backfills of past windows must be possible on demand.
- **Delivery guarantee:** assume **at-least-once** for every trigger. Webhooks are redelivered, queues redeliver after a visibility timeout, cron fires twice across DST changes or after a host restart, and humans re-run commands. Exactly-once *delivery* is not available; exactly-once *effects* are your job (section 3).
- **Volume:** items per run now and in a year, and the third-party quotas that bound it.

If the SPEC leaves any of these open, ask the lead (`helm_message` kind `ask`), pick the safest interpretation meanwhile, and record it.

---

## 2. Shape: plan, then apply

- **Separate deciding from doing.** A pure function takes inputs plus current state and returns a **plan**: a list of intended effects (`SendMessage{to, templateId, key}`, `Upsert{table, id, fields}`, `Delete{id}`). A thin executor applies the plan. This gives you dry-run for free, makes the logic unit-testable without fakes, and lets you log exactly what will happen before it does.
- **Inject the clock, ID source, HTTP client, storage and secrets.** Tests control time and responses; production wires real ones in one place.
- **One run, one ID.** Generate a `run_id` at start, put it in every log line and every record the run writes, and use it to link outputs back to runs.
- **Small steps with explicit state.** Long workflows become a sequence of named steps whose completion is recorded (section 5), not one function that must succeed end to end.
- **Fail fast at startup.** Validate configuration, required secrets (present, not their values) and reachability of dependencies before doing any work. A job that discovers a missing key after sending half the batch is a bug.
- **Exit codes mean something:** 0 success, non-zero failure, a distinct code for "partial success, see report". Schedulers and CI depend on it.

---

## 3. Idempotency and exactly-once effects

Every effect must be safe to repeat. Achieve it with one or more of:

- **Natural idempotency.** Prefer `PUT`/upsert by a stable key over `POST`/insert; set state ("status = sent") rather than increment ("count += 1").
- **Idempotency keys derived from the input**, never random per attempt: `sha256(job_name + window_start + recipient_id + template_id)` or the source event ID. The same logical action always produces the same key, across retries, restarts and replays.
- **Provider idempotency.** When the API supports it (Stripe's `Idempotency-Key` header, client tokens, deduplication IDs on FIFO queues), pass your key. Read the provider's docs for the key's lifetime; outside it you still need your own store.
- **Dedupe store.** Before an effect, insert the key into a table with a **unique constraint** (or a conditional write); if the insert conflicts, the effect already happened or is in progress, so skip it. Record outcome and timestamp. Keep keys at least as long as the longest redelivery or replay window.
- **Order of operations.** Record intent, perform the effect with the key, then record completion. If the process dies between the effect and the completion record, the retry hits the provider's idempotency check or your "in progress" row and reconciles instead of repeating. Where an effect has no idempotency support (most email and chat APIs), accept the small window, keep it as narrow as possible, and document it.
- **Transactional outbox** when an effect must follow a database change: write the change and an outbox row in one transaction; a separate step delivers outbox rows idempotently.
- **Webhook receivers:** verify the signature over the raw body with a constant-time comparison, reject stale timestamps (replay protection), dedupe on the sender's event ID, enqueue, and return 2xx quickly. Do the work asynchronously; senders time out and retry slow handlers, causing duplicates.
- **Test it:** run the same input twice and assert the second run produces no new effects (section 13).

---

## 4. Failures: timeouts, retries, dead letters

- **Every network call has a timeout** (connect and total). Libraries often default to none, which turns a slow dependency into a hung job.
- **Retry only what can succeed on retry:** connection errors, timeouts, 408, 429, 500, 502, 503, 504. Do not retry 400, 401, 403, 404, 409 or 422; they need a code or data fix. A 401 may justify one token refresh, then fail.
- **Exponential backoff with jitter.** `sleep = random(0, min(cap, base * 2^attempt))` ("full jitter"), with a cap (for example 30-60 s) and a maximum attempt count or total deadline. Without jitter, many clients retry in lockstep and knock the dependency over again.
- **Honour `Retry-After`** (seconds or HTTP date) on 429 and 503, and provider rate-limit headers, over your own backoff.
- **Retries only around idempotent operations,** or operations carrying an idempotency key. Retrying a non-idempotent `POST` without a key is how duplicates happen.
- **Retry at one layer.** If the SDK retries, the queue redelivers and your code also loops, attempts multiply. Know which layer owns retries and turn the others off or down.
- **Circuit breaker** for a dependency that is down: after N consecutive failures stop calling it for a cool-off period, fail fast, and alert, rather than burning quota and time.
- **Dead-letter handling.** After the final attempt, move the item to a dead-letter queue or table with the payload (or a reference if it holds personal data), the error, attempt count, first and last attempt time, and `run_id`. Never drop it silently. The runbook explains how to inspect and replay it.
- **Poison messages.** An item that fails deterministically (malformed payload, unknown type) must not block the queue or crash the worker forever. Cap deliveries per message (most brokers support a max receive count), dead-letter it, and continue with the rest.
- **Per-item results in batches.** One bad record fails that record, not the batch, unless the SPEC requires all-or-nothing. The run summary reports counts: succeeded, skipped (duplicate), failed, dead-lettered.

---

## 5. Long jobs: checkpoints, resumability, overlap

- **Checkpoint progress** after each batch: a cursor (last processed ID or timestamp plus a tiebreaker ID), page token or completed step name, stored durably with the run record. On restart, resume from the checkpoint, not from the beginning.
- **Cursor on stable keys.** Paginate by `(updated_at, id) > (last_ts, last_id)` or the API's cursor token; offset pagination skips or repeats rows when data changes underneath.
- **Process in bounded batches** sized to stay inside memory, API limits and the platform's maximum run time (serverless functions and CI jobs have hard time limits).
- **Prevent overlapping runs** with a lease: a lock row or key with an owner and an expiry that the run renews while alive. A crashed run's lease expires so the next run can take over. A local file lock is enough only for a single host.
- **Graceful shutdown:** handle SIGTERM/SIGINT by finishing or abandoning the current item cleanly, writing the checkpoint and exiting non-zero. Containers, systemd and CI send SIGTERM before killing.
- **Backfill and replay** use the same code path as normal runs with an explicit window (`--from`, `--to`) and the same idempotency keys, so a replay over already-processed data is a no-op.
- **ETL specifics:** load into a staging table then swap or merge in a transaction; make transforms deterministic; record row counts in and out per step and fail if they differ beyond a declared tolerance; keep raw extracts long enough to rerun transforms.

---

## 6. Third-party APIs, rate limits and scraping

- **Read the provider's official docs** for rate limits, quotas, pagination, webhook retries and API versioning. Do not invent endpoints or fields; Slop Hunter rejects invented APIs. If a doc page is not available offline, mark the behaviour "unverified" and design defensively.
- **Client-side rate limiting.** A token bucket or concurrency limit set below the documented limit, shared across workers of the same job. Read remaining-quota headers when the API sends them and slow down before you hit zero.
- **Quotas and cost.** Estimate calls per run and per month against the plan's quota. If the job needs a paid tier or will incur usage charges, that is `helm_need` with `about: spending`.
- **Pin API versions** where the provider supports it (version header or URL), and record the version in CONTRACT.md or ARCHITECTURE.md.
- **Respect terms of service.** If the ToS forbids automated access or the use you intend, stop and raise it with the lead; do not build it.
- **Scraping rules:**
  - Prefer an official API, feed or export over scraping.
  - Fetch and obey `robots.txt` (RFC 9309) for the user agent you send; honour crawl-delay where given; send an honest, identifying `User-Agent` with a contact URL.
  - Rate-limit conservatively (start around one request per second per host or slower), cache responses, use conditional requests (`If-None-Match`, `If-Modified-Since`), and back off on 429 and 5xx.
  - **No evasion:** do not solve or bypass CAPTCHAs, rotate IPs or user agents to dodge blocks, spoof browsers to get around bot protection, ignore `robots.txt`, or log in to access content the site does not offer to automated clients. If the site blocks you, report `blocked` with the reason.
  - Scraping personal data raises privacy law questions: `helm_need` with `about: privacy` before collecting it.
  - If `plugin:browser-automation` is in the project's tools and a site needs a real browser, the same rules apply.

---

## 7. Credentials and permissions

- **Never in code, config files in git, logs, fixtures or reports.** Read secrets from environment variables, a secret manager (cloud secret stores, CI secrets, Docker/Kubernetes secrets) or the OS keychain for local tools (macOS Keychain, Windows Credential Manager, Secret Service on Linux; for example `security find-generic-password -s <service> -w` on macOS).
- **Commit a `.env.example`** with every variable name, a placeholder value and a one-line description; make sure `.env` is in `.gitignore`. Run `helm_slop_scan` before reporting; S6 secrets are zero-tolerance.
- **Obtaining real keys is human-only.** Creating API keys, OAuth client IDs and secrets, bot tokens, webhook signing secrets, app approvals or verification reviews (many OAuth providers review apps that request sensitive scopes) all go through one `helm_need` with `about: credentials` (or `access`), listing each credential, the exact scopes, the account type (sandbox or production) and where it will be stored. Keep building against fakes and env placeholders while you wait.
- **Least privilege:** request the narrowest scopes that satisfy the SPEC (read-only where possible; one channel, not the whole workspace; one bucket prefix, not the account). List the scopes and the reason for each in ARCHITECTURE.md or the runbook.
- **Separate credentials per environment.** Test keys in development and CI; production keys only in the production runtime. Code refuses to run destructive or sending paths with production credentials when `ENV` is not production.
- **OAuth tokens:** store refresh tokens encrypted, refresh before expiry, handle revoked grants by stopping and alerting (not by looping), and never log tokens or authorization codes.
- **Rotation:** design so a key can be replaced without a deploy (re-read from the secret store, or support two active keys during rotation), and document the steps in the runbook.

---

## 8. Side effects: dry run, sandbox first, confirmation

- **`--dry-run` is mandatory** for any job with external effects. It runs the full pipeline, reads real inputs (where permitted), computes the plan and prints or writes it (counts plus a sample of planned effects), and performs **no** writes, sends, charges or deletes. A test asserts that dry run calls no effectful client method.
- **Sandbox or test account first.** Use provider test modes (payment test keys, sandbox workspaces, test channels, a dedicated test mailbox) for development, CI and the first end-to-end run. Evidence for "done" comes from these runs.
- **Explicit confirmation for dangerous effects.** Sending messages to real people, moving money, deleting or overwriting data, and posting publicly require one of: an interactive confirmation showing the plan summary, a `--confirm` flag plus an expected-count check (`--expect-count 42` aborts if the plan differs), or a human approval step in the workflow. Turning these on against real recipients or real money is the human's call: `helm_need` with `about: spending`, `privacy` or `access` as fits.
- **Blast-radius limits.** A per-run maximum (messages, deletions, amount) that aborts the run when exceeded; a recipient allowlist outside production; a kill switch (config flag or env var) that makes the job exit immediately without effects.
- **Prefer reversible operations:** soft delete with a retention window, archive before delete, drafts before sends, small canary batches before the full run.
- **Messages and bots:** template content with real variables, never placeholder text; respect platform rules (opt-outs and unsubscribe for email, bot permissions and intents for chat platforms); avoid @everyone-style mass mentions unless the SPEC requires them.

---

## 9. Configuration as data

- **Behaviour lives in a validated config file or environment,** not in code edits: schedules, windows, recipients, thresholds, feature flags, batch sizes, per-run limits.
- **Validate at startup against a schema** (JSON Schema, a typed settings class, or the language's equivalent) and fail with a precise message naming the field. Unknown keys are errors, so typos do not silently fall back to defaults.
- **Defaults are safe:** dry run on unless explicitly disabled in the environment that is allowed to send; small batches; low limits.
- **Config is versioned** in git (minus secrets) and its effective values are logged at start (with secrets redacted) so a run can be reproduced.
- **Environments** differ only in config and secrets, never in code paths, except the guards in section 7.

---

## 10. Observability

- **Structured logs** (JSON lines) with `run_id`, job name, step, item key (opaque ID), attempt, duration, outcome. No secrets, tokens, message bodies or personal data; log IDs and counts.
- **Run history** in durable storage: run ID, trigger, start and end time, status, counts (read, planned, applied, skipped, failed, dead-lettered), checkpoint, version or commit, config hash. A `status` or `history` command prints the last N runs.
- **Metrics** where the platform offers them: runs by status, duration, items processed, retries, dead-letter depth, third-party error rate and remaining quota.
- **Alert on failure** (non-zero exit, error rate over threshold, dead-letter growth) through the channel the SPEC names. Alerts say what failed, the run ID and the runbook section to read.
- **Alert on silence.** A job that stops running produces no errors. Use a **heartbeat / dead-man's switch**: each successful run pings a monitor or writes a timestamp, and something independent alerts when no ping arrives within the expected interval plus slack. Also alert when a run processes zero items for longer than is plausible.
- **Data freshness checks** for pipelines: the newest row's timestamp is recent enough; row counts are within expected bounds.
- Monitoring services and paging tools usually need accounts: `helm_need` for credentials or spending, with a local or log-based fallback meanwhile.

---

## 11. Packaging and running

Choose the runtime the SPEC and ARCHITECTURE.md name; if they do not, propose one to the lead with the trade-offs.

| Runtime | Good for | Watch out for |
|---|---|---|
| Container (Docker) on a scheduler | Portable, reproducible jobs and workers | Pin the base image, run as non-root, handle SIGTERM, no secrets baked into layers |
| Serverless function | Webhooks, short event handlers, light schedules | Hard execution time limits, cold starts, at-least-once invocation, statelessness |
| cron | Simple jobs on one host | Minimal environment (set PATH, use absolute paths), no missed-run catch-up, timezone is the host's or `CRON_TZ` where supported, capture output |
| systemd timer | Linux hosts | `Persistent=true` catches up missed runs; check expressions with `systemd-analyze calendar '<expr>'`; logs in `journalctl -u <unit>` |
| launchd | macOS agents and tools | `StartCalendarInterval` runs a missed job once on wake; validate the plist with `plutil -lint`; load with `launchctl bootstrap gui/$(id -u) <plist>` |
| GitHub Actions `schedule` | Repo-centric jobs, reports, syncs | Cron is UTC; runs can be delayed under load; shortest interval is 5 minutes; scheduled workflows in public repos are disabled after 60 days without repository activity; add `workflow_dispatch` for manual runs and `concurrency` to prevent overlap |
| BB `plugin:automations` | Scheduled agent or script runs inside BB, when listed in the project's tools | Follow BB's automations documentation for the exact commands; do not guess syntax |

- **Ship the definition, not the activation.** Commit the unit file, plist, workflow, function config or automation definition, plus install instructions in the runbook. Installing or enabling a live schedule on the human's machine, BB or cloud account is `helm_need` with `about: access` (or `spending` if it costs money). Never install it yourself on the human's system.
- **One command to run locally:** `make run`, `npm run job -- --dry-run`, or a CLI entry point, documented in the README and runbook.
- **Reproducible builds:** committed lockfile, pinned runtime version, pinned base images and GitHub Actions (by SHA, coordinate with Security if `.github/**` is theirs).

### CLI tools

- `--help` that lists every flag with defaults; `--version`.
- Data to stdout, diagnostics to stderr; `--json` for machine-readable output.
- Non-interactive by default when stdin is not a TTY; prompts only when it is, and every prompt has a flag equivalent.
- Meaningful exit codes; handle Ctrl-C cleanly.
- Config precedence documented: flags over env over config file over defaults.

---

## 12. Data handling

- Collect and keep only what the job needs; set retention for run history, dead letters, raw extracts and caches.
- Personal data in payloads, dead letters or caches is protected like the primary store; if the project also needs `privacy` or `hipaa`, coordinate with the Compliance agent through the lead.
- Using real private data (a real mailbox, CRM, customer list) during development is `helm_need` with `about: privacy`. Use synthetic data until approved.

---

## 13. Testing without the live world

No test makes a live call to a third-party service. Tests must pass offline and in CI with no secrets.

- **Fakes behind interfaces** for each external client: an in-memory fake that records calls and can be scripted to return errors, 429s with `Retry-After`, timeouts and malformed payloads.
- **Recorded fixtures** for realistic payloads: record once from a sandbox account (with the human's credentials, when provided), **scrub tokens, cookies, emails and IDs**, commit the cassette, and replay in tests (VCR-style libraries, HTTP mocking libraries, or a local mock server). Note the date and API version recorded.
- **Contract tests** that check your parsing against the provider's documented schema or sample payloads, and that your outbound requests match what the provider expects (method, path, headers, body shape). Re-record when the API version changes.
- **Time control.** Inject the clock or use the test framework's fake timers or time-freezing library. Test schedule calculations across DST transitions, month ends, leap days and timezone boundaries; test missed-run and catch-up behaviour; test backoff without real sleeping.
- **Behaviour tests that matter for automations:**
  - Run twice with the same input: no duplicate effects.
  - Crash after N items (inject a failure), restart: resumes from checkpoint, no duplicates, nothing skipped.
  - Retryable errors are retried with backoff and succeed; non-retryable errors fail fast; exhausted retries dead-letter the item.
  - A poison message is dead-lettered and the rest of the batch completes.
  - Dry run performs zero effects and reports the same plan the real run executes.
  - Per-run limit and kill switch abort before any effect.
  - Webhook: bad signature rejected, stale timestamp rejected, duplicate event ID ignored.
  - Invalid config fails at startup with the field named.
  - Logs contain no secrets (a redaction test feeds a known fake secret and asserts it never appears).
- **Run them through the wrapper:** `.helm/run-check.sh tests -- <test command>`.
- **End-to-end in a sandbox** once credentials exist: a dry run against real (permitted) inputs, then a real run against the sandbox account. Save both outputs as evidence.

---

## 14. The runbook

Write `docs/runbook.md` (or the path ARCHITECTURE.md sets; if `docs/**` is not in your scope, ask the lead whether you or the Docs builder writes it). It must let a stranger operate the job:

1. **What it does:** trigger, schedule with timezone, inputs, effects, owners of the downstream systems.
2. **How to run:** locally, dry run, real run, backfill a window, with exact commands.
3. **How to pause and resume:** kill switch, disabling the schedule, draining the queue.
4. **How to replay:** inspect dead letters, fix, replay one item or all, verify no duplicates.
5. **How to rotate credentials:** where each secret lives, the steps, how to verify, the scopes it needs.
6. **What each alert means** and the first three things to check.
7. **Known limits:** rate limits, quotas, the non-idempotent windows from section 3, maximum volume tested.
8. **Install and uninstall** of the schedule or deployment.

Every command in the runbook must have been run by you (in dry run or sandbox) or be marked "not yet verified: needs credentials".

---

## Done means

**Contract**
- [ ] SPEC states the trigger (with timezone), inputs, effects, overlap policy, missed-run policy and volume; CONTRACT has the data shapes.
- [ ] Logic is a pure plan step plus a thin executor; clock, IDs, clients and secrets are injected.

**Safety of effects**
- [ ] Every effect is idempotent via natural keys, provider idempotency keys or a dedupe store with a unique constraint; a run-twice test proves it.
- [ ] `--dry-run` exists and a test proves it performs no effects.
- [ ] Sends, payments, deletes and public posts need confirmation or approval, with per-run limits, a kill switch and non-production recipient allowlists.

**Failure handling**
- [ ] Every external call has a timeout; only retryable errors retry, with capped exponential backoff, jitter and `Retry-After`; retries live at one layer.
- [ ] Exhausted and poison items go to a dead-letter store with context; nothing is dropped silently.
- [ ] Long jobs checkpoint, resume after a crash without duplicates, prevent overlap with a lease, and shut down cleanly on SIGTERM.

**External services**
- [ ] Rate limits and quotas come from official docs and are enforced client-side; API versions pinned; ToS respected.
- [ ] Scrapers obey robots.txt, identify themselves, rate-limit and never evade protections.
- [ ] Credentials come from env, a secret store or the keychain; `.env.example` committed; scopes minimal and documented; real keys, OAuth approvals, paid tiers and real data requested through `helm_need`.

**Operations**
- [ ] Config is schema-validated at startup with safe defaults.
- [ ] Structured logs with `run_id`, run history, failure alerts and a heartbeat for silence; no secrets or personal data in logs.
- [ ] The schedule or deployment definition is committed; activation on the human's systems was requested, not done by you.
- [ ] Tests run offline with fakes and scrubbed fixtures, cover time, retries, resume, dedupe and webhooks, and pass via `.helm/run-check.sh`; `helm_slop_scan` is clean.
- [ ] The runbook covers run, pause, replay, rotate and alerts, with verified commands.

---

## Evidence to commit

Under `reports/automation/`:
- `dry-run-<date>.txt`: dry-run output showing the plan summary and zero effects.
- `sandbox-run-<date>.txt`: a real run against a test account, with counts and run ID (once credentials exist).
- `rerun-<date>.txt`: the same input run twice, showing no new effects on the second run.
- `resume-<date>.txt`: an injected crash and resumed run.
- Schedule validation output (for example `systemd-analyze calendar` or `plutil -lint`), where applicable.
- Test output via `.helm/run-check.sh` (`reports/checks/tests.txt`).

All of it uses synthetic or sandbox data, with secrets and personal data scrubbed. Cite these as `file` and `report` refs in `helm_report`, along with the runbook path.

---

## Sources

- AWS Builders' Library, Timeouts, retries, and backoff with jitter: https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- AWS Builders' Library, Making retries safe with idempotent APIs: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-apis/
- AWS Architecture Blog, Exponential backoff and jitter: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- Stripe, Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Stripe, Webhooks (signatures, retries, duplicate events): https://docs.stripe.com/webhooks
- Standard Webhooks specification: https://www.standardwebhooks.com/
- Enterprise Integration Patterns, Idempotent Receiver: https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html
- Enterprise Integration Patterns, Dead Letter Channel: https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html
- RFC 9309, Robots Exclusion Protocol: https://www.rfc-editor.org/rfc/rfc9309
- RFC 9110, HTTP Semantics (Retry-After, conditional requests): https://www.rfc-editor.org/rfc/rfc9110
- RFC 6585, Additional HTTP Status Codes (429): https://www.rfc-editor.org/rfc/rfc6585
- RFC 9700, OAuth 2.0 Security Best Current Practice: https://www.rfc-editor.org/rfc/rfc9700
- OWASP Secrets Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- The Twelve-Factor App, Config: https://12factor.net/config
- Google SRE Book, Monitoring Distributed Systems: https://sre.google/sre-book/monitoring-distributed-systems/
- GitHub Docs, Events that trigger workflows (schedule): https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule
- systemd.timer manual: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- Apple, Scheduling timed jobs with launchd: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html
- crontab(5) manual: https://man7.org/linux/man-pages/man5/crontab.5.html
- Slack, Rate limits: https://api.slack.com/apis/rate-limits
- Discord, Rate limits: https://discord.com/developers/docs/topics/rate-limits
- Pact contract testing documentation: https://docs.pact.io/
- VCR.py documentation: https://vcrpy.readthedocs.io/
- Command Line Interface Guidelines: https://clig.dev/
