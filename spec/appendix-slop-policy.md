# Appendix B — The AI-slop policy

Companion to `PROMPT.md` §5.3 and §8. The human's requirement is blunt: **no AI slop**. This appendix defines what that means for app building, how it is detected, what counts as proof, and how it is tested.

---

## 1. What "slop" means here

Slop is output that *looks* finished but is not: filler that fills space, fakes that stand in for real behaviour, claims that nothing backs, and code that nobody checked against reality. It is the characteristic failure of fast, unsupervised generation. It is rarely one dramatic bug; it is a thousand small untruths that make an app feel hollow and eventually break in a user's hands.

Two layers catch it, because neither alone is enough:

1. **Deterministic scanner** (`helm_slop_scan`): cheap, repeatable, no model. Catches what a rule can catch: secrets, placeholders, debug leftovers, undeclared or invented dependencies, dead exports.
2. **Slop Hunter** (an LLM gate, ideally a different model family from the builders): catches what needs judgement: claims without behaviour, hollow tests, generic UI, narration comments, fake-data-by-another-name.

A third rule governs both: **every finding carries evidence** (a path, a line and an exact quote), and Helm **verifies the quote exists** before it counts. A finding that cannot be located is discarded as unverifiable.

---

## 2. Categories

| Id | Name | What it is | Detect | Default severity | Zero-tolerance |
|---|---|---|---|---|---|
| S1 | Placeholders | `TODO`, `FIXME`, `lorem ipsum`, "Coming soon", "Your text here", `xxx`, `Item 1`, empty handlers, `fatalError("not implemented")` **on shipped paths** | D | blocker | **yes** |
| S2 | Fake data on shipped paths | hard-coded sample users ("John Doe"), mock repositories or stub API responses wired into release builds, fabricated numbers shown as real | D + L | blocker | **yes** |
| S3 | Invented dependencies and APIs | an import with no manifest entry; a package that does not exist in the lockfile or registry; an SDK method that does not exist (compile/typecheck failure or symbol absent from installed typings) | D + L | blocker | **yes** |
| S4 | Dead code | unreachable code, unused exports/files, large commented-out blocks, duplicate near-identical files | D | minor (major if large) | no |
| S5 | Debug leftovers | `print`, `console.log`, `NSLog`, `Log.d`, `debugger`, test flags, verbose logging of user data **in release paths** | D | major (blocker if it logs user data) | **yes** (any logging of user data) |
| S6 | Secrets | API keys, tokens, private keys, `.env` committed, credentials in config or history | D | blocker | **yes** |
| S7 | Filler text | narration comments ("// This function adds two numbers"), restating comments, auto-generated banners, emoji-decorated READMEs, boilerplate docstrings that say nothing | D + L | nit (minor if pervasive) | no |
| S8 | Unbacked claims | README/store text/UI copy promising features, integrations or "AI-powered" behaviour that the code does not have | L (with D help) | major | no |
| S9 | Generic UI | default-template look with no design intent, inconsistent spacing/type scale, missing empty/loading/error states, lorem/stock imagery, missing dark-mode parity where claimed, missing accessibility labels | L (screenshots) | major | no |
| S10 | Over- and under-engineering | single-implementation interfaces, factory-of-factories, a dependency for a one-liner; or copy-pasted logic across platforms where shared Core was specified | L | minor/major | no |
| S11 | Hollow tests | tests with no assertion, assertions that cannot fail, mocking the unit under test, snapshot-everything, skipped tests left in, coverage padding | D + L | major | no |
| S12 | Swallowed failures | empty `catch`, `try? ` that hides errors on important paths, "success" returned on error, silent fallback to fake data, retry-forever | D + L | major | no |

Zero-tolerance categories **block Ready** until fixed or waived by the human with a typed reason of at least 20 characters. A secret waiver additionally requires the human to confirm the credential has been rotated.

---

## 3. "Shipped paths" and what the scanner ignores

A file is **shipped** unless it matches one of: `test/**`, `tests/**`, `**/__tests__/**`, `**/*Tests/**`, `**/*Spec.*`, `**/*.test.*`, `fixtures/**`, `examples/**`, `docs/**`, `**/*.stories.*`, `**/*Preview*`, `reports/**`, `.helm/**`, build output and vendored directories (`node_modules`, `Pods`, `build`, `dist`, `.gradle`, `DerivedData`), and `*.md` outside README claim checks. S1/S2/S5 apply to shipped files only. S6 applies to **everything**, including tests and history. When in doubt, treat a file as shipped.

An allowlist, `.helm/slop-allow.json`, may exempt specific `{rule, path, reason}` entries. Every entry is created by a `waive` directive and shows up in the Ledger; the scanner prints the exemption count so nobody can quietly grow it.

---

## 4. The deterministic scanner (`src/server/domain/slop/`)

**Inputs.** A repo path at a commit (the judged commit). **Outputs.** A sorted list of findings `{rule, severity, path, line, quote, why}` — identical across runs for the same commit.

**Design.**
- Walk git-tracked files at the commit; classify shipped/non-shipped (§3); detect language by extension.
- A **rule table** per language family, each rule: `{id, rule, severity, appliesTo: 'shipped'|'all', regex, languages[], excludeIf?}`. Start with:
  - S1: `\b(TODO|FIXME|XXX|HACK)\b`, `lorem ipsum`, `coming soon`, `your (text|name|title) here`, `not implemented`, Swift `fatalError\("(todo|not implemented)`, Kotlin `TODO\(`, `throw new Error\('not implemented`.
  - S2: strings `John Doe|Jane Doe|test@example\.com|foo@bar` in shipped files; identifiers `Mock|Stub|Fake|Dummy` referenced from non-test targets; `Math.random()`/`Int.random` feeding displayed values.
  - S5: `console\.(log|debug)`, `\bprint\(`, `NSLog`, `Log\.[dv]\(`, `debugPrint`, `println!`, `System\.out\.print`, `debugger;` in shipped files (allow a project logger wrapper listed in `.helm/slop-allow.json`).
  - S6: provider-prefixed tokens (`sk_live_`, `sk-[A-Za-z0-9]{20,}`, `AKIA[0-9A-Z]{16}`, `ghp_[A-Za-z0-9]{30,}`, `xox[abp]-`), `-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----`, high-entropy strings (Shannon entropy ≥ 4.0, length ≥ 24) assigned to names matching `key|secret|token|password|credential`, committed `.env*` files, secret-looking values in `git log -p` for the integration branch.
  - S7: comment-only lines matching `^\s*(//|#|/\*+)\s*(This|The)\s+(function|method|class|variable)\b`, banners like `Generated by`/`Created by ChatGPT|AI`.
  - S11: test files with zero assertion tokens (`assert|expect|XCTAssert|#expect|should`), `@Ignore|XCTSkip|it.skip|test.skip` left in.
  - S12: empty catch blocks (`catch\s*(\([^)]*\))?\s*\{\s*\}`, `except[^:]*:\s*pass`), Swift `try\?` followed by no handling on lines with `save|write|delete|upload`.
- **Manifest cross-check (S3).** Extract imports per language (`import … from 'x'`, `require('x')`, Swift `import X`, Kotlin/Java `import a.b.c`, C# `using`) and compare with the declared dependencies in `package.json`, `Package.swift`/`Package.resolved`, `build.gradle(.kts)`/version catalogs, `*.csproj`, `requirements.txt`/`pyproject.toml`. An import that resolves neither to the standard library, a local module, nor a declared dependency is a finding. A declared dependency absent from the lockfile is a finding. Where an offline registry mirror exists, flag names that do not exist in it; otherwise mark *unverified* rather than guessing.
- **Dead code (S4).** Unused exports/files via a cheap reference graph; large commented-out code blocks (≥ 8 consecutive commented lines containing code punctuation).
- **Budget.** Under 10 seconds for 50k lines. No network.
- **False-positive control.** Every rule has `excludeIf` hooks (generated files, localisation strings, vendored code) and a fixture on both sides (§8).

**Output to the gate.** Findings are stored in `findings` with `gate='scan'` and attached to the Slop Hunter's brief as "already found — do not re-report, do verify they are real and look beyond them".

---

## 5. The Slop Hunter protocol (LLM gate)

1. Read `ACCEPTANCE.md` and the scanner output for the judged commit.
2. **Dependencies are real.** For every dependency the app uses, confirm it exists and is used. Confirm every imported symbol exists in the installed version (typecheck/compile results count as proof; otherwise open the typings).
3. **Claims versus code (S8).** Take every sentence in `README.md`, store listing drafts and visible UI copy that promises behaviour. For each, find the code that does it. List the ones with none.
4. **Fake-data-by-another-name (S2).** Trace data shown on the main screens back to its source. Anything that originates in a literal, a `random`, or a stub and reaches a release build is a finding.
5. **Tests that can fail (S11).** Sample the tests for the main flows. For each, ask what change to the code would make it fail. If none, it is hollow.
6. **Failure handling (S12).** Read error paths on storage, network and permissions. Swallowed or "succeed on error" paths are findings.
7. **Filler and over-engineering (S7, S10).** Read the diff for narration comments, single-use abstractions, copy-pasted logic across platforms.
8. **UI (S9).** Using the screenshots in `reports/ui/` (or by capturing them: `xcrun simctl io booted screenshot`, `adb exec-out screencap -p`), check: a deliberate palette and type pairing, a consistent spacing scale, empty/loading/error states present, dark/light parity, accessibility labels, domain-real sample content. **If screenshots cannot be produced, list the screens under `unverified`; never pass UI you could not see.**
9. Write the verdict (§6). Prefer fewer, real findings over many weak ones. At most 10 nits.

---

## 6. Verdict schema (`helm_verdict`)

```ts
type Verdict = {
  gate: 'review' | 'slop';
  appId: string;
  commit: string;                         // the exact commit judged; must equal the integration HEAD at submit time
  verdict: 'pass' | 'fail';
  summary: string;                        // ≤ 600 chars
  checks: Array<{
    id: string;                           // 'AC-07' (from ACCEPTANCE.md) or a scanner/check name
    ok: boolean;
    how: string;                          // the command run or the method used, e.g. "ran .helm/run-check.sh tests -- npm test → 212 passed"
    ref: string;                          // output file under reports/, or path:line
  }>;
  findings: Array<{
    id: string;                           // 'F-1' (local to this verdict)
    rule: 'S1'|'S2'|'S3'|'S4'|'S5'|'S6'|'S7'|'S8'|'S9'|'S10'|'S11'|'S12'|'R'; // 'R' = review finding outside the slop set
    severity: 'blocker' | 'major' | 'minor' | 'nit';
    path: string; line: number;
    quote: string;                        // exact text at that line (≤ 200 chars)
    why: string;                          // what is wrong, in one or two sentences
    fix: string;                          // what would make it right
  }>;
  unverified: Array<{ what: string; reason: string }>;
};
```

**Helm rejects the verdict (and tells the gate why) if:** the `commit` is not the current integration HEAD · `verdict` is `pass` with any open `blocker` or `major` finding · `pass` with zero `checks` · any check lacks `how` or `ref`, or `ref` does not exist · any finding's `quote` is not found within ±2 lines of `line` at `commit` (Helm reads the file at that commit and compares after trimming whitespace) · the worktree is not clean or HEAD moved (read-only violation, §5.3) · more than 10 nits.

**Example — fail:**

```json
{
  "gate": "slop", "appId": "frame", "commit": "9f2c1ab", "verdict": "fail",
  "summary": "A live API key is hard-coded in the upload client; README promises RAW batch export that does not exist.",
  "checks": [
    {"id": "scan", "ok": false, "how": "helm_slop_scan on 9f2c1ab → 2 blockers", "ref": "reports/slop/scan.json"}
  ],
  "findings": [
    {"id": "F-1", "rule": "S6", "severity": "blocker", "path": "Sources/Upload/Client.swift", "line": 41,
     "quote": "let apiKey = \"sk_live_••••••••\"", "why": "Live credential committed to the repository.",
     "fix": "Move to the keychain at runtime and rotate the key."},
    {"id": "F-2", "rule": "S8", "severity": "major", "path": "README.md", "line": 18,
     "quote": "Batch-export RAW files in one tap", "why": "No RAW export code exists.", "fix": "Implement it or remove the claim."}
  ],
  "unverified": [{"what": "Windows build", "reason": "No Windows host; CI-tier only"}]
}
```

---

## 7. Waivers

Only the human waives. A `waive` directive names the finding id and gives a reason; Helm marks it `waived`, links the directive, and adds an allowlist entry if it is a scanner finding. Zero-tolerance waivers need a reason of at least 20 characters; secrets need an explicit "I have rotated this credential". An App Lead cannot waive; it can only propose through `helm_need`.

---

## 8. Fixtures and thresholds (build these in Phase 5; they are part of the acceptance tests)

```
test/fixtures/slop/
  planted/
    s1-todo-in-view/            a shipped Swift view with "TODO: real copy" and "Lorem ipsum"
    s2-fake-user-in-prod/       a release target that renders "John Doe" from a stub repository
    s3-invented-import/         imports a package absent from the manifest + a nonexistent method
    s5-debug-logging/           print(user.email) in a release path
    s6-live-key/                sk_live_ in source, an .env committed, a key in an earlier commit
    s7-narration/               comments that restate code
    s11-hollow-tests/           a test with no assertion; a test that mocks the unit under test
    s12-swallowed/              empty catch around a save
  control/
    clean-ios/ clean-android/ clean-ts/    realistic, slop-free apps that use TODO in tests, "Mock" in test targets, logging wrapper, etc.
  expected.json                 per-fixture list of {rule, path, line}
```

**Thresholds.** The scanner finds **100 %** of planted S1/S2/S3/S5/S6 items and **≥ 90 %** of the rest; it reports **≤ 2 %** false positives across the control repos (measured per finding). The verdict validator rejects 100 % of the malformed-verdict fixtures (missing refs, unlocatable quotes, pass-with-blockers). Add the *liar* simulator profile (claims done, no commits) to the same suite.

**Every slop escape becomes a fixture.** When a human finds slop that the gates missed, add it to `planted/` with its expected finding and make the suite fail until a rule or a protocol step catches it.
