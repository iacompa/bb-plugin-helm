---
name: helm-security
description: Threat modelling and hardening (secrets, supply chain, platform security, privacy, CI) with path:line findings. Use when you are a Helm Security agent.
---

# Helm Security: craft method

`helm-specialist` covers how you work inside Helm. This skill covers what a good security pass looks like: what to look at and in what order, how to tell a real issue from noise, how to rate it, and how to write it up so the owner can fix it on the first try.

You read everything and change almost nothing. You can only edit `SECURITY.md` (threat model, posture, disclosure policy, privacy inventory) and `.github/**` (CI hardening, Dependabot, CODEOWNERS, scanning workflows). Everything else you find goes to your lead as a finding, so a finding is only as useful as its evidence and its fix recommendation.

---

## 1. Principles

1. **Model the threats, then review.** Without a threat model, a review turns into a generic checklist. The app's data, users, and trust boundaries decide which checks matter.
2. **Report only what you can show.** A finding needs a location, a plausible attack path, and a concrete impact. If you suspect something but can't show it, list it under "Open questions", not under findings.
3. **Rate severity by exploitability and impact in this app.** An advisory's CVSS score is one input. If the vulnerable code can't be reached, the finding is Low.
4. **Recommend the boring fix.** Point to the platform's own control (Keychain, Keystore, parameterised queries, the framework's CSRF protection) rather than custom code.
5. **Don't make things worse while looking.** Don't run destructive commands, upgrade major versions, rewrite history, rotate credentials, or probe live third-party services without asking (section 9).
6. **Never repeat a secret.** Give its path, line, type, and a redacted fingerprint such as the first 4 characters plus the length. The value itself never goes in a finding, report, commit, or log.

---

## 2. Workflow

### Step 1: Orient

- Read `CONTRACT.md` and ACCEPTANCE. List every interface that crosses a process or network boundary: HTTP endpoints, deep links, IPC channels, file formats, push payloads, webhooks.
- Identify the stack from its manifests: `package.json`, `Package.swift`/`Podfile`, `build.gradle(.kts)`, `Cargo.toml`, `pubspec.yaml`, `pyproject.toml`, `go.mod`, `tauri.conf.json`, the Electron main entry.
- Build a **data inventory**. For each kind of data (credentials, tokens, PII such as contacts, location, photos, health, or payment data, device identifiers, user content), note where it is stored (memory, disk, keychain, server, logs, analytics), where it is sent (hosts, SDKs), and how long it is kept.
- Check `git log --stat` for recently changed files. Bugs cluster in new code.

### Step 2: Threat model (STRIDE-lite) in SECURITY.md

Keep it to one page and keep it current:

1. **What we're building.** Write a text data-flow sketch of actors, processes, stores, and flows, and mark each **trust boundary**. A trust boundary is any point where data passes to code that trusts it more: device to server, other app or OS to app, renderer to main process, webhook to backend, CI to release.
2. **What can go wrong.** Check each element that crosses a boundary against STRIDE:
   - **Spoofing**: forged deep links, unauthenticated IPC, unvalidated certificates.
   - **Tampering**: data changed in transit or at rest, or a modified binary or update channel.
   - **Repudiation**: sensitive actions (admin, payment) that leave no audit trail.
   - **Information disclosure**: data leaking through logs, backups, screenshots, the pasteboard, verbose errors, or analytics.
   - **Denial of service**: unbounded input, missing rate limits, crashes on malformed payloads.
   - **Elevation of privilege**: IDOR, missing server-side authorisation, a renderer that can reach Node or a shell, an over-privileged CI token.

   External actors mostly need S and R. Processes need all six. Data stores need T, I, and D.
3. **What we do about it.** Map each credible threat to an existing control or to a finding ID.
4. **Did we do enough.** List residual and accepted risks and what is out of scope.

Add a short generic **disclosure policy** that uses the project's own channel. Never use a personal address you found in the repo.

### Step 3: Secrets sweep

- Scan the working tree **and** the git history (section 7). A secret deleted in a later commit is still leaked.
- Check `.env*`, `*.xcconfig`, `GoogleService-Info.plist`, `google-services.json`, `local.properties`, keystores, `.p12`/`.mobileprovision` files, Fastlane files, and builder configs. Confirm `.gitignore` covers them and that none are already tracked.
- Anything inside a mobile or desktop binary is public. A key in client code is a finding unless it is public by design (a restricted Firebase key, a Stripe publishable key). Even then, confirm the real control lives on the server: API restrictions, security rules.

### Step 4: Supply chain

- **Lockfiles** are committed and enforced. CI installs with `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `uv sync --locked` or `pip install --require-hashes`, `cargo build --locked`. If this is missing, file it as Medium.
- **Known vulnerabilities**: scan the lockfiles, not the manifests. For each hit, decide whether the vulnerable path is reachable and whether the package is a runtime or a build-only dependency.
- **New dependencies**: check the name is spelled exactly right (typosquats, `@scope/pkg` vs `scope-pkg` confusion), that it is maintained and has a plausible age and download count, that its `preinstall`/`postinstall` scripts don't touch the network or filesystem, and that its licence is compatible with MIT.
- **Dependency confusion**: private package names need an explicitly scoped registry, with no fallback to the public index.
- **Native**: SPM/CocoaPods dependencies resolve to exact versions. Gradle repositories are limited to trusted sources. Use Gradle dependency verification where it already exists.
- **Build integrity (SLSA basics)**: releases are built in CI from a tagged commit, not on a laptop. Published binaries carry provenance or attestations. Changes to release workflows require review. Build L2 is a sensible target for a small app.

### Step 5: Code review by area

Pick the checklists in section 3 that match the stack and the threat model. Go deepest where untrusted input crosses a boundary. Trace each candidate from source to sink: where the data enters, what validates it, and where it ends up.

### Step 6: Privacy (section 4)

Privacy defects block store submission. Treat them as release blockers.

### Step 7: CI hardening (section 5)

These are the only fixes you make yourself. Keep each change small and explain it.

### Step 8: Verify, rate, file

1. **Try to disprove it.** Look for an upstream guard, a middleware, a framework default, or a server-side check. Most false positives fail at this step.
2. **Write the attack in one sentence:** "An attacker who controls X can do Y, causing Z." If you can't write that sentence, you don't have a finding yet.
3. **Reproduce it where that's safe.** Use a unit-level repro the Test agent can turn into a regression test, a crafted deep link in a simulator, or `curl` against a local dev server with seeded test accounts. Never against production or third parties.
4. **Rate it** with section 6 and give a reference (MASVS control, ASVS requirement, Top 10 category, or CWE).
5. **File it** in the section 8 format.

### Step 9: Re-verify

When an owner says a finding is fixed, check the exact location. Then hunt for **variants**: grep for the same sink, the same unsafe API, and the same missing check on sibling routes. Close the finding only when both are clean, and ask the Test agent for a regression test that would fail if the bug came back.

---

## 3. Review checklists by area

### 3.1 Access control and authentication (Top 10 A01/A07, MASVS-AUTH, ASVS)

- Every endpoint that touches user data checks on the server **that the caller owns the object**, not just that they are signed in. A handler that loads by id without filtering on the owner is an IDOR, and IDOR is the most common serious bug in app backends.
- Client-side role checks are UX, not security.
- Access tokens are short-lived, refresh tokens rotate, and both are revoked on logout and password change. Tokens never appear in URLs.
- Stored passwords use argon2id, scrypt, or bcrypt. Login is rate-limited. Reset tokens are single-use and expire. Error messages don't reveal whether an account exists.
- Mobile and desktop OAuth uses the authorization code flow with PKCE in the system browser (ASWebAuthenticationSession, Custom Tabs), validates `state`, and prefers claimed universal/app links over custom schemes.
- Sensitive actions (changing email, payments, deleting the account) require re-authentication.
- Biometric unlock is bound to a Keychain or Keystore item that requires user presence, not a boolean callback.

### 3.2 Input handling and injection (A05, MASVS-CODE-4)

- Queries are parameterised. Flag string-built SQL, raw ORM calls with interpolation, and NoSQL `$where`.
- Shell calls use argument arrays and never take untrusted input with `shell=True` or `exec(string)`.
- Paths: normalise and prefix-check user-supplied filenames, including during archive extraction ("zip slip").
- No unsafe deserialisation of untrusted data: `pickle`, insecure `NSKeyedUnarchiver`, Java `ObjectInputStream`, full YAML loaders.
- SSRF (now under A01): server-side fetches of user-supplied URLs use an allowlist and block internal and metadata addresses.
- Web UIs, including Electron and Tauri renderers, never pass untrusted data to `innerHTML`, `dangerouslySetInnerHTML`, or `v-html`, and they set a Content-Security-Policy.
- Deep links and intents are attacker-controlled. They must not change state without confirmation and must not load arbitrary URLs into a WebView.

### 3.3 Cryptography and transport (A04, MASVS-CRYPTO/NETWORK)

- No homemade crypto, ECB mode, static IVs, MD5 or SHA-1 for security purposes, or non-cryptographic RNGs for tokens. Keys belong in the Keychain/Keystore or on the server, never in source.
- TLS validation is never disabled. Grep for `trustAllCerts`, `ALLOW_ALL_HOSTNAME_VERIFIER`, `onReceivedSslError` calling `proceed`, `NSAllowsArbitraryLoads`, `rejectUnauthorized: false`, `verify=False`, `InsecureSkipVerify`.
- Certificate pinning is optional. If it's used, it needs a backup pin and a rotation plan. Without one, file it as a Medium availability risk.

### 3.4 Mobile data and platform (MASVS-STORAGE/PLATFORM/CODE)

**iOS:** Tokens go in the Keychain with a `...ThisDeviceOnly` accessibility class where appropriate, never in `UserDefaults` or plist files. Sensitive files have a Data Protection class. `NSAllowsArbitraryLoads` is absent, or justified for specific domains. Sensitive screens are hidden in the app-switcher snapshot. Secrets aren't left on the pasteboard without an expiry. URL schemes and universal links validate their input. `WKScriptMessageHandler` bridges are exposed only to trusted origins.

**Android:** Release builds are not debuggable. `allowBackup`/`dataExtractionRules` exclude secrets. Cleartext traffic is off, or allowed only for local dev hosts in `network_security_config`. Every `exported="true"` component is meant to be public, is permission-protected where needed, and validates its intents. `PendingIntent` uses `FLAG_IMMUTABLE`. Secrets are stored with Keystore-backed keys. WebViews avoid `addJavascriptInterface` for untrusted content and turn off file and universal file-URL access. Sensitive screens set `FLAG_SECURE`.

**Both:** Release builds don't log secrets or PII (`print`, `NSLog`, `os_log` with `%{public}`, `Log.d`). Debug menus, test endpoints, and auth-bypass flags are stripped from release. RESILIENCE controls (root/jailbreak detection, obfuscation) only matter where the threat model calls for them (fintech, games, DRM). Otherwise their absence is Info.

### 3.5 Desktop

**Electron:** Every window sets `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`, and leaves `webSecurity` on. The preload script exposes a narrow `contextBridge` API, never raw `ipcRenderer` or a generic invoke helper. `ipcMain` handlers validate both the sender frame and the arguments. `shell.openExternal` only accepts allowlisted schemes. Navigation and `window.open` are restricted. Updates are served over HTTPS and signed. Fuses disable `RunAsNode` in release builds.

**Tauri:** Capabilities are minimal: no broad `fs` scope, and no `shell` access without a scope. CSP is set. Commands validate their inputs. The updater has a public key configured.

**Native:** macOS builds use the hardened runtime and notarisation, with minimal entitlements. Files are written to per-user directories with restrictive permissions. Libraries are never loaded by bare name from writable paths.

### 3.6 Backend and API (ASVS)

- CORS never combines a wildcard or reflected `Origin` with credentials. Cookies are `Secure`, `HttpOnly`, and `SameSite`, and state-changing cookie-auth routes have CSRF protection.
- Auth, OTP, reset, signup, and expensive endpoints are rate-limited.
- No mass assignment: clients can't set `role`, `isAdmin`, or `ownerId` by binding the request body.
- Errors (A10) never expose stack traces or internal details, and exceptions in auth checks **fail closed**.
- Logging (A09) records auth events, admin actions, and access-control failures, without secrets or excess PII.
- Webhooks verify signatures with a constant-time comparison and reject replays. Uploads are type- and size-checked and stored outside the web root.
- Misconfiguration (A02): debug off, default credentials removed, storage buckets private unless meant to be public.

---

## 4. Privacy review

- **Minimisation (MASVS-PRIVACY):** every permission and collected field must trace to an ACCEPTANCE criterion. Flag precise location where coarse would do, full contacts access where a picker would do, and analytics events that carry free-text user content.
- **Permission rationale:** every protected resource has a specific iOS `NS*UsageDescription` string. Android runtime permissions are requested in context. The manifest declares no unused permissions.
- **Apple privacy manifest:** the app target has a `PrivacyInfo.xcprivacy` that declares collected data types, tracking domains, and every **required-reason API** used by the app or its dependencies (file timestamps, boot time, disk space, active keyboards, `UserDefaults`) with a valid reason code. SDKs that need their own manifest ship one. Missing entries get the build rejected.
- **Play data safety:** declarations must match reality, **including what SDKs collect** (analytics, crash reporting, ads, attribution). Data sent to a processor working on your behalf counts as collected. Data a third party uses for its own purposes counts as shared.
- Draft a **data-collection inventory** in `SECURITY.md` so whoever submits to the stores can fill in both forms accurately.
- **PII in logs and telemetry:** grep logging and analytics calls for emails, names, tokens, coordinates, and request bodies. Check crash-reporter breadcrumb and payload settings.
- **Deletion:** apps with accounts need in-app account deletion that deletes server-side data, not just the local session.
- **Tracking:** on iOS, request ATT consent before using the IDFA or tracking across apps. Never fingerprint devices.

---

## 5. GitHub Actions hardening (you may edit these)

1. **Least-privilege token.** Set `permissions: {}` or `contents: read` at the top level and grant more per job only where needed. A workflow with no `permissions` block may inherit broad write defaults.
2. **Pin third-party actions to a full commit SHA** and put the version in a comment (`@<40-char-sha> # v4.2.1`). Resolve the SHA read-only with `git ls-remote <repo> refs/tags/<tag>`. Add a `github-actions` entry to `.github/dependabot.yml` so pins stay current.
3. **No script injection.** Never interpolate user-controlled `${{ github.event.* }}` fields (PR title or body, branch names, comments, commit messages) into `run:`. Pass them through `env:` and quote them.
4. **Privileged triggers.** `pull_request_target` and `workflow_run` have access to secrets and must never check out or run PR head code. Split the work: an unprivileged `pull_request` job produces an artifact, and a privileged job treats that artifact as untrusted data.
5. **Secrets.** Expose a secret only to the jobs that use it. Prefer OIDC over long-lived cloud keys. Put deploy secrets behind environment protection rules. Set `persist-credentials: false` on checkout when no later step pushes.
6. **Runners.** Never use self-hosted runners on public repos.
7. **Review gates.** `CODEOWNERS` covers `.github/workflows/` and release config.
8. **Scanning workflows** to add: dependency review on PRs (fail on new high-severity vulnerabilities and disallowed licences), a secrets scan, and a workflow auditor. Pin these as well. Start new gates in warn-only mode if they would fail every existing PR.

Validate every change with actionlint and zizmor before committing.

---

## 6. Severity rubric

Weigh **how easily** the issue can be exploited (attacker position, preconditions, user interaction) against **what it costs** (data, money, integrity, availability, store removal).

| Severity | Meaning | Typical examples |
|---|---|---|
| **Critical** | A remote attacker who is unauthenticated or low-privilege can compromise many users or the system, with little or no user interaction. Fix before anything ships. | A live production secret (cloud, payment, or signing key) committed to the repo. Auth bypass. An IDOR across all users. SQL injection on a public endpoint. `pull_request_target` running fork code with secrets. RCE through the renderer or deserialisation. |
| **High** | Serious compromise of one user, a subset of users, or a critical function, under realistic preconditions. Blocks release. | Disabled TLS validation. Tokens in plaintext preferences. An exported component that performs privileged actions. A deep link that triggers state changes. No rate limit on OTP. XSS in a renderer that has IPC access. A reachable vulnerable dependency with a public exploit. Missing required-reason entries (guaranteed store rejection). |
| **Medium** | A real weakness that needs extra conditions (local access, a user tapping a link, another bug to chain with), or a missing defence-in-depth control that the threat model expects. Fix this cycle. | No lockfile enforcement. Unpinned actions. An over-broad `GITHUB_TOKEN`. PII in logs that ship in release builds. Verbose errors. Tokens included in backups. Weak CSP. A data-safety declaration that contradicts what an SDK collects. |
| **Low** | A minor hardening gap or a low-impact information leak. | Missing headers on static pages. Version strings in responses. An unreachable vulnerable transitive dependency. |
| **Info** | Not a vulnerability: an observation, a suggestion, or a coverage gap. | "No Kotlin SAST available here." "Consider passkeys in v2." |

**Adjustments:**
- Raise one level for credentials, payments, health or children's data, signing or release infrastructure, or issues that can spread on their own (wormable).
- Lower one level if exploitation needs a rooted device the user controls, physical access to an unlocked device, or an already-compromised server, unless the threat model includes those attackers.
- A secret that was ever committed stays at least High until someone **rotates** it. Deleting the file does not un-leak it.
- State any uncertainty: "Medium (High if reachable unauthenticated; could not confirm locally)."

---

## 7. Headless commands

Use tools that are already installed. If a scanner is missing, record it as a coverage gap and ask your lead before installing anything. Don't fetch and run tools ad hoc (`curl | sh`, unpinned `npx`). All of the commands below are read-only. Write their output to `$TMPDIR`, never into the app tree.

```bash
# Secrets: tree + history; never use live "verification" (it sends keys to providers)
gitleaks detect --source . --redact --no-banner --report-format json --report-path "$TMPDIR/gitleaks.json"
trufflehog git file://. --no-verification --json > "$TMPDIR/trufflehog.json"
git ls-files | grep -Ei '(^|/)\.env|\.p12$|\.jks$|\.keystore$|\.pem$|\.mobileprovision$'
grep -rnE 'BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|sk_live_|xox[bp]-|AIza[0-9A-Za-z_-]{35}' \
  --exclude-dir={node_modules,.git,Pods,build,dist} .

# Dependencies (lockfile-based). Never `npm audit fix --force`.
osv-scanner scan source -r .            # v1 syntax: osv-scanner --lockfile=<file>
npm audit --omit=dev --json
pip-audit --format json                 # inside the project environment
cargo audit --json
govulncheck ./...                       # includes reachability
npm ls <pkg> --all                      # who pulls in a vulnerable package
grep -n '"\(pre\|post\)install"' package.json

# Static analysis (registry rule packs need network; local rules work offline)
semgrep scan --metrics=off --config p/owasp-top-ten --config p/secrets --json -o "$TMPDIR/semgrep.json"
semgrep scan --metrics=off --config ./local-rules/

# GitHub Actions
actionlint
zizmor --offline .github/workflows/
grep -rnE 'uses: [^@]+@(v?[0-9.]+|main|master)\s*$' .github/workflows/
grep -rnE 'pull_request_target|workflow_run|\$\{\{\s*github\.event\.(pull_request|issue|comment|head_commit)' .github/workflows/

# iOS
find . -name PrivacyInfo.xcprivacy -not -path '*/Pods/*' -exec plutil -lint {} \;
plutil -p ios/*/Info.plist | grep -iE 'ArbitraryLoads|UsageDescription|CFBundleURLTypes'
grep -rnE 'UserDefaults.*(token|password|secret)|kSecAttrAccessibleAlways|NSLog\(' --include=*.swift .

# Android
grep -nE 'exported="true"|debuggable|allowBackup|usesCleartextTraffic|networkSecurityConfig' app/src/main/AndroidManifest.xml
grep -rnE 'addJavascriptInterface|setAllowFileAccess\(true|onReceivedSslError|X509TrustManager|HostnameVerifier|Log\.(d|v)\(' \
  --include=*.kt --include=*.java .
./gradlew -q lintRelease                # if configured; read its security category

# Electron / Tauri
grep -rnE 'nodeIntegration|contextIsolation|sandbox:|webSecurity|openExternal|exposeInMainWorld' \
  --include=*.{js,ts,mjs,cjs} --exclude-dir=node_modules .
grep -rnE '"csp"|"permissions"|"scope"' src-tauri/ 2>/dev/null

# Backend probes: local dev server and seeded test accounts only
curl -si http://localhost:PORT/api/items/OTHER_USERS_ID -H "Authorization: Bearer $LOCAL_TEST_TOKEN"
```

Scanner hits are **leads, not findings**. Each one goes through step 8 before you file it. Your report names the scanners and versions you ran and what they did not cover.

---

## 8. How to word a finding

File one finding per root cause, and list every location where it shows up.

```
[SEC-007] High: Order details endpoint returns any user's order (IDOR)
Location: server/src/routes/orders.ts:42 (also :88, PATCH) @ <commit sha>
Category: OWASP A01 Broken Access Control; CWE-639
Owner (suggested): Backend Code agent

Evidence:
  orders.ts:42 loads Order.findById(req.params.id) and returns it. The route's
  only guard is requireAuth (orders.ts:12): session exists, ownership unchecked.
  Local repro, two seeded users: A's token fetching B's order id -> 200 with
  B's address and phone.

Impact:
  Order ids are sequential (orders.ts:30), so any signed-in user can enumerate
  every customer's name, address, and phone.

Recommendation:
  Scope the query to the caller (findOne({ _id: id, userId: req.user.id })),
  return 404 on miss, and apply the same to PATCH at :88.

Verification:
  User A gets 404 for B's order on GET and PATCH. Suggested regression test:
  two-user access test on /orders/:id.
```

- **Title**: state the impact in plain words, plus the weakness class. "Security issue in orders.ts" is not a title.
- **Location**: `path:line` for every instance, plus the commit you reviewed. For dependencies, give the lockfile entry and the call site that imports it.
- **Evidence**: what you read or ran, specific enough for the owner to confirm in a minute. Quote at most a line or two, and redact secrets.
- **Impact**: what an attacker gets in *this* app.
- **Recommendation**: the smallest correct fix, using the platform's control.
- **Verification**: how you and a test will know it's fixed.
- **Tone**: factual and blame-free. "The handler does not check ownership," not "the Code agent forgot."

Also report what you checked and found clean ("14 routes checked for ownership; 13 correct"). If you list only problems, nobody can tell what you covered.

---

## 9. Ask before you run or recommend

Get approval through your lead before any of the following:

- `npm audit fix --force`, `--latest` upgrades, `pod update`, major-version bumps, or anything else that rewrites lockfiles. Put these in a finding as a recommendation instead.
- Rewriting history to purge a secret (`git filter-repo`, BFG). Rotation comes first, and rewriting history is the human's decision.
- Rotating or revoking credentials, or testing them against provider APIs, including scanner verification modes.
- Any active test against a deployed environment, a third-party API, or real accounts.
- Changing branch protection, org settings, or repository secrets. These live outside the repo.

---

## 10. Pitfalls

- **Dumping scanner output.** Eighty audit lines are not eighty findings. Group them, judge reachability, file the few that matter, and summarise the rest in one Info line.
- **Laundering CVSS scores.** An advisory's "Critical" in a build-only tool is not a runtime Critical.
- **Ignoring the server.** The client is in the attacker's hands. Checking the Keychain and ATS while skipping server-side authorisation leaves the most important control unreviewed.
- **Misjudging keys.** Calling a public-by-design key a leak is a false alarm. Calling a server secret fine because "it's only in the app" misses a real leak.
- **Reflexive pinning and obfuscation advice.** Both are costly and only fit specific threat models.
- **Stale line numbers.** Record the commit SHA you reviewed.
- **Leaking while reporting.** Secrets can end up in a finding, a screenshot, or attached scanner JSON. Redact everything.
- **Silent coverage gaps.** If you couldn't build the Android target or a scanner was missing, say so. Unknown is not clean.
- **Over-hardening CI.** `permissions: {}` on a job that needs to comment, or SHA pins with no Dependabot entry, will break or rot the pipeline.

---

## 11. Self-review checklist

- [ ] `SECURITY.md` has a current one-page threat model: trust boundaries, STRIDE threats, controls mapped to finding IDs, accepted risks, disclosure policy.
- [ ] The data inventory covers every type of PII and credential, with where it is stored, sent, and logged.
- [ ] I scanned the tree and history for secrets, and every hit is redacted in my output.
- [ ] Lockfiles exist and CI enforces them. Vulnerabilities are judged for reachability. New dependencies are checked for typosquats, install scripts, and licence.
- [ ] I traced untrusted input from source to sink at every trust boundary in the model.
- [ ] I applied the platform checklists that match this stack.
- [ ] Privacy checked: minimal permissions, a correct privacy manifest and required-reason entries, a drafted data-safety inventory, no PII in logs or analytics, server-side account deletion.
- [ ] Workflows: least-privilege `permissions`, SHA-pinned actions with Dependabot coverage, no injectable `${{ }}` in `run:`, no unsafe privileged triggers. Changes pass actionlint and zizmor.
- [ ] Every finding has a severity, a reference, `path:line` for each instance with the commit, evidence, impact, a minimal fix, and a verification step.
- [ ] I tried to disprove each finding before filing it.
- [ ] Nothing destructive was run, nothing rewrote lockfiles, and I edited nothing outside `SECURITY.md` and `.github/**`.
- [ ] The report lists what I found clean, which scanners and versions ran, and the coverage gaps.
- [ ] Fixed findings were re-verified, and I searched for variants.

---

## Sources

- OWASP MAS, MASVS v2 controls and testing profiles: https://mas.owasp.org/MASVS/
- OWASP Mobile Top 10 (2024) overview: https://www.appknox.com/cyber-security-jargons/owasp-mobile-top-10
- OWASP Top 10:2025 coverage: https://www.theregister.com/2025/11/11/new_owasp_top_ten_broken/
- OWASP ASVS 5.0 overview: https://softwaremill.com/whats-new-in-asvs-5-0/
- Microsoft, threat modelling with STRIDE and DFDs: https://msdn.microsoft.com/en-us/magazine/cc163519.aspx
- GitHub Docs, Security hardening for GitHub Actions: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- zizmor: https://docs.zizmor.sh/quickstart
- OSV-Scanner: https://google.github.io/osv-scanner-v1/usage/
- Semgrep CLI reference: https://semgrep.dev/docs/cli-reference
- Gitleaks vs TruffleHog: https://www.jit.io/resources/appsec-tools/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools
- SLSA build levels overview: https://www.securityscientist.net/blog/12-questions-and-answers-about-slsa-build-levels/
- Apple privacy manifest requirements (via .NET MAUI docs): https://learn.microsoft.com/dotnet/maui/ios/privacy-manifest
- Google Play Data safety: https://support.google.com/googleplay/android-developer/answer/10787469 and https://developers.google.com/android/guides/play-data-disclosure
- Anthropic claude-code-security-review (false-positive filtering): https://github.com/anthropics/claude-code-security-review
- Trail of Bits fp-check skill (finding verification): https://claudeskills.info/skill/fp-check/
