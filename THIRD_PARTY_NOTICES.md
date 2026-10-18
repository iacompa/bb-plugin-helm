# Third-party notices

Helm is MIT licensed (see LICENSE). Some of its agent skills adapt guidance from the
open-source projects below, under their own licences. This file gives their attribution,
their licence terms, and a statement of what Helm changed.

---

## Uizze ui-taste and ios-design skills, and Impeccable (Apache-2.0)

- **Uizze** skills `ui-taste` and `ios-design`, https://uizze.com (distributed from https://uizze.sh). Licensed under the Apache License 2.0.
- They adapt **Impeccable**, Copyright 2025 Paul Bakaus, https://github.com/pbakaus/impeccable, licensed under the Apache License 2.0.
- The full Apache License 2.0 text is in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt).

Uizze's NOTICE reads, in part: "This project includes content derived from third-party work, used under the terms of its original license. Impeccable. Copyright 2025 Paul Bakaus. Original work: https://github.com/pbakaus/impeccable. Original license: Apache-2.0. Uizze modifies and redistributes design guidance, including creation, craft, refinement, web and native audits, and Overdrive, under Uizze product terminology. This is an adaptation, not an endorsement by the original author." Helm's use is likewise an adaptation, not an endorsement by Uizze or by the original author.

**Used in:** `skills/helm-ui/SKILL.md` (sections 1 to 3 and 14, parts of 17), `skills/helm-ui/reference/ios.md`, `skills/helm-ui/reference/native-audit.md`, `skills/helm-ui/reference/craft.md`, and the method followed by `skills/helm-ui/reference/android.md`.

**What Helm changed (October 2026):** rewrote and condensed the guidance for Helm's UI builder agents (their write scopes, `reports/ui/` capture naming, the human's device list, the Screens view and `reports/screens/screens.json`); made the image-generation step optional with a no-tool path and moved targets to `reports/ui/targets/`; removed Uizze's paid MCP connection and reference-retrieval steps; extended the native audit from iOS to Android, mapped its P0 to P3 priorities to Helm severities, and fixed its report to `reports/ui/AUDIT.md`; added iOS component, API and simulator capture detail; wrote new Android guidance; merged the template-habit list with Helm's own. Each adapted file says so near its top (`skills/helm-ui/SKILL.md` also lists it under Sources).

## platform-design-skills (MIT)

Uizze's `reference/ios.md` includes material distilled from ehmo's platform-design-skills (Apple Human Interface Guidelines), https://github.com/ehmo/platform-design-skills. Helm's `skills/helm-ui/reference/ios.md` adapts that playbook. Author: ehmo. The notice below is reproduced as Uizze's NOTICE gives it.

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## no-ai-slop (MIT)

Peter Yang's `no-ai-slop` skill and its eval, https://github.com/petergyang/no-ai-slop.

**Used in:** `skills/helm-slop-hunter/reference/prose.md`, the copy checks in `skills/helm-slop-hunter/SKILL.md`, and the `GENERIC_COPY` word list behind the scanner's `S7-copy` rule in `src/server/domain/slop/rules.ts`.

**What Helm changed:** kept only the detect job (the Slop Hunter gate never rewrites), applied the patterns to an app's user-facing text (README, store listings, UI strings, onboarding, errors), mapped them to Helm's S7, S8 and S9 rules and severities, added false-positive guards, and turned part of the word list into a deterministic scanner rule.

```
MIT License

Copyright (c) 2026 Peter Yang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## code-review-excellence (MIT)

Seth Hobson's `code-review-excellence` skill and its references, from https://github.com/wshobson/agents.

**Used in:** the review mindset, design-first phase, labels, `reports/review/NOTES.md` and disagreement rules in `skills/helm-reviewer/SKILL.md`, and `skills/helm-reviewer/reference/patterns.md`.

**What Helm changed:** reworked the method for a read-only gate that judges one commit and submits one machine-checked verdict; mapped its labels to Helm severities; added Swift, SwiftUI, Kotlin and Compose patterns; phrased every pattern as something provable at a line; dropped team-process advice (review turnaround, pairing, emoji) that does not apply to agents.

```
MIT License

Copyright (c) 2024 Seth Hobson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
