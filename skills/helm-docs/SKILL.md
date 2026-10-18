---
name: helm-docs
description: README and docs that match the code, claim by claim, with commands actually run. Use when you are a Helm Docs agent.
---

# Helm Docs: documentation that matches the code

The `helm-specialist` skill covers how you operate inside Helm. This skill covers the craft: deciding what to write, writing it plainly, and proving that each sentence is true.

Your scope is `README.md` and `docs/**`. Treat every sentence that says the software *does*, *has*, *supports*, *requires*, or *outputs* something as a claim. The Slop Hunter gate fails documentation that contains unbacked claims (rule S8). In practice, you must be able to point at code, configuration, a test, or a command you ran for every claim you make. If you can't, narrow the wording until you can, or delete it.

## The core rule

**Document the code as it is, not the brief, the plan, or what a project like this usually has.** Briefs describe intent, and plans describe the future. Templates from other projects describe other projects. Only the code on your branch describes reality. When intent and code disagree, document the code and report the gap. Never "fix" the gap by describing behavior that doesn't exist.

## What counts as a claim

These need evidence:

- **Commands**: install, build, run, test, and deploy commands, plus any CLI invocation and its flags.
- **Configuration**: environment variable names, config keys, file locations, default values, and accepted values.
- **Behavior**: what a feature does, what an endpoint returns, what happens on error.
- **Output**: sample terminal output, sample responses, screenshots.
- **Requirements**: runtime and tool versions, operating systems, devices, accounts, API keys.
- **Support statements**: platforms, browsers, locales, accessibility.
- **Numbers**: limits, sizes, timeouts, performance figures.
- **Security and privacy statements**: what's stored, what's sent where, what's encrypted.
- **Project facts**: license, version, status, links, contact points, badges.

Purpose statements ("This app helps you track habits") and navigation text ("See Configuration below") aren't technical claims. They still have to be honest. A purpose statement that implies features the app lacks *is* a claim.

## Choose the right document type (Diátaxis)

Diátaxis splits documentation into four types, distinguished by two questions: is the reader *doing* something or *understanding* something, and are they *learning* or *working*?

| Type | Reader is | Purpose | Shape |
|---|---|---|---|
| Tutorial | doing + learning | Get a newcomer to a first success | A single guaranteed path, every step shown, no choices, visible result at the end |
| How-to guide | doing + working | Complete a specific real-world task | Goal in the title, prerequisites, numbered steps, a way to confirm it worked |
| Reference | understanding + working | Look up exact facts | Neutral description that mirrors the code's structure, consistent format, brief examples |
| Explanation | understanding + learning | Understand why and how it fits together | Prose about design, trade-offs, and concepts, with no steps |

Rules that follow:

- Keep one type per page. A how-to that stops to explain architecture loses the reader. Link to an explanation page instead.
- Reference describes and nothing else. Leave out opinion and instruction. Its structure follows the code (one section per command, module, endpoint, or config group).
- The README is a landing page. It holds a short pitch, a quickstart (a mini-tutorial), the key configuration, and links to the rest. Push depth into `docs/`.
- A typical layout:
  - `docs/tutorials/`, `docs/how-to/`, `docs/reference/`, and `docs/explanation/`, or flat files named for their type, following whatever the repo already does.
  - `docs/research/` belongs to the Research agent. Read it, don't edit it.

## Workflow

Copy this checklist into your working notes and tick items off as you go:

```
Docs progress:
- [ ] 1. Identify what changed and which docs it affects
- [ ] 2. Read the code paths behind every topic you will touch
- [ ] 3. Start a claim ledger
- [ ] 4. Draft in the right Diátaxis type, in plain style
- [ ] 5. Verify every claim (procedure below)
- [ ] 6. Run every command from a clean state
- [ ] 7. Narrow, remove, or flag anything you couldn't verify
- [ ] 8. Check links, formatting, and leftover placeholders
- [ ] 9. Run the self-review checklist
```

### 1. Identify what changed

Start from the task and the diff it relates to. List the user-visible changes: new commands, renamed flags, new environment variables, changed defaults, removed features. Then search the existing docs for every old name, such as `grep -rn "OLD_NAME" README.md docs/`. A rename that leaves one stale mention behind breaks the docs as surely as a missing page.

### 2. Read the code, not the summary

Go to the entry points that define user-facing behavior:

- **Scripts and tasks**: the `scripts` block in `package.json`, `Makefile`, `justfile`, `pyproject.toml` entry points, Gradle and Xcode schemes.
- **CLI surface**: the argument-parser definitions (commander, yargs, clap, argparse, click, cobra, and similar) and the `--help` output.
- **Configuration surface**: every read of the environment (`process.env`, `os.environ`, `std::env`, `import.meta.env`), config schemas, defaults files, and `.env.example`.
- **Public API**: exported symbols and their signatures, route definitions, OpenAPI or GraphQL schemas.
- **Platform facts**: the `engines` field, `.nvmrc`/`.tool-versions`, the CI matrix, minimum SDK or deployment target, and `Info.plist` or `AndroidManifest.xml` permissions.
- **Tests**: these show intended behavior and edge cases, and they're good evidence that a behavior is real.

### 3. Start a claim ledger

Keep a scratch table (outside the committed docs, or summarized in your report) with one row per claim:

| # | Claim (as written) | Where (file:line) | Evidence | Status |
|---|---|---|---|---|
| 1 | `npm run dev` starts the app on port 5173 | README.md:24 | `package.json` scripts.dev → `vite`; ran it, saw `Local: http://localhost:5173/` | verified-run |
| 2 | `HELM_LOG_LEVEL` defaults to `info` | docs/reference/config.md:12 | `src/config.ts:41` `?? "info"` | verified-read |
| 3 | Works offline | README.md:8 | No offline cache found in code | removed |

Status values:

- **verified-run**: you executed it and saw the documented result.
- **verified-read**: confirmed in code, config, or a test, but not executed.
- **narrowed**: the wording was reduced to what the evidence supports.
- **removed**: deleted from the docs.
- **flagged**: you couldn't verify it and couldn't remove it, so you escalated it.

The ledger is the evidence for your report and the answer to any S8 challenge.

### 4. Draft

Write in the doc type you chose, following the style rules below. Draft from the code and your notes rather than from memory of similar projects. Write procedures as numbered steps you're about to run yourself.

### 5. Verify every claim

Follow the claim-verification procedure below for every row in the ledger.

### 6. Run the commands

Run every command in the docs exactly as written, in order, from the directory the docs specify, starting from a clean state. See the procedure for details.

### 7. Narrow, remove, or flag

For each claim you couldn't verify:

1. **Narrow it** to what the evidence supports. "Supports all major browsers" becomes "Tested in CI against Chromium and WebKit" if that's what the CI config shows.
2. **Remove it** if nothing supports it.
3. **Flag it** through the protocol if the lead insists it belongs and you can't verify it, for example a store listing that requires a feature the code doesn't have yet.

Never document unshipped features as present. If a roadmap section is wanted, label it as plans, not capabilities.

### 8. Final mechanical pass

Check the following:

- Links resolve.
- Anchors exist.
- Relative paths point to real files.
- Code fences have language tags.
- Headings form a sensible outline.
- No `TODO`, `TBD`, `lorem`, `<your-…>` left unintended, and no placeholder URLs like `example.com` outside obvious examples.

## Claim-verification procedure

Apply the check that matches each claim type. Record the evidence in the ledger.

**Commands (install, build, run, test).**

1. Begin from a clean state: a fresh clone or a clean worktree, no build artifacts, no cached `node_modules` or virtualenv, and no environment variables beyond those the docs tell the reader to set.
2. Run each command exactly as written, copied from the doc, not retyped.
3. Record the exit code and the meaningful lines of output.
4. Confirm that the documented result happened: a server started on the stated port, a file appeared, the tests passed.
5. If the docs show output, it must match what you saw. Trim with an explicit `...` and never invent lines.
6. If a step needs something you can't provide (paid credentials, a physical device, store access), confirm the code path by reading it, mark the claim `verified-read`, and make sure the docs list that prerequisite.

**Flags and subcommands.** Find each in the parser definition and in `--help` output. Check spelling, short forms, whether the flag takes an argument, and its default.

**Environment variables and config keys.**

1. Find the line that reads each one.
2. Record the exact name, the type it's parsed as, its default (from code), and what happens when it's missing (crash, fallback, or silently ignored).
3. Document only variables the code actually reads. Search for variables that the code reads and the docs omit, and add them.

**Defaults and limits.** Take the value from the constant or schema in code and cite the file. Never document a "typical" default.

**Feature behavior.** Point to the implementing function and, ideally, a test that exercises it. For user-facing features, run the app or the test and observe the behavior. If the feature is partial, document the parts that work and state the limits.

**Code samples.** Run them, or at least compile and type-check them against the current code. Check that imported names are actually exported, that function signatures match, and that the sample output is real. Where the project has a tool that runs doc examples (doctest, a Markdown code-block test runner), use it.

**Platform and version requirements.** Take them from `engines`, version files, the CI matrix, build settings, and manifests. If CI tests only one OS, don't claim cross-platform support. Say what's tested.

**Numbers, performance, and size.** Every number needs a measurement you ran (state how) or a constant in code. Otherwise, remove the number.

**Security and privacy statements.** Treat these as high risk. Trace every network call, analytics SDK, storage location, and log statement before writing "never sends", "stored locally", "encrypted", or "no tracking". If any path contradicts the statement, or you can't trace them all, narrow the wording to what you verified, or leave it out.

**Links.** Fetch each external link (for example with `curl -sIL <url>`, or a link checker if the repo has one) and confirm it resolves and is the intended page. Check that relative links and anchors exist in the repo.

**Screenshots and media.** They must show the current UI. If you can't regenerate them, remove the outdated ones.

**Badges.** Add a badge only if the thing it reports exists, such as a CI badge for a workflow file that's actually present. Never add decorative or aspirational badges.

**License and project facts.** The license statement must match the `LICENSE` file. Versions must match the manifest. Contact points and URLs must be real and belong to the project. Don't invent them.

## README skeleton

Adapt this to the project, and remove any section you can't fill with verified content. An empty or speculative section is worse than none.

````markdown
# <Project name>

<One sentence: what it is and who it's for. No adjectives that can't be checked.>

<Optional: status line, e.g. "Status: early development; APIs may change." Only if true.>

## What it does

- <Capability 1: concrete, verb-first, backed by shipped code>
- <Capability 2>
- <Capability 3>

## Requirements

- <Runtime and version, from engines/.nvmrc/toolchain file>
- <Package manager and version, if it matters>
- <OS or device constraints, from CI/build settings>
- <Accounts or API keys needed, and where to get them>

## Install

```sh
<exact command(s), verified from a clean clone>
```

## Quickstart

<One sentence on what the reader will have at the end.>

1. <Imperative step.>

   ```sh
   <command>
   ```

2. <Imperative step.>

   ```sh
   <command>
   ```

   You should see:

   ```text
   <real output, trimmed with ... if long>
   ```

3. <How to confirm it worked, e.g. open the URL printed above.>

## Usage

<The two to five most common tasks, each as a short how-to or a link to docs/how-to/.>

## Configuration

| Variable / key | Default | Description |
|---|---|---|
| `<NAME>` | `<default from code>` | <What it controls; what happens if unset> |

<Where configuration lives (file path or env), and a link to full reference in docs/reference/.>

## Troubleshooting

<Only failures you actually saw or that the code explicitly handles.>

**<Exact error text or symptom>**
<Cause.> <Fix, as a command or a step.>

## Documentation

- <Link to tutorials, how-to guides, reference, explanation in docs/>

## Contributing

<How to set up a dev environment, run tests, and propose changes, or a link to CONTRIBUTING.md if it exists.>

## License

<License name>, see [LICENSE](LICENSE).
````

Notes on the skeleton:

- **Quickstart** is the most important section and the one most often broken. It must run unmodified from a fresh clone on a supported platform. The steps should take a newcomer to a visible success in as few steps as possible.
- **Requirements** list versions. "Node.js" isn't enough. "Node.js 22 or later (see `.nvmrc`)" is.
- **Configuration** is generated from the code's actual reads, not from `.env.example` alone, which may be stale.
- **Troubleshooting** contains real errors with their exact text, because readers search for that text.

## Other document types

### Changelog

Follow Keep a Changelog:

- Write for people, not machines. A commit-log dump isn't a changelog.
- Put the newest version first, with an `## [Unreleased]` section at the top that collects changes before release.
- Group changes under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`.
- Give each version an ISO 8601 date and make it linkable (a compare link or tag link at the bottom of the file).
- Say the project follows Semantic Versioning only if its version history actually does.

Build each entry from the diff and the merged work, and phrase it in terms of what changed for the user. Every entry is a claim. "Fixed crash when saving empty notes" needs a corresponding fix in the code.

### API and CLI reference

Generate reference from code when the project has the tooling, for example TypeDoc or JSDoc, Sphinx autodoc, rustdoc, or OpenAPI generated from route schemas. Hand-written reference drifts. When you have to write it by hand:

- Mirror the code's structure: one entry per command, endpoint, function, or config group, in a consistent format.
- Copy names, types, required or optional status, and defaults from the signatures and schemas themselves.
- Describe behavior neutrally. Link to how-to guides for usage walkthroughs.
- Give each entry one short example that you've run.
- Document error responses and exit codes that the code actually produces.

### App store listing copy

If the lead asks for store listing text, keep it in `docs/`, for example `docs/store/`, unless told otherwise. Before finalizing, check the current field limits and policies in the official store documentation, because they change. Field limits at the time of writing:

- **Apple App Store**:
  - name and subtitle: up to 30 characters each,
  - promotional text: up to 170 characters (editable without a new release, and it doesn't affect search),
  - keyword field: 100 characters, comma-separated.
- **Google Play**: the title is 30 characters or fewer.

Google Play policy forbids several things in titles and descriptions:

- ranking or performance claims ("#1", "best", "app of the year"),
- price or promotion text,
- references to store programs,
- emoji or repeated special characters in the title,
- keyword stuffing,
- unattributed testimonials.

Apple's guidance similarly discourages generic superlatives and keyword padding.

Craft rules for listing copy:

- Put the most useful sentence first, because it's what shows before "more".
- List features as concrete, user-facing outcomes, each mapped in your ledger to shipped code.
- Leave out features that aren't in the build being submitted.
- Privacy statements must agree with the app's actual data handling and with any privacy manifest or data-safety declaration in the repo.
- Keep a character count for every limited field and include it in your report.

### Troubleshooting pages

Use one entry per symptom. Give the exact error text, the cause, and the fix. Draw entries from errors you hit while verifying commands, error messages defined in the code, and issues the lead reports. Don't invent failure modes to make the page look complete.

## Style

These rules draw on the Google developer documentation style guide and the Microsoft Writing Style Guide:

- **Address the reader as "you".** Use the imperative for instructions ("Run", "Open", "Set").
- **Use active voice and present tense.** "The command creates a config file", not "A config file will be created".
- **Lead with what matters.** Put the key point in the first sentence of each section, and front-load the words readers scan for.
- **Write one action per numbered step.** Introduce each procedure with a sentence that says what it achieves. State the result after the action when the reader needs to confirm something. Mark optional steps "Optional:". Document the best way to do a task, not every way.
- **Use sentence-case headings,** with no trailing punctuation.
- **Put code in code font.** That includes commands, file names, paths, variables, keys, and literal values. Put multi-line commands in fenced blocks with a language tag, and leave the shell prompt (`$`) out of copyable blocks.
- **Write link text that describes the target.** "See the configuration reference", never "click here".
- **Keep sentences short and words plain.** Prefer common words, cut filler, and define each term once, then use it consistently.
- **Write for a global audience.** Avoid idioms, jokes, and culture-specific references, which translate poorly.
- **Make content accessible.** Give images alt text that says what they show. Don't convey meaning by color alone. Keep heading levels in order.
- **Use placeholders, not real data.** Write `<your-api-key>` or `YOUR_API_KEY` and say what to substitute. Never include real tokens, personal names, email addresses, or machine-specific paths such as home directories.

### Words to avoid

Cut these, or replace them with a specific, checkable statement:

- *Minimizers*: "simply", "just", "easy", "easily", "obviously", "of course". They're condescending when the step turns out hard, and they carry no information.
- *Marketing adjectives*: "powerful", "robust", "seamless", "blazing fast", "cutting-edge", "world-class", "best-in-class", "enterprise-grade", "revolutionary", "effortless", "intuitive", "next-generation".
- *Vague verbs*: "leverage", "unlock", "supercharge", "empower", "streamline".
- *Unbounded claims*: "all", "any", "every", "always", "never", "fully", "complete", unless the code proves the universal.
- *Future promises*: "will soon support", "coming shortly", unless the lead explicitly wants a labeled roadmap.

Instead of "Helm seamlessly integrates with your workflow", write what it does: "Helm reads tasks from `helm.yaml` and starts one agent per task."

## Quality bar

The docs are ready only when all of these hold:

- Every claim has a ledger row with evidence and a status other than unverified.
- Every command in the README quickstart and install sections was run from a clean state and produced the documented result.
- Every flag, variable, key, default, and path named in the docs exists in the code with that exact spelling and value.
- Every variable the code reads that a user can set is documented.
- No sample output, screenshot, or number is invented or out of date.
- Each page has one Diátaxis type, and the README links to deeper docs instead of absorbing them.
- No marketing language, minimizers, or unbounded claims remain.
- Links and anchors resolve, and no placeholder or TODO text is left by accident.
- Only `README.md` and files under `docs/` changed, and nothing in `docs/research/` was edited.

## Pitfalls

**Documenting the brief instead of the build.** The brief says "supports dark mode", but the code has no theme switch. Writing it anyway is the most common S8 failure. Code first, always.

**Hallucinated commands and flags.** Agents reach for conventional names (`npm run dev`, `--verbose`, `make install`) without checking that this project defines them. Every command must be found in the scripts or parser and then run.

**Hallucinated configuration.** Variable names that "should" exist (`PORT`, `DATABASE_URL`, `LOG_LEVEL`) get documented when the code reads something else, or nothing. Search the environment reads and document only those.

**Invented output.** Sample terminal output written from imagination looks plausible and is wrong in small ways, such as version strings, ports, or wording. Paste real output.

**Stale docs.** A feature gets renamed and five mentions remain. A default changes and the reference table doesn't. Search the docs for every changed identifier, and re-run the quickstart after any change to setup or scripts.

**Copy-paste from other projects.** Boilerplate sections (badges, contributing rules, support emails, deployment guides) carried over from a template describe someone else's project. Delete what doesn't apply.

**Marketing fluff.** Adjectives fill space and promise things you can't check. They also make the real claims harder to find. Replace each with a fact or remove it.

**Unbounded or universal claims.** "Works on all platforms" requires evidence for all platforms. Say what's tested.

**Security and privacy overstatements.** "Your data never leaves your device" is a strong claim that one analytics call disproves. Trace before you write.

**Duplicated content.** The same instructions written in three places will drift apart. Keep one canonical location and link to it.

**Mixed document types.** A tutorial that turns into reference, or a reference page full of opinions, serves nobody. Split it and link.

**Leaking environment details.** Absolute paths from the machine you ran on, usernames, hostnames, or real keys in examples. Replace them with placeholders before committing.

**Fixing code to match the docs.** If the docs reflect the intended behavior and the code is wrong, that's a finding for your lead, not an edit for you. Your scope is the docs.

## Self-review checklist

Run this against the finished change. Fix anything that fails before you hand off.

```
Truth (S8)
- [ ] Every claim is in the ledger with evidence and a status
- [ ] Unverifiable claims were narrowed, removed, or flagged, none left as-is
- [ ] Nothing describes planned, partial, or brief-only features as shipped
- [ ] Security, privacy, performance, and platform claims are traced to code or measurements

Commands and samples
- [ ] Install and quickstart ran unmodified from a clean state, and results matched
- [ ] Every other command was run or verified-read, with the reason recorded
- [ ] Sample output is real (trimmed with ... where shortened)
- [ ] Code samples compile or run against the current code

Configuration and reference
- [ ] Every env var and config key matches the code's spelling, type, and default
- [ ] No user-settable variable the code reads is missing from the docs
- [ ] Reference mirrors the code structure and only describes

Structure and style
- [ ] Each page is one Diátaxis type, and the README links out for depth
- [ ] The README has requirements with versions, a working quickstart, configuration, and troubleshooting drawn from real errors
- [ ] Second person, active voice, present tense, one action per step
- [ ] Sentence-case headings, code font for code, descriptive link text
- [ ] No marketing adjectives, minimizers, unbounded claims, or future promises

Hygiene
- [ ] Links and anchors resolve, and relative paths exist
- [ ] No TODO/TBD/placeholder text left unintentionally
- [ ] No real secrets, personal data, or machine-specific paths
- [ ] Changelog entries (if any) follow Keep a Changelog and match real changes
- [ ] Store copy (if any) is within current field limits and free of prohibited claims
- [ ] Only README.md and docs/** changed, and docs/research/ is untouched
```

## Sources

- Diátaxis, a systematic approach to technical documentation (Daniele Procida): the four types, the compass questions, and reference principles. https://diataxis.fr/ , https://diataxis.fr/compass/ , https://diataxis.fr/reference/
- Google developer documentation style guide: highlights and procedures. https://developers.google.com/style/highlights , https://developers.google.com/style/procedures
- Microsoft Writing Style Guide: top 10 tips for style and voice. https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice
- Google documentation guide: READMEs. https://google.github.io/styleguide/docguide/READMEs.html
- Make a README: suggested README sections. https://www.makeareadme.com/
- Keep a Changelog 1.1.0. https://keepachangelog.com/en/1.1.0/
- Semantic Versioning 2.0.0. https://semver.org/
- Write the Docs: Docs as Code. https://www.writethedocs.org/guide/docs-as-code/
- Apple Developer: creating your product page (name, subtitle, promotional text, keywords, screenshots). https://developer.apple.com/app-store/product-page/
- Google Play Console Help: metadata policy. https://support.google.com/googleplay/android-developer/answer/9898842
- Examples of tools that run code blocks in Markdown docs: pytest-codeblock (https://pytest-codeblock.readthedocs.io/) and markdown-doctest (https://github.com/Widdershin/markdown-doctest).
- Anthropic, "Skill authoring best practices": checklists, feedback loops, templates. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
