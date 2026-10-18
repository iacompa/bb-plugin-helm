# Copy and prose slop (helm-slop-hunter reference)

Adapted from Peter Yang's `no-ai-slop` skill and its eval (MIT, Copyright (c) 2026 Peter Yang). Changed for Helm: only the detect job is kept (the gate never rewrites), the patterns are applied to an app's user-facing text and mapped to Helm's S7, S8 and S9 rules and severities, and the word list also feeds the scanner's `S7-copy` rule. See THIRD_PARTY_NOTICES.md.

You judge text people read: README, store-listing drafts (`fastlane/metadata/**`, store text in `docs/`), onboarding, empty states, error messages, paywall and settings copy, notification text, UI string resources (`Localizable.strings`, `strings.xml`, `.arb`, `.xcstrings`) and literal strings in views. Code comments are S7 filler under the main skill's rules; this file is about copy.

## The job: detect, never rewrite

For each pattern you confirm, **name the pattern, quote the line, and give the fix in a few words.** Do not rewrite the copy, do not score it, and never say or imply that AI wrote it. Detectors guess; a named pattern at a quoted line is evidence the builder can check. The builder owns the rewrite.

## Patterns

**Stock words and phrases.** delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving, seamless, effortless, world-class, best-in-class, next-level, "unlock your potential", "look no further", "in today's fast-paced world", "it's worth noting", "let's dive in". The scanner flags the commonest ones in READMEs, store text and string files (`S7-copy`); confirm each hit in context and find the rest by reading.

**The portability test.** If a sentence could move unchanged to another product, company or country, it says nothing about this app. "Manage your tasks with ease" fits every to-do app ever made; "Drag a task onto tomorrow to snooze it" fits one. Fix: replace with the action, number, mechanism or consequence specific to this app, or cut it.

**Telling instead of showing.** Copy that labels the product important, powerful, intuitive or beautiful instead of saying what it does. Fix: state the fact ("Exports 1,000 photos as RAW in one tap") and let the reader judge.

**Importance puffery.** "Stands as a testament", "marks a pivotal moment", "plays a vital role", "takes your workflow to the next level". Fix: the plain fact.

**Weasel attribution and invented proof.** "Trusted by thousands", "loved by teams everywhere", "experts agree", "4.9 stars", "10k+ downloads" with no source in the product. This is an **S8 unbacked claim**, not style: quote it and ask for the source or its removal.

**Binary contrasts and negative listing.** "It's not just a notes app, it's your second brain." "Not a tracker. Not a diary. A companion." Fix: say the positive thing directly.

**Throat-clearing and rhetorical setups.** "Here's the thing", "Ready to take control?", "What if you could...", "Imagine a world where...". Fix: cut to the point.

**Colon reveals and fake-profound kickers.** "The best part: it learns." A closing line that turns the point into an aphorism ("Because your time matters."). Fix: a plain sentence; end on the last concrete point.

**Summary-recap endings.** "In conclusion", "Overall", a final README paragraph restating the features above. Fix: end on the last concrete point or the next step (how to run it, how to get it).

**Synonym cycling.** The same thing called a trip, a journey and an adventure on three screens; a session, workout and entry. Fix: one term per concept, the one CONTRACT and SPEC use. (On screens this is also an S9 consistency finding.)

**Generic UI copy.** "Welcome to the app!", "Something went wrong", "An error occurred", "Oops!", "Get started", "Submit", "Click here", an empty state that says only "No data". Fix: what happened and what to do; the button's real action ("Save shift"). On a main screen's primary message or a main flow's error, this is **S9 (major)**.

**Formatting slop.** Emoji in README headings or as bullets, bold sprinkled mid-sentence, headers over two-sentence sections, bullet lists where two sentences read better, em dashes as a rhythm habit (clusters of them in short copy). Fix: format follows content.

**Robotic rhythm.** Every feature bullet the same shape ("Effortlessly X. Seamlessly Y. Instantly Z."), stacked punchy fragments, identical paragraph structures. Fix: vary only where it helps; usually, say fewer things more concretely.

## Guards: when it is not slop

- The human's or SPEC's own wording, quoted or required (a legal line, a brand tagline the brief gives). Note it in the summary; do not file it.
- A word used literally ("seamless" for a texture that tiles, "robust" in a statistics context).
- A tone SPEC asks for (playful, terse). Voice is not slop; empty or false copy is.
- Third-party licence text, generated legal pages marked as such, and quoted user content.

## Severity

- Each confirmed pattern in copy is **S7 nit**. Many instances across the app are **one S7 minor** with a count and three quoted examples, not twenty nits.
- Copy that promises behaviour the code lacks, or proof the product does not have (users, ratings, awards, "end-to-end encrypted"), is **S8 major**.
- Generic copy as a main screen's primary message, a main flow's only error message, or an empty state with no explanation is **S9 major**.
- The README or store listing reading as stock throughout (most sentences fail the portability test) is **S7 minor**, raised to **S8 major** where the stock lines make claims.

## Writing the finding

```json
{"id": "F-4", "rule": "S7", "severity": "minor", "path": "README.md", "line": 3,
 "quote": "Tally is a seamless way to split bills with friends.",
 "why": "Stock phrasing throughout the README (portability test fails on 9 of 12 feature lines; also :8 \"Supercharge your group trips\", :11 \"Look no further\"). The reader cannot tell what Tally does differently.",
 "fix": "Replace each with the concrete behaviour (scan a receipt, assign items, settle up), or cut it."}
```
