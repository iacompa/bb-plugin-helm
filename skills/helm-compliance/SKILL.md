---
name: helm-compliance
description: Craft method for deciding which health, privacy, children's and payment rules apply (HIPAA, FTC HBNR, state health-data laws, GDPR/UK GDPR, CCPA/CPRA, COPPA, PCI DSS), mapping each requirement to an evidenced engineering control, and writing COMPLIANCE.md, drafts for counsel and path:line findings. Use when you are a Helm Compliance specialist.
---

# Helm Compliance Craft

Excellent compliance work answers three questions with evidence: which rules apply and why, which control in this codebase meets each requirement (with `path:line`, config or a committed artifact), and what is still missing or needs a human or counsel to decide. A reader can pick any requirement in COMPLIANCE.md and reach the code or document that satisfies it, or see plainly that nothing does yet. `helm-specialist` covers how you work inside Helm.

You read everything and edit only `COMPLIANCE.md`, `docs/compliance/**` and `reports/compliance/**` (your BRIEF's globs win if they differ). Source changes go to the lead as findings. Nothing you write is legal advice: you prepare facts, the control map and drafts so the human and their counsel can decide.

---

## 1. Principles

- **Applicability first, controls second.** Decide what applies and record why, then map controls.
- **Facts, not conclusions, for legal questions.** Write "The product stores lab results for clinics under contract", not "We are a business associate." Label your reading provisional and route the decision via `helm_need`.
- **Every control has evidence.** A requirement is "met" only when you can cite a commit, a `path:line`, a config file, a check output or a committed document.
- **Build to the stricter rule when unsure.** If it is unclear whether HIPAA or only the FTC rule applies, build the technical controls to HIPAA level (they cost little in code) and keep the legal question open.
- **Data minimisation beats protection.** PHI you never collect, log or send needs no protection. Challenge, through the lead, fields no ACCEPTANCE criterion needs.
- **Real data is a human decision.** Never use real patient or user data in development, tests, fixtures, screenshots or prompts. Approving use of real private data is `helm_need` with `about: privacy`.
- **Coordinate, do not duplicate.** Security owns the threat model, secrets and dependency audit (`SECURITY.md`); you own the regulatory mapping. Cite SECURITY.md and SEC-n findings instead of re-auditing.

---

## 2. Decide applicability and record it

Do this before anything else. Read SPEC.md, CONTRACT.md (the data models), ARCHITECTURE.md and any onboarding or business notes. Then answer each question below in COMPLIANCE.md section 1 with the facts that support the answer.

### 2.1 HIPAA

HIPAA applies to **covered entities** (health plans, health care clearinghouses, and health care providers who conduct standard electronic transactions such as claims) and to their **business associates** (anyone who creates, receives, maintains or transmits protected health information on a covered entity's behalf), and to subcontractors of business associates.

- **PHI** is individually identifiable health information held or transmitted by a covered entity or business associate. Health data alone is not PHI; it becomes PHI because of who holds it and why.
- **Likely in scope:** records or scheduling systems sold to clinics, telehealth for providers, billing or claims tools, patient portals run for a hospital, remote monitoring a provider prescribes.
- **Often not in scope:** a consumer wellness, fitness, diet, sleep, cycle or mood app where users enter their own data and no covered entity is involved. The same app can become a business associate if it later contracts with a provider or health plan to handle their patients' data. Record the trigger that would change the answer.
- **Online tracking:** HHS guidance treats pixels and analytics SDKs on a covered entity's authenticated pages and apps as PHI disclosures needing a BAA or authorization. Flag every third-party script or SDK there.

### 2.2 When HIPAA does not apply, other rules usually do

- **FTC Health Breach Notification Rule** (16 CFR Part 318): covers vendors of personal health records and related entities not covered by HIPAA, which includes many health and wellness apps that draw data from more than one source (user input plus a device, an API or a platform health store). A "breach" includes unauthorized disclosure, such as sharing with an advertising or analytics vendor without authorization, not only hacking. It requires notifying individuals, the FTC and in some cases the media.
- **FTC Act Section 5** (deception): a privacy policy that does not match the real data flows is a finding.
- **State consumer health data laws**: Washington's My Health My Data Act requires separate consents for collecting and sharing consumer health data, a signed authorization to sell it, a consumer health data privacy policy and deletion rights; it bans geofencing around health facilities and has a private right of action. Nevada, Connecticut and others have related laws. List target states for counsel.
- **GDPR / UK GDPR**: applies when the controller or processor is established in the EU/UK or targets or monitors people there. Health data is a **special category** (Article 9) that needs both an Article 6 lawful basis and an Article 9 condition (often explicit consent). Expect a DPIA (Article 35), a record of processing, processor agreements (Article 28), transfer mechanisms, and 72-hour breach notification where required (Article 33).
- **CCPA/CPRA** (California): applies to businesses above statutory thresholds (the human confirms); health data is sensitive personal information. Rights are in section 11.
- **COPPA**: services directed to children under 13, or with actual knowledge of collecting from them, need verifiable parental consent before collection, parental access and deletion, and retention limits. The FTC amended the rule in 2025; check the current text. The UK Age Appropriate Design Code adds design duties.
- **PCI DSS**: applies whenever the product stores, processes or transmits cardholder data, or can affect the security of that environment. See section 9.

### 2.3 Record it

Write COMPLIANCE.md section 1 as a table: regime, applies (yes / no / provisional / needs counsel), facts that decide it, what would change the answer. Then file one `helm_need` per open legal question (`about: privacy`, or `other` when it is pure interpretation), with the facts and options, for example: "A. Treat as HIPAA business associate (sign BAAs, full Security Rule mapping). B. Not HIPAA; apply FTC HBNR and WA MHMDA. C. Get counsel's opinion before launch." Keep building the controls common to every option while you wait.

---

## 3. Data inventory and data-flow diagram

You cannot map controls for data you have not found.

- **Inventory every data element** in `docs/compliance/data-inventory.md`: field and CONTRACT section, category (PHI, health, PII, sensitive PI, children's, cardholder, credential, telemetry), purpose and ACCEPTANCE criterion, where stored, who can read it, where sent (every vendor and SDK), retention, deletion mechanism, with `path:line` for model, storage and each outbound call.
- **Find the hidden copies:** logs, analytics, crash reports, search indexes, caches and CDNs, queues, emails, push payloads, URLs (which land in server logs, history and referrers), file names, backups, exports, support tools, LLM prompts and provider-side retention.
- **Data-flow diagram:** a text or Mermaid diagram in `docs/compliance/data-flow.md` showing actors, clients, services, stores and every vendor, with PHI flows marked and each trust boundary labelled. Extend the sketch in SECURITY.md rather than drawing a conflicting one.
- **Grep to verify, then read:**

```bash
# Logging and telemetry calls that may carry personal or health data
grep -rnE '(console\.(log|info|warn|error)|logger\.|log\.(info|debug|warn|error)|print\(|NSLog|os_log|Log\.[dviwe]\()' \
  --exclude-dir={node_modules,.git,dist,build,Pods,vendor} . | grep -iE 'patient|diagnos|dob|birth|ssn|email|phone|address|record|note|med|symptom|body|payload|req\.body'
# Analytics, crash and tracking SDKs
grep -rniE 'segment|mixpanel|amplitude|posthog|google-analytics|gtag|firebase/analytics|sentry|bugsnag|datadog|crashlytics|facebook|pixel' \
  --include=*.{js,ts,tsx,jsx,swift,kt,java,py,rb,go,json,yaml,yml,html} --exclude-dir={node_modules,.git,dist,build,Pods} .
# PHI-shaped values in routes and URLs
grep -rnE '(/patients?/|[?&](name|dob|email|ssn|mrn|diagnosis)=)' --exclude-dir={node_modules,.git,dist,build} .
```

Hits are leads: read each call site; record a finding or "checked, clean".

---

## 4. HIPAA Security Rule mapped to engineering controls

The Security Rule (45 CFR 164.302-318) has administrative, physical and technical safeguards. Each implementation specification is "required" or "addressable"; addressable means implement it or document why an equivalent alternative is reasonable, never "optional". HHS proposed in January 2025 to make most specifications required (including encryption and multi-factor authentication); check the rule's current status and build to the stricter version regardless.

### 4.1 Technical safeguards (164.312): where the code lives

| Requirement | Engineering control to look for | Evidence |
|---|---|---|
| Access control: **unique user identification** (required) | Every human and service has its own account; no shared logins; service accounts named per service | auth model `path:line`, user table schema |
| Access control: **emergency access procedure** (required) | A documented, audited break-glass path (time-limited elevated role, alert on use) | runbook in `docs/compliance/`, audit event type |
| Access control: **automatic logoff** (addressable) | Idle session timeout and absolute session lifetime on server and client; screen lock or blur on mobile when backgrounded | session config `path:line`, test name |
| Access control: **encryption and decryption** (addressable) | Encryption at rest for databases, object storage, backups and device storage; keys in a managed KMS or platform keystore | infra config, device storage code |
| **Audit controls** (required) | Records of who accessed or changed which PHI record, when, from where, with what result (section 5) | audit module `path:line`, sample log in reports |
| **Integrity** (addressable) | Constraints and transactions; checksums or signed records where tampering matters; no silent overwrite | schema, migration, tests |
| **Person or entity authentication** (required) | Strong authentication; MFA for workforce and admin access (and offered to users where risk warrants); secure password storage | auth config `path:line` |
| **Transmission security** (addressable) | TLS 1.2+ everywhere including internal service calls and database connections; HSTS on web; no plaintext email of PHI | server/TLS config, client network config |

### 4.2 Administrative safeguards (164.308): documents and processes

Most are not code. Draft what you can as documents in `docs/compliance/` marked for the human to adopt, and list the rest as human actions:

- **Risk analysis and risk management** (required): section 13.1.
- **Assigned security official, workforce training, sanctions policy**: organisational and human. Leave labelled blanks and list them as human actions.
- **Workforce security and information access management**: roles and least privilege (section 6); provisioning and removal procedure.
- **Security incident procedures**: section 13.2.
- **Contingency plan**: backup, disaster recovery and emergency mode operation. Cite the backup config and a restore test if one exists; otherwise record a gap.
- **Evaluation** (propose a review cadence) and **business associate contracts** (section 7).

### 4.3 Physical safeguards (164.310)

For cloud-hosted products, facility controls are inherited from the host under its BAA; record the provider and attestation. Workstation and media controls remain organisational gaps for the human.

### 4.4 Documentation

Policies, procedures, risk analyses and records of required actions must be retained for **six years** from creation or the date last in effect (164.316). Put a retention note in COMPLIANCE.md and make sure the documents live in version control or another durable store.

---

## 5. Audit logging

- **What to record:** actor (user ID or service ID, never a shared account), action (view, create, update, delete, export, print, share, login, failed login, permission change, break-glass), object (record type and opaque ID), timestamp in UTC, source (IP, device or client), outcome (success, denied, error). Record reads of PHI, not only writes.
- **What not to record:** the PHI itself. Log `patient_id=018f...`, not the name, diagnosis or note text.
- **Tamper evidence:** append-only storage, write-once or retention-locked buckets, or hash-chained entries; application roles cannot update or delete audit rows; access to the audit store is itself logged.
- **Separation:** audit logs are their own stream, with stricter access and longer retention than debug logs.
- **Retention:** HIPAA requires six years for documentation; the rule does not fix a period for audit logs themselves. Propose six years unless the human or counsel sets another, and record the choice.
- **Reviewable:** someone can answer "who viewed this record in the last 90 days?" with a query. Write that query in the runbook and test it.
- **Test:** an automated test asserts that reading a PHI record emits an audit event with the right fields, and that a denied access is logged as denied.

---

## 6. Access control, minimum necessary and sessions

- **Roles from the SPEC.** List each role (patient, clinician, front desk, billing, admin, support, service) and the minimum data each needs. The Privacy Rule's **minimum necessary** standard (164.502(b), 164.514(d)) applies to uses and disclosures other than treatment: support staff should see a ticket, not a chart.
- **Enforce on the server**, per object and per field where the SPEC distinguishes. Client-side hiding is not access control. Ask Security to confirm object-level authorization; reference their SEC findings.
- **Admin and support access** is audited and time-limited; no silent impersonation.
- **Sessions:** idle timeout and absolute lifetime are a product decision. Propose values in COMPLIANCE.md, let the lead record the choice in DECISIONS.md, and verify the code matches. Tokens are revoked on logout and password change.
- **Mobile:** sensitive screens hidden in app-switcher snapshots; local PHI in the platform keystore or an encrypted store.

---

## 7. Vendors and BAAs

Every vendor that creates, receives, maintains or transmits PHI on the product's behalf needs a **business associate agreement** before it touches PHI. Common ones people miss:

- Hosting and compute, managed databases, object storage, backups, CDNs that cache authenticated responses.
- Email and SMS providers (if message content or recipient context reveals health information).
- Error tracking, logging and APM (request bodies and breadcrumbs routinely contain PHI).
- Analytics, session replay, A/B testing, tag managers. Many of these will not sign BAAs; the usual answer is to remove them from PHI surfaces.
- Customer support, ticketing, chat, video and telehealth SDKs.
- **AI and LLM providers.** Some offer BAAs only for specific products, plans or configurations (often with zero data retention). Without a signed BAA, no PHI goes into a prompt, embedding, fine-tune or file upload.

Record each vendor in `docs/compliance/vendors.md`: data received (cite the call site), BAA availability and plan (from current official docs, else "unverified"), HIPAA-eligible service required, and status (needed / requested / signed by human / not needed: no PHI reaches it).

**Signing a BAA, choosing a HIPAA-eligible plan or upgrading to one is a human decision.** File one grouped `helm_need`, `about: access` (or `spending` for a paid tier), naming each vendor, why, the plan required and the alternative (remove it, de-identify first, self-host). Until approved, PHI stays away from that vendor: file findings for redaction, flags or removal. Track GDPR Article 28 processing agreements in the same table.

---

## 8. Where PHI must never appear

Unless a BAA covers the destination and the minimum necessary standard is met, file a finding for PHI or health data in any of these:

- **Logs** at any level, including request-logging middleware, ORM query logging with bound parameters, and exceptions that echo input.
- **Analytics events**, their properties, and page titles, screen names and URLs collected automatically.
- **Crash and error reports**: breadcrumbs, request bodies, user context. Configure scrubbing hooks and test them.
- **Push notification text** and lock-screen previews: "You have a new message", not the content or condition.
- **URLs and query strings**: identifiers in paths are fine if opaque; names, dates of birth, diagnoses or search terms are not.
- **Email subjects and SMS bodies**: send a link to an authenticated page instead.
- **LLM prompts**, embeddings, vector stores and provider-side logs.
- **Third-party scripts** on authenticated pages; **fixtures, screenshots and reports** (synthetic data only, section 10).

---

## 9. Payments and PCI DSS scope

When the project needs `payments`, coordinate with Security; you own the scope statement and the SAQ mapping, they own the technical review.

- **Minimise scope:** card data never touches the product's servers or code. Use the provider's hosted checkout or hosted fields. The standard is PCI DSS v4.x; check the PCI SSC library for the current version and SAQs.
- **Identify the likely SAQ** (for example SAQ A for fully outsourced hosted payment pages, SAQ A-EP when the product's page can affect the payment page) and record it as provisional. Which SAQ applies is confirmed by the human and the acquirer.
- **Never store** full card numbers, CVV, PIN or track data. Store only provider tokens and the last four digits if needed.
- **Script integrity on payment pages:** PCI DSS v4 requires an inventory and authorization of scripts on payment pages and detection of unauthorized changes. Flag third-party scripts on any page that hosts or embeds the payment form.
- **Health plus payments:** keep diagnoses, services and appointment details out of payment descriptions and metadata; they make the payment provider a PHI recipient.
- **Live keys and real charges** are the human's: `helm_need` with `about: credentials` or `spending`. Build against test mode.

---

## 10. De-identification, test data and analytics

- **HIPAA de-identification** has two methods (164.514(b)): **Safe Harbor** (remove all 18 listed identifiers, among them names, sub-state geography beyond the limited ZIP3 exception, date elements other than year, ages over 89, contact details, record, account and device numbers, URLs, IPs, biometrics and full-face photos, with no actual knowledge the rest identifies anyone) or **Expert Determination** (a qualified expert documents very small re-identification risk; a human engagement, never claim it was done).
- **Pseudonymised is not de-identified.** Hashed emails or internal IDs remain personal data under GDPR and remain PHI under HIPAA if the mapping exists.
- **Test data is synthetic.** Fixtures, seeds, demo accounts and screenshots use generated data (fictional names, reserved domains such as `example.com`). A fixture that looks copied from production is a finding until its origin is confirmed.

---

## 11. Retention, deletion and individual rights

- **Retention schedule** per data category in `docs/compliance/retention.md`: how long, why (legal requirement, product need), and the mechanism that enforces it (scheduled job, TTL, lifecycle rule). Medical record retention is often set by state law and provider policy, which the human must confirm. Backups age out on a known schedule.
- **Deletion** removes data from primary stores, search indexes, caches, analytics and vendor systems (via their deletion APIs), and documents what persists in backups until they expire. Account deletion is server-side, not just a local sign-out. Where HIPAA or another law requires keeping records, document the conflict and the rule chosen.
- **Rights to implement and test:**
  - HIPAA **right of access** (164.524): PHI in the form requested if readily producible, within 30 days (one 30-day extension). **Right to amend** (164.526): act within 60 days. **Accounting of disclosures** where applicable.
  - GDPR: access, rectification, erasure, restriction, portability (machine-readable export), objection; respond within one month in most cases.
  - CCPA/CPRA: know, delete, correct, opt out of sale/sharing, limit sensitive PI; respond within 45 days; honour Global Privacy Control signals where required.
  - COPPA: parental review, deletion and revocation of consent.
- **Verify identity** before fulfilling a request; log each request and outcome. For each right, cite the endpoint or procedure and the test that proves it, or record a gap.

---

## 12. Consent, notices and policy drafts

- **Consent where the law needs it:** explicit, specific, separable and recorded with timestamp, version of the text shown, and scope. Washington MHMDA needs separate consents for collection and sharing; GDPR Article 9 explicit consent cannot be bundled with terms of service; COPPA needs verifiable parental consent. Withdrawal is as easy as giving consent and propagates to vendors.
- **Privacy policy and consumer health data policy:** draft them in `docs/compliance/drafts/` from the data inventory, so every statement matches a real data flow. Head each file with: "DRAFT for review by legal counsel. Not legal advice. Not yet adopted." Do not publish drafts into the app; the UI or web builder links the adopted version once the human approves.
- **Do not invent legal language.** Cite section numbers only from the official text.

---

## 13. Risk analysis and incident response

### 13.1 Risk analysis

HIPAA requires an accurate and thorough risk analysis (164.308(a)(1)(ii)(A)); GDPR expects a DPIA for high-risk processing. Write `docs/compliance/risk-analysis.md`:

1. Scope: systems, data and flows from the inventory.
2. Threats per asset (reuse SECURITY.md's STRIDE model; add vendor disclosure, over-retention, failed rights requests).
3. Existing controls with evidence; likelihood and impact giving a risk level.
4. Mitigations with owners; accepted risks for the human's sign-off.

NIST SP 800-66 Rev. 2 and the HHS/ONC Security Risk Assessment Tool give good structures. Mark it as a draft for the human to adopt.

### 13.2 Incident response and breach notification

Draft `docs/compliance/incident-response.md`:

- Detection sources, triage, containment, evidence preservation, and who decides it is a breach (a role the human names).
- **HIPAA Breach Notification Rule** (164.400-414): an impermissible use or disclosure of unsecured PHI is presumed a breach unless a documented four-factor risk assessment shows a low probability of compromise. Individuals are notified without unreasonable delay and no later than 60 calendar days after discovery; breaches affecting 500 or more residents of a state or jurisdiction also require media notice; HHS is notified at the same time for 500 or more, or annually for smaller breaches. A business associate notifies the covered entity. PHI encrypted consistent with HHS guidance is not "unsecured", which is a strong reason to encrypt everywhere.
- **FTC HBNR**, **GDPR** (72 hours to the supervisory authority where required; individuals when high risk) and **state breach laws** have their own triggers and timelines. List the ones in scope with a link to the official text and leave the decision to counsel.
- Notification templates are drafts for counsel.

---

## 14. Writing COMPLIANCE.md

COMPLIANCE.md is the entry point; update it with each CONTRACT version and audit pass.

1. **Status line:** commit reviewed, date, overall status (for example "Provisional: 3 legal questions open, 7 gaps, 2 blocking").
2. **Applicability:** the table from section 2.3, with links to the `helm_need` items.
3. **Data summary:** categories of regulated data and a link to the inventory and data-flow diagram.
4. **Control matrix:** one row per requirement.

```
| ID | Requirement (source) | Control | Evidence | Status |
|----|----------------------|---------|----------|--------|
| C-HIPAA-312a-1 | Unique user identification (45 CFR 164.312(a)(2)(i)) | Per-user accounts; no shared roles | packages/core/src/auth/user.ts:18; schema users.id | Met |
| C-HIPAA-312b | Audit controls (164.312(b)) | PHI read/write audit events, append-only store | packages/core/src/audit/log.ts:40; reports/compliance/audit-sample.txt | Partial: reads not logged (COMP-004) |
| C-GDPR-17 | Right to erasure (GDPR Art. 17) | Account deletion job incl. vendors | none | Gap (COMP-009) |
```

   Status is one of Met, Partial, Gap, Not applicable (with reason), Inherited (with provider and attestation), Human action.
5. **Gaps and findings:** COMP-n IDs, severity, owner suggested, link to the finding.
6. **Human decisions needed:** applicability, BAAs and plans, security official, retention periods, session timeouts, consent model, policy adoption, risk acceptance. Each with the `helm_need` reference or "to file".
7. **Inherited controls and vendors:** link to `docs/compliance/vendors.md`.
8. **Disclaimer:** "Prepared by an automated agent to support review. Not legal advice. Final determinations rest with the organisation and its counsel."

### Filing findings

Send each to the lead with `helm_message` kind `ask`, one per root cause, listing every location:

```
[COMP-002] High: Request logger writes patient notes to application logs
Location: packages/core/src/http/logger.ts:27 (also :41) @ <commit sha>
Requirement: no PHI in logs; HIPAA minimum necessary; GDPR Art. 5(1)(c)
Evidence: logger.ts:27 logs req.body for POST /notes (free-text clinical notes).
Impact: PHI copied to a log vendor with no BAA (vendors.md row 4).
Fix: log route, status and opaque IDs only. Verify: a test asserts no body fields.
```

Severity follows `helm-security`'s rubric, raised one level for health or children's data. Also report what you checked and found clean.

---

## 15. Pitfalls

- **Declaring HIPAA compliance.** There is no HIPAA certification. Write "controls mapped; gaps listed", never "HIPAA compliant" or "certified"; flag such claims in UI copy or docs as S8 unbacked claims.
- **Treating encryption as enough.** It does not cover access control, audit, minimum necessary or vendor disclosures.
- **Free-text fields.** Notes, messages and search boxes carry PHI whatever the field is called.
- **Silent coverage gaps.** If you could not inspect infrastructure config, a mobile target or a vendor's terms, say so. Unknown is not compliant.

---

## Done means

**Applicability**
- [ ] COMPLIANCE.md section 1 states, for HIPAA, FTC HBNR, state health-data laws, GDPR/UK GDPR, CCPA/CPRA, COPPA and PCI DSS, whether each applies, the deciding facts, and what would change the answer.
- [ ] Every open legal question has one `helm_need` with facts and options; nothing claims to be legal advice.

**Data**
- [ ] The data inventory covers every field in CONTRACT.md plus logs, analytics, crash reports, notifications, URLs, emails, backups, vendors and LLM prompts, with `path:line`.
- [ ] A data-flow diagram marks PHI flows, trust boundaries and every vendor.

**Controls**
- [ ] Every applicable Security Rule technical safeguard, audit logging, access control, session policy, transmission and at-rest encryption, retention, deletion and each individual right has a matrix row with evidence or a COMP finding.
- [ ] Audit logging records reads and writes of PHI without PHI content, is tamper-evident, and a test proves it.
- [ ] No PHI reaches logs, analytics, crash reports, push text, URLs, email subjects or LLM prompts without a BAA, or a finding exists for each case.
- [ ] Test data, fixtures and screenshots are synthetic.
- [ ] Payment scope (if any) is minimised, the provisional SAQ recorded, and Security consulted.

**Vendors and human decisions**
- [ ] `docs/compliance/vendors.md` lists every vendor, the data it receives, BAA/DPA availability and status.
- [ ] BAAs, HIPAA-eligible plans, real data, credentials and spending went through `helm_need`; no agent signed or bought anything.

**Documents**
- [ ] Risk analysis, incident response plan, retention schedule and policy drafts exist in `docs/compliance/`, each marked as a draft for the human and counsel.
- [ ] COMPLIANCE.md has the status line, applicability, control matrix, gaps, human decisions, inherited controls and disclaimer.
- [ ] Findings filed with `path:line`, commit, requirement, evidence, impact, fix and verification; fixes re-verified.

---

## Evidence to commit

- `COMPLIANCE.md`
- `docs/compliance/data-inventory.md`, `data-flow.md`, `vendors.md`, `retention.md`, `risk-analysis.md`, `incident-response.md`
- `docs/compliance/drafts/` (privacy policy, consumer health data policy, consent text: all marked as drafts for counsel)
- `reports/compliance/`: redacted PHI-sink scan outputs with triage notes; a sample audit-log excerpt from a test run (fields present, no PHI); outputs of redaction, session-timeout and rights-request tests (or the `reports/checks/*.txt` the lead recorded); a dated applicability snapshot when a `helm_need` is answered. Synthetic data only; never real personal data, credentials, signed contracts or vendor account details. Cite them as `file` refs in `helm_report`.

---

## Sources

- HHS, Summary of the HIPAA Security Rule: https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html
- HHS, Summary of the HIPAA Privacy Rule: https://www.hhs.gov/hipaa/for-professionals/privacy/laws-regulations/index.html
- HHS, Breach Notification Rule: https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html
- HHS, Covered entities and business associates: https://www.hhs.gov/hipaa/for-professionals/covered-entities/index.html
- HHS, Sample business associate agreement provisions: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
- HHS, Guidance on de-identification of PHI: https://www.hhs.gov/hipaa/for-professionals/privacy/special-topics/de-identification/index.html
- HHS, Guidance on HIPAA and cloud computing: https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html
- HHS, Use of online tracking technologies by HIPAA covered entities and business associates: https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/hipaa-online-tracking/index.html
- eCFR, 45 CFR Part 164: https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164
- NIST SP 800-66 Rev. 2, Implementing the HIPAA Security Rule: https://csrc.nist.gov/pubs/sp/800/66/r2/final
- ONC/HHS Security Risk Assessment Tool: https://www.healthit.gov/topic/privacy-security-and-hipaa/security-risk-assessment-tool
- FTC, Health Breach Notification Rule: https://www.ftc.gov/legal-library/browse/rules/health-breach-notification-rule
- FTC, Mobile Health Apps Interactive Tool: https://www.ftc.gov/business-guidance/resources/mobile-health-apps-interactive-tool
- FTC, Children's Online Privacy Protection Rule (COPPA): https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
- Washington State Attorney General, My Health My Data Act: https://www.atg.wa.gov/protecting-washingtonians-personal-health-data-and-privacy
- GDPR, Regulation (EU) 2016/679 (EUR-Lex): https://eur-lex.europa.eu/eli/reg/2016/679/oj
- ICO, UK GDPR guidance and resources: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/
- California Attorney General, CCPA: https://oag.ca.gov/privacy/ccpa
- PCI Security Standards Council, document library: https://www.pcisecuritystandards.org/document_library/
- Stripe, Integration security guide: https://docs.stripe.com/security/guide
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
