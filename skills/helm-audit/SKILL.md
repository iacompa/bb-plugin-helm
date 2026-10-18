---
name: helm-audit
description: Craft method for auditing an existing app, website, game or automation in a Helm `review` project, covering scoping and pinning the commit, per-role audit method, reproducible evidence-backed findings, safe execution and compiling REVIEW.md. Use when you are a specialist or the App Lead in a Helm review project.
---

# Helm Audit Craft

An excellent audit tells the owner of an existing project what is wrong, how bad it is, how to see it for themselves, and what to fix first. Every claim can be checked by someone who was not there: a finding names a file and line at a pinned commit (or a URL and a screenshot), shows the command and saved output that prove it, and says plainly what is confirmed and what is only suspected. It never pads. `helm-specialist` covers how you work inside Helm as a specialist, and `helm-lead` covers how the lead runs stages, squads and checks. This skill covers the audit itself.

The deliverable is a report, not code. The project's source is the subject of the audit, and nobody changes it.

---

## 1. The rules of a review project

- **Source is read-only for everyone.** No edits, reformatting, dependency upgrades, lockfile regeneration, `--fix` flags or "quick fixes", not even a typo. If a tool rewrites a tracked file, `git restore <path>` and rerun it in a non-writing mode (`--check`, `--dry-run`).
- **Write scopes.** Specialists write only `reports/<role>/**` (platform specialists `reports/<platform>/**`). The lead writes `ACCEPTANCE.md` (the review plan), `DECISIONS.md`, `REVIEW.md` and `.helm/**`.
- **Work on the Helm branch, never the human's.** The run starts from a Helm branch created at the audited commit. Never touch the human's checkout or branches. Never push.
- **Why it matters for evidence.** Because no source file changes, a `path:line` at the audited sha is still the same line at the integration HEAD the gates judge. One stray edit breaks that. Before every commit, `git status --porcelain` must list nothing outside your reports folder.
- **Stages.** Spec (review plan) → Build (parallel audit) → Integrate (`REVIEW.md`, checks) → Reviewer (every claim backed by evidence) → Slop Hunter (no vague, unverifiable or padded findings) → Ready → human sign-off.
- **Failing checks are findings, not blockers.** Record a red build or test suite with its real exit code and report it. Never weaken a check.

---

## 2. Scoping and pinning (lead, Spec stage)

The review plan decides what the report can claim. Anything not in the plan is not audited, and the report must say so.

**Pin the audited commit.** Record the full 40-character sha: `git rev-parse HEAD` on the Helm branch before any report commit. Every finding, screenshot and tool run refers to this sha. Auditing a newer commit is a new plan version, recorded in `DECISIONS.md`.

**Write `ACCEPTANCE.md` as the review plan.** Under two pages, with these sections:

1. **Subject.** What it is, kind, platforms, repository, pinned sha; for a live site the exact in-scope URLs (staging preferred).
2. **In scope / out of scope.** Name components, paths, flows, platforms. Out-of-scope items reappear in REVIEW.md under "What was not checked".
3. **Audit criteria.** Numbered `AC-01` … one per area, each stating the standard and depth, how it is verified and the evidence path. Example: "AC-03 · Security: API against OWASP API Security Top 10 (2023), all ten items · evidence: `reports/security/api-top10.md`."
4. **Evidence standard.** What counts: a command plus its saved output file, a screenshot path, a quote of at most 3 lines at `path:line` at the pinned sha. Not memory, "looks like" or an unsaved tool score.
5. **Severity scale and effort scale** (section 6), so every role rates the same way.
6. **Environments and safety.** Where it runs, which test accounts are needed (via `helm_need`), what is forbidden (section 7).
7. **Time-box per role** (section 10).
8. **Checks.** The project's own commands that will be recorded (build, lint, tests, dependency audit), listed in `.helm/checks.json` or passed with `helm_existing_docs` for an existing repository.

**Record scope choices in `DECISIONS.md`** ("D-2 · chose staging over production: the brief forbids production traffic · lead"), so the gates see why something was not checked.

**Write one task per specialist** (template in `helm-lead`): the AC numbers it owns, its reports folder, the pinned sha, the time-box, the tools it should use, and what it must not run.

---

## 3. Audit method common to every role

**Map before you judge (first ~15% of your time-box).** Read the README, manifests, build and CI files, the tree and recent history (`git log --oneline -30`). Write `reports/<role>/map.md`: stack, entry points, main flows, where data lives, riskiest areas and why. Spend depth where the risk is.

**Work from a checklist, report from evidence.** Use the standard for your area (section 4) as a coverage list in `reports/<role>/checklist.md`: each item marked `pass`, `finding <id>`, `n/a (reason)` or `not checked (reason)`.

**Run the tools, save the output.** Send each tool's output to a file under your reports folder with the command, sha and exit code (use the check wrapper when the lead records the check):

```sh
AUDIT_SHA=<full pinned sha>
{ echo "\$ npm audit --json"; echo "# audited sha: $AUDIT_SHA"; npm audit --json; echo "# exit: $?"; } \
  > reports/security/npm-audit.json.txt 2>&1
```

A tool hit is a lead, not a finding: read the flagged code and confirm reachability first.

**Reproduce before reporting.** For behaviour: run it from a clean state, write the exact steps, see the defect twice, and capture it (screenshot, log, output file). For static defects: trace source to sink (where the input enters, what validates it, where it ends up) and quote each hop. If you cannot reproduce or trace it, it is `suspected` (section 5), not confirmed.

**Note what is solid,** with evidence: "All 41 SQL call sites are parameterised (`reports/core/sql-sites.txt`)." Unbacked praise is padding; the Slop Hunter rejects it.

**Report as you go.** Small commits; `helm_report` done with the sha and your findings and evidence paths.

---

## 4. How each role audits

Every role writes `reports/<role>/findings.md` (format in section 5), `checklist.md`, `map.md` and its evidence files. Roles a squad does not have are covered by the role named in the lead's plan (without a Compliance or Data specialist, Security and Core cover those areas).

### Core (code)

- **Correctness.** Trace each main flow from entry point to storage and back. Check boundaries: empty, one, many, maximum, zero, negative, Unicode, time zones and DST, money as floats, off-by-one and inverted conditions.
- **Error handling.** Search for swallowed errors: empty `catch`, `catch { return [] }`, `try?`, `_ = …`, unhandled promise rejections, `except: pass`, errors logged and ignored. For each, say what the user loses.
- **Data integrity.** Multi-step writes without transactions, half-written state on partial failure, non-atomic file writes, silent truncation.
- **Concurrency.** Shared mutable state without isolation, races between stale and fresh responses, missing cancellation, duplicate submits, work on the UI thread.
- **Dependencies.** Lockfile committed, unused or abandoned packages, major versions far behind (`npm outdated`, `pip list --outdated`, read-only).
- **Maintainability** only when it causes defects: dead code on shipped paths, duplicated logic that has drifted.

### UI

- **Usability.** Walk each main flow against Nielsen's heuristics. Report a violation only with the screen, step and what the user gets wrong.
- **States.** For every screen in scope: default, loading, empty, error, offline, permission-denied, long content, first run, signed out. Trigger each deliberately. Keep the matrix in `reports/ui/state-matrix.md` with a screenshot path per cell or `not reached (why)`.
- **Accessibility, WCAG 2.2 AA.** Run automated checks (`npx @axe-core/cli <url> --save reports/ui/axe-<page>.json`; Lighthouse accessibility category), then manual checks automation cannot do: keyboard-only navigation, visible and unobscured focus (2.4.7, 2.4.11), focus order, screen reader labels on icon-only controls, contrast of text and control boundaries, target size (2.5.8: 24×24 CSS px minimum; 44 pt iOS and 48 dp Android platform norms), text resize to 200%, reduced motion, dragging alternatives (2.5.7), accessible authentication (3.3.8). Cite the success criterion in each finding. An automated pass is not conformance; say which criteria were checked by hand.
- **Copy.** Buttons that do not say what they do, errors that do not say what to do next, placeholder or lorem text, copy that promises behaviour the code lacks (quote both).
- **Consistency.** One-off colours, spacing and components for the same action. Usually minor.

### Platform (ios, and, mac, win, web)

- **Build and run it.** Follow the README exactly, from a clean clone of the pinned sha. Record every command and its output. A README that does not produce a running build is a finding. A platform this machine cannot build goes under not checked; do not guess.
- **Screenshots** of the main flows: `xcrun simctl io booted screenshot reports/ios/<name>.png`, `adb exec-out screencap -p > reports/and/<name>.png`, or `plugin:browser-automation` for web pages.
- **Store and platform guideline risks.** Check against the current Apple App Review Guidelines and Google Play Developer Program Policies: privacy manifest (iOS), data safety form (Android), account deletion, in-app purchase rules for digital goods, justified background modes and foreground services, target SDK levels. Quote the guideline section.
- **Permissions.** List every declared permission and entitlement (`Info.plist`, `AndroidManifest.xml`, entitlements, `package.appxmanifest`, web permission prompts): is it used and needed, is the usage string true, does the app degrade gracefully when denied.
- **Lifecycle.** Backgrounding, relaunch after kill, rotation, low memory, deep links, offline start. Games: frame time on the reference device, input latency, save/resume, pause on focus loss. Automations: schedule correctness, idempotency on retry, behaviour on partial failure, alerting when a run fails.

### Security

- **Pick the standard by surface.** OWASP ASVS (current version) for web apps and backends, at the level the plan names (L1 by default, L2 when the app handles sensitive data or money). OWASP MASVS for mobile apps, with MASTG test cases as the method. OWASP API Security Top 10 (2023) for any HTTP API. Record per-item status in `reports/security/checklist.md`.
- **Secrets.** Scan the tree and the full history, with output redacted: `gitleaks detect --source . --redact --report-format json --report-path reports/security/gitleaks.json`. A secret removed in a later commit is still leaked. Never write a secret value: give path, line, type and a fingerprint (first 4 characters and length). A live production secret is a blocker; tell the lead at once so the human can rotate it. Never test whether a found key works.
- **Dependencies.** Run the ecosystem's audit tool against the lockfile, read-only: `npm audit --json`, `pnpm audit --json`, `pip-audit -r requirements.txt -f json`, `cargo audit --json`, `govulncheck ./...`, `bundle exec bundle-audit check`, or `osv-scanner scan source -r .` across ecosystems. Never run `npm audit fix` or anything that rewrites the lockfile. Rate each high or critical advisory on reachability and whether the package ships at runtime, not on its score alone.
- **Static analysis** where useful: `semgrep scan --config auto --json -o reports/security/semgrep.json`. Triage every hit; untriaged tool output is not a finding.
- **Manual review** where untrusted input crosses a trust boundary: authentication and session handling, object-level and function-level authorisation enforced on the server (IDOR), input validation and injection (SQL, shell, template, path traversal), SSRF, file upload, CORS and CSRF, security headers (passively observable on the live URL), token storage on clients (keychain/keystore, not plain preferences), TLS and certificate checks, logging of PII or tokens, webhook signature verification, rate limiting on login and costly endpoints.
- **Active testing only against a local or staging instance the plan names.** No scanners, fuzzers or brute force against production or any third-party host.

### Compliance (HIPAA, privacy)

- **Data inventory first.** Each kind of personal or health data: where collected, stored, sent (hosts, SDKs, analytics), how long kept, who can read it. Save it as `reports/compliance/data-inventory.md`.
- **HIPAA** (when the project handles PHI for a covered entity or business associate): map Security Rule technical safeguards to the code and configuration: access control and unique user IDs, audit controls, integrity, transmission security, encryption at rest, automatic logoff, PHI kept out of logs, push payloads, analytics and crash reports, vendors receiving PHI ("BAA status unknown: confirm with the human"). Report technical gaps; never declare the project compliant or non-compliant.
- **Privacy** (GDPR, CCPA/CPRA and similar, as the plan names): lawful basis or consent before non-essential tracking, cookie banner that actually blocks scripts until consent (verify in the network log), data export and deletion paths, retention, privacy policy that matches what the code collects (quote both), store privacy labels that match the data inventory.
- Report gaps as findings with the regulation section cited. Legal interpretation beyond the text is `suspected`, with "confirm with counsel" as the confirmation step.

### Data

- **Schema.** Constraints, foreign keys, indexes on queried columns, nullable fields that should not be, money and time types, enum drift between code and database.
- **Migrations.** Ordered, versioned, reversible or explicitly irreversible, safe on a populated table (long locks, full rewrites, dropping columns still read by the running version). Run them only against a disposable local database created for the audit, never an existing one.
- **Backups and recovery.** Is there a documented backup, is restore ever tested, what is the retention, are backups encrypted. Absence is a finding ("no backup procedure found") with the paths searched.
- **Data access.** N+1 and unbounded queries, missing pagination, string-built queries.

### Test

- **Run the existing tests** exactly as the README or CI says, through the check wrapper if the lead records them. Save output under `reports/tests/`. Report pass, fail, skip and flaky counts (run twice; a test whose outcome changes is flaky).
- **Coverage of risky paths, not a percentage.** Generate coverage where the stack supports it (`npx jest --coverage`, `pytest --cov`, `go test -cover ./...`) with output directed into `reports/tests/`, then list the risky paths (auth, payments, data writes, migrations, sync, error handling) and say for each whether a test exercises it and could fail.
- **Test quality.** Empty or tautological assertions, mocks of the unit under test, skipped tests, sleeps as synchronisation, tests that depend on the network or wall-clock time. Quote them.
- Do not add or fix tests. A missing test is a finding with a recommendation.

### Docs

- **README truthfulness.** Follow every setup and run step from a clean clone at the pinned sha. Each failing, missing or stale step is a finding with command and output.
- **Claims.** Features, supported platforms, security or privacy statements, performance numbers and badges in docs: check each against the code. Quote the claim and the contradicting code or output.
- **Gaps.** No architecture overview, environment variable list or release process. Rate by what a new maintainer loses.

---

## 5. Writing a finding

One defect per finding. The same root cause in five places is one finding with the other locations listed. Use this exact block in `reports/<role>/findings.md`:

```markdown
### SEC-004 · Password reset token never expires
- **Severity:** major · **Confidence:** confirmed · **Category:** Security / ASVS authentication chapter
- **Location:** `api/src/auth/reset.ts:42` at `a1b2c3d…` (also `api/src/auth/tokens.ts:17`)
- **Evidence:**
  - Quote (`api/src/auth/reset.ts:41-42`):
    `const token = randomBytes(32).toString("hex");`
    `await db.resetTokens.insert({ userId, token });`
  - Command: `git grep -n "resetTokens" a1b2c3d -- api/` → `reports/security/reset-token-sites.txt`
  - Repro: requested a reset on the local instance, used the link 26 h later, password changed → `reports/security/reset-replay.txt`
- **Impact:** a reset link leaked through email forwarding or logs stays valid indefinitely; anyone holding it can take over the account.
- **Recommendation:** store an expiry (for example 30–60 minutes) with the token, reject expired or used tokens, invalidate on use (ASVS credential recovery requirements).
- **Effort:** S
```

Field rules:

- **ID.** Role prefix plus a number, stable for the life of the review: `CORE-`, `UI-`, `IOS-`, `AND-`, `MAC-`, `WIN-`, `WEB-`, `SEC-`, `COMP-`, `DATA-`, `TEST-`, `DOCS-`. Never renumber; a withdrawn finding keeps its ID, marked withdrawn with the reason.
- **Severity** from section 6. **Confidence:** `confirmed` (reproduced or traced at a quoted line) or `suspected`.
- **Category:** area plus the standard item where one applies (ASVS chapter, MASVS control, API Top 10 item, WCAG success criterion, store guideline section, HIPAA safeguard citation, CWE ID).
- **Location:** `path:line` at the pinned sha, copied with `git show <sha>:<path> | sed -n '<start>,<end>p'`. For a running app or site: the URL or screen name plus the screenshot path. Unlocatable findings fail the Reviewer gate.
- **Evidence:** at least one of: a command with its saved output file, a screenshot path, a quote of at most 3 lines copied exactly. Point at files; never paste long output.
- **Impact:** who is affected, what they lose, how likely on a main path.
- **Recommendation:** the target behaviour and where it belongs, naming the platform control or standard requirement.
- **Effort:** `S` (under half a day), `M` (half a day to 2 days), `L` (more than 2 days or needs design work). Add "needs decision" when the fix depends on a product or legal choice.

**Suspected findings.** No speculation reported as fact. When you cannot confirm (no credentials, platform not buildable, production-only configuration), write `Confidence: suspected` and add a line **To confirm:** with the exact step that would settle it ("run the reset flow against staging with a test account; requires credentials, requested via helm_need N-12"). A suspected finding is never rated blocker on its own; rate it by what it would be if confirmed and say so: "major if confirmed".

**Absence claims need the search.** "No input validation anywhere" needs the command and its output; otherwise write "none found in `<paths>` by `<command>`".

**Words to avoid** because they make a finding unverifiable: "may", "might", "potentially", "appears to", "various", "some places", "several issues", "best practice" with no reference, "consider". State what you saw.

---

## 6. Severity and effort

Severity is what the owner loses times how likely it is on a main path.

| Severity | Definition | Examples |
|---|---|---|
| **blocker** | Fix before the next release or continued use: exploitable security hole, data loss or corruption, crash on a main flow, regulatory exposure with real data, certain store rejection. | Live secret in history; IDOR exposing other users' records; PHI sent to an analytics SDK; crash on launch. |
| **major** | Fix soon: main flow broken or unreliable, missing error/offline state on a main screen, likely store rejection, WCAG 2.2 A/AA failure on a main flow, failing test suite, no backups. | Blank checkout offline; login button with no accessible name; reset tokens never expire. |
| **minor** | Real but limited: secondary screen, unlikely sequence, easy workaround, hardening gap with no direct exploit. | Settings toggle not persisted; missing header with no reachable impact. |
| **nit** | Polish with no functional effect. Keep at most 10 in the whole report. | Inconsistent spacing on one screen; misleading variable name. |

Calibration rules:
- Reachability decides. A critical advisory in a build-only dependency that never ships is minor. The same advisory in a request handler that receives user input is blocker or major.
- The same defect on onboarding, checkout or the primary flow rates one level higher than on a secondary screen.
- Style preferences and alternative designs you would have chosen are not findings.
- When torn between two levels, choose the one you can defend from the evidence.

---

## 7. Running the app safely

- **Never against production data.** Run locally or against the staging environment the plan names. If a flow can only be exercised in production, list it under not checked.
- **No live payment or email endpoints.** Use the provider's test mode (for example Stripe test keys and cards) and a local mail sink. If the config points at live keys, do not run that flow.
- **Test accounts only, credentials only through `helm_need`.** Ask once with `about: "credentials"` (which account, environment, why) and keep auditing meanwhile. Never take credentials from the human's machine, shell history, other projects or keychains, and never commit them. Use real private data only if the human approves it through `helm_need` with `about: "privacy"`.
- **No destructive commands.** No `DROP`, `TRUNCATE`, migrations or seed scripts against an existing database, no `rm -rf` outside a temp directory you created, no `git clean`, `git reset --hard`, force-push or history rewrite, no deletion of cloud resources, no `--fix` or `audit fix`. Use disposable databases and containers; remove only what you created.
- **No load on hosts you do not own.** No load tests, fuzzers, active scanners or brute force against production or third-party services. Passive checks on in-scope URLs (fetching pages, reading headers, a Lighthouse run) are fine at human pace.
- **Spending** (paid scanner tier, device farm, store account) needs `helm_need` with `about: "spending"`. Default to free, local tools.
- **Contain side effects.** Output goes to `reports/<role>/` or a temp directory. Installs (`npm ci`, a virtualenv) are fine if they touch only ignored paths; check `git status --porcelain` and restore anything tracked.

---

## 8. Evidence that holds up

The Reviewer checks every claim in `REVIEW.md` against real evidence; the Slop Hunter rejects what it cannot verify.

- **Every tool output saved** under `reports/<role>/` with the command, the sha and the exit code: lint, audit, test, coverage, axe, Lighthouse, gitleaks (redacted), semgrep, build logs.
- **Screenshots** named for what they show: `reports/ui/checkout-offline-iphone-se.png`, not `screenshot1.png`. One state per image. Reference each from a finding or the state matrix.
- **Quotes** copied from the pinned sha, at most 3 lines, with the line range. Re-check each before committing.
- **Numbers** come from saved output ("212 tests, 9 failing, `reports/tests/run-1.txt`"), never "most tests pass".
- **Lighthouse and axe:** `npx lighthouse <url> --output=json --output=html --output-path=reports/web/lh-home --chrome-flags="--headless"`. Report failing audits, not just the score; scores vary, so state the run count.
- **Commit it.** Evidence that is not committed in your reports folder does not exist for the gates.

---

## 9. Compiling REVIEW.md (lead, Integrate stage)

### Merge, deduplicate, group

1. Merge each specialist's verified commit into the integration branch. A conflict means someone wrote outside scope; reject that commit.
2. **Deduplicate.** The same defect reported by two roles becomes one finding under the ID with the stronger evidence, noting "also reported as CORE-007" and keeping both evidence references.
3. **Group by root cause.** When several findings share one cause (no central error handling, no server-side authorisation layer), add `RC-1` listing those findings and one recommendation that fixes the cause.
4. **Re-rate for consistency** across roles using section 6. If you change a specialist's severity, record why in `DECISIONS.md`.
5. **Spot-check.** Re-open a sample of quotes and evidence files yourself, including every blocker. Anything that does not hold goes back to the specialist with `helm_message`.

### Record the checks

Run each check in the plan through the wrapper on the final integration HEAD and record it with `helm_record_check` using the exit code the trailer shows. A failing build, red tests or audit findings are recorded honestly and appear as findings with the output file as evidence. Never edit a check command to turn it green, and never edit source to make it pass.

### REVIEW.md structure

```markdown
# Review: <project> at <short sha>

Audited commit: <full sha> · Dates: <start>–<end> · Plan: ACCEPTANCE.md · Team: <roles>

## 1. Summary verdict
<3–6 sentences: overall state, the decision the owner faces ("not ready to ship: 3 blockers"),
the top risks in one line each, what is solid.>

## 2. Scorecard
| Area | Rating | Blocker | Major | Minor | Nit | Basis |
|---|---|---|---|---|---|---|
| Security | Red | 2 | 3 | 4 | 0 | ASVS L1, API Top 10; reports/security/checklist.md |

## 3. Top risks
<At most 5, each: the risk in plain words, the finding IDs, the business impact.>

## 4. Strengths
<What is solid, each with evidence.>

## 5. Remediation plan
<Now, Next, Later phases (rules below) with finding IDs, effort and dependencies.>

## 6. Findings table
| ID | Severity | Conf. | Area | Title | Location | Effort |

## 7. Root causes
<RC-n entries.>

## 8. Detailed findings
<Every finding block, grouped by severity then area, as in section 5.>

## 9. What was not checked, and why
<Out-of-scope items from the plan; in-scope items not reached (time-box, missing
credentials, platform not buildable, CI-only); suspected findings awaiting confirmation.>

## 10. How to reproduce
<Clone and check out the sha, environment and tool versions used, the exact commands for
each check and tool run, where each output file lives.>
```

**Scorecard ratings,** applied mechanically: **Red** = at least one blocker; **Amber** = no blocker, at least one major; **Green** = minors and nits only; **Not rated** = not audited or audited too shallowly to rate (say why). "Basis" names the standard and checklist file.

**Remediation plan.** Order by severity, exposure, then effort; root causes before their symptoms:
- **Now** (before next release or continued use): every blocker, and quick major wins (effort S).
- **Next** (next few iterations): remaining majors, root-cause fixes.
- **Later:** minors, hardening, nits worth doing.
Each line: IDs, action, effort, what it unblocks.

**Write it plainly.** Lead with the decision. Every sentence in the summary and top risks points at finding IDs. No unbacked adjectives ("robust", "clean").

### Hand to the gates

Commit `REVIEW.md` and `DECISIONS.md`, re-run and re-record checks on that HEAD (any commit moves HEAD), run `helm_slop_scan {}`, then request the review stage with the checks and `REVIEW.md` as evidence. In the fix loop, gate findings point at report claims: the fix is better evidence, a corrected claim, or the claim withdrawn, never a source change. Assign each to the specialist who owns the evidence, or fix `REVIEW.md` yourself.

---

## 10. Time-boxing

- **Every role gets a box** in the plan, sized to the scope. The box limits depth, never honesty.
- **Spend it roughly:** map 15%, automated tools 15%, manual depth on the riskiest areas 55%, writing 15%. Write each finding when you confirm it, not at the end. Breadth first: a pass over every in-scope area beats a perfect review of one module.
- **Stop at the box.** Mark unreached items `not checked (time-box)`, commit, report. If an area needs more time, say so; the lead decides and records it in `DECISIONS.md`. A suspected issue that would take more than about 20% of your box to confirm is reported as `suspected` with its confirmation step.

---

## Done means

**Scope and plan**
- [ ] The audited sha is pinned as a full sha in `ACCEPTANCE.md` and every finding refers to it.
- [ ] Scope lists are explicit, each AC names standard, depth and evidence path; scope and severity decisions are in `DECISIONS.md`.

**Read-only and safety**
- [ ] No source file changed: `git diff --stat <audited sha>..HEAD` lists only `reports/**`, `ACCEPTANCE.md`, `DECISIONS.md`, `REVIEW.md` and `.helm/**`.
- [ ] Nothing ran against production data, live payment or email endpoints or out-of-scope hosts; no destructive command ran; credentials, spending and private data went only through `helm_need`.
- [ ] No secret value or personal data appears in any committed file.

**Findings**
- [ ] Every finding has all section 5 fields; every quote is at most 3 lines and matches the pinned sha exactly.
- [ ] Every confirmed finding was reproduced or traced; every unconfirmed one is labelled `suspected` with a "To confirm" step.
- [ ] Tool output triaged, no raw dumps; at most 10 nits; no style preferences.

**Coverage**
- [ ] Each role's checklist marks every item pass, finding, n/a or not checked, with reasons.
- [ ] Strengths listed with evidence; everything not checked is in REVIEW.md with the reason.

**Report (lead)**
- [ ] Duplicates merged, root causes grouped, severities consistent across roles.
- [ ] REVIEW.md has all ten sections; scorecard ratings follow the stated rule; the remediation plan cites IDs and effort.
- [ ] Checks re-run and recorded on the final HEAD with their real exit codes; failing checks appear as findings.
- [ ] Someone else can re-run every tool from the reproduction section.

## Evidence to commit

Specialists, in `reports/<role>/` (platform specialists `reports/<platform>/`):
- `map.md`, `checklist.md`, `findings.md` (section 5 format).
- Tool outputs with command, sha and exit code: lint, build, tests, coverage, dependency audits, `gitleaks.json` (redacted), `semgrep.json`, `axe-*.json`, Lighthouse reports.
- Descriptively named screenshots, the UI `state-matrix.md`, and `<finding-id>-repro.txt` transcripts for behavioural findings.

Lead: `ACCEPTANCE.md` (review plan), `DECISIONS.md`, `REVIEW.md`, `.helm/checks.json`. Check outputs under `reports/checks/` stay untracked, as the wrapper expects.

## Sources

- OWASP Application Security Verification Standard (ASVS): https://owasp.org/www-project-application-security-verification-standard/
- OWASP Mobile Application Security (MASVS and MASTG): https://mas.owasp.org/
- OWASP API Security Top 10 (2023): https://owasp.org/API-Security/
- OWASP Web Security Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- MITRE CWE: https://cwe.mitre.org/
- W3C WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Nielsen Norman Group, 10 Usability Heuristics: https://www.nngroup.com/articles/ten-usability-heuristics/
- Deque axe-core: https://github.com/dequelabs/axe-core
- Chrome Lighthouse: https://developer.chrome.com/docs/lighthouse/overview
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Google Play Developer Program Policies: https://play.google.com/about/developer-content-policy/
- HHS, HIPAA Security Rule: https://www.hhs.gov/hipaa/for-professionals/security/index.html
- EU GDPR (Regulation 2016/679): https://eur-lex.europa.eu/eli/reg/2016/679/oj
- npm audit: https://docs.npmjs.com/cli/commands/npm-audit
- pip-audit: https://github.com/pypa/pip-audit
- OSV-Scanner: https://google.github.io/osv-scanner/
- Gitleaks: https://github.com/gitleaks/gitleaks
- Stripe testing (test mode and test cards): https://docs.stripe.com/testing
