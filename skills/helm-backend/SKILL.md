---
name: helm-backend
description: Craft standards for the server side of a Helm project (API design from the CONTRACT, boundary validation, authentication, authorization, rate limiting, jobs, webhooks, uploads, email, payments, realtime, AI features, secrets, observability, testing, and seed data). Use when you are a Helm Core builder in a web project or in any project that needs a server.
---

# Helm Backend Craft

Excellent backend work is an API that does exactly what CONTRACT.md says, rejects bad input at the door, denies access unless it is explicitly allowed, survives retries and duplicate deliveries without double effects, keeps every secret on the server, logs enough to diagnose a failure without logging anyone's personal data, and has integration tests against a real database that would fail if any of that broke. `helm-specialist` covers how you work inside Helm. `helm-code` covers types, errors, storage, migrations, dependencies and tests in depth; this skill adds what is specific to running a server.

Your default write scope is `apps/api/**`, `packages/core/**` and `packages/server/**`. Your BRIEF wins if it differs. The Web or platform builders call your API. The UI builder never talks to you directly. A Data builder, when present, owns the schema and migrations (section 4). The Security agent reviews your work and files findings, which you fix.

---

## 1. Start from the CONTRACT and a boring stack

- **Read CONTRACT.md, SPEC.md, ACCEPTANCE.md and SECURITY.md first.** List every endpoint, event, job and external integration they require, and the NEEDS the project declares (database, auth, payments, hipaa, privacy, realtime, ai). Build only those.
- **Pick boring, mainstream technology** and send the choice and reason to the lead for ARCHITECTURE.md and DECISIONS.md (`helm_message`, kind `ask`). Sensible defaults:
  - **TypeScript web project:** the web framework's own server (route handlers, server actions, form actions) for a small app, or a separate Node service (Fastify, Hono or Express) when the API has other clients. Share schemas with the frontend in a package.
  - **Python:** FastAPI with Pydantic, or Django with Django REST Framework when an admin and a full ORM help.
  - **Go:** the standard library `net/http` router plus a thin set of libraries.
  - **Database:** PostgreSQL by default. SQLite is fine for a single-instance app. Redis only when you need it (rate limits, queues, pub/sub) and Postgres cannot do the job.
- **Verify every dependency in its registry** before adding it (`helm-code` section 11). Auth, crypto, payment and queue libraries are high-value typosquatting targets.

---

## 2. API design

- **REST or RPC, as the CONTRACT says.** REST suits public or multi-client APIs: resources as plural nouns (`/projects/{id}/members`), standard methods, standard status codes. RPC (tRPC, server actions, JSON-RPC) suits a single TypeScript client. Do not mix styles within one API without a reason in DECISIONS.md.
- **One schema, many uses.** Define request and response schemas once (Zod, Valibot, TypeBox, Pydantic) and derive validation, types, and an OpenAPI document from them. Publish the types or a generated client for the Web builder. Commit the OpenAPI file if the CONTRACT calls for one, and keep a test that fails if it drifts from the code.
- **Status codes mean what they say:** 200 and 201 (with a `Location` header) for success, 204 for no content, 400 for malformed input, 401 for no or invalid credentials, 403 for authenticated but not allowed, 404 for not found or not yours (section 6), 409 for conflicts, 422 for validation failures if the CONTRACT uses it, 429 for rate limits with `Retry-After`, and 5xx only for server faults.
- **Errors use one shape everywhere,** preferably RFC 9457 Problem Details (`type`, `title`, `status`, `detail`, plus a stable machine `code` and per-field `errors`). The CONTRACT's error codes are the only codes. Never return stack traces, SQL or internal hostnames.
- **Pagination on every list.** Use cursor pagination (an opaque `next` cursor over a stable sort with a unique tie-breaker) for feeds and large tables. Offset is acceptable for small admin lists. Enforce a default and a maximum page size.
- **Idempotency for unsafe retries.** Creating anything that costs money, sends a message or cannot be duplicated accepts an `Idempotency-Key` header. Store the key with the caller's identity, a hash of the request and the response. Return the stored response on a replay with the same request, and 409 or 422 if the same key arrives with a different request. Expire keys after a documented window, for example 24 hours.
- **Versioning:** additive changes (new optional fields, new endpoints) need no new version. Breaking changes follow expand, migrate, contract, or a new version in the path (`/v2/`) if external clients exist. Every change goes through the lead as a CONTRACT version bump. Never break a published CONTRACT silently.
- **Consistency:** one JSON casing, ISO 8601 UTC timestamps, opaque string IDs (UUIDv7 or ULID), money as integer minor units plus currency.
- **Concurrency control:** updates to shared records carry a version or `ETag`; reject mismatches with 409 or 412.

---

## 3. Validation at the boundary

- **Parse every input into a typed value before use:** body, query, path parameters, headers, cookies, webhook payloads, queue messages, and responses from third-party APIs. Reject unknown fields on writes (or strip them explicitly) to prevent mass assignment, so a client can never set `role`, `ownerId`, `isAdmin` or `price`.
- **Limits everywhere:** maximum body size at the server or proxy, maximum string lengths, array lengths, nesting depth, and numeric ranges, matching the CONTRACT. Unbounded input is a denial-of-service risk (OWASP API4).
- **Return all field errors at once** with stable field paths, so forms can show every problem in one pass.
- **Injection:** parameterised queries only; no shell calls with user input; normalise and prefix-check user-supplied paths.
- **Server-side fetches of user-supplied URLs** (link previews, outgoing webhooks, imports) go through an allowlist or a guard that resolves the host and blocks private, loopback, link-local and cloud metadata addresses, and does not follow redirects to them (OWASP API7, SSRF).
- **Third-party API responses are untrusted** (OWASP API10): validate shape, set timeouts, handle errors.

---

## 4. Persistence and the Data builder

- **Who owns the schema:** if the project has a Data builder, they own the schema, migrations and seed tooling. You consume their models and repositories, and ask for schema changes with `helm_message` (kind `ask`), giving the query you need and why. Never edit their migrations. If there is no Data builder, you own the schema and follow `helm-code` sections 4 and 5 in full.
- **Transactions** wrap every multi-step write, including a record plus its outbox or job entry (section 8).
- **Constraints in the database:** `NOT NULL`, `UNIQUE`, `CHECK`, and foreign keys. A unique constraint, not an application check, prevents duplicate signups and double bookings.
- **No N+1 queries.** Load related data with joins or batched queries, and add an index for each query a list endpoint uses. Check plans with `EXPLAIN` on realistic data volumes.
- **Connection pooling** sized for the target; serverless needs a pooler or a serverless driver.
- **Tenant isolation:** every tenant-data query filters by tenant, enforced in one place (a scoped repository or Postgres row-level security).
- **Destructive data operations** (dropping tables, bulk deletes, rewriting production data) need `helm_need` approval. Never run anything against a real production database without it.

---

## 5. Authentication and sessions

- **Use a proven library or provider; never write your own crypto or session protocol.** Options include the framework's established auth library (for example Auth.js or Better Auth for TypeScript, Django's built-in auth, or a maintained FastAPI auth package) or a hosted identity provider. A hosted provider needs an account and credentials from the human (`helm_need`). Build against its test or development mode meanwhile.
- **Passwords,** if you store them: hash with argon2id (OWASP minimum: 19 MiB memory, 2 iterations, 1 degree of parallelism) or bcrypt with a work factor of at least 10, noting bcrypt's 72-byte input limit. Never use MD5, SHA-1, plain SHA-256, or reversible encryption. Follow NIST SP 800-63B: allow long passwords and paste, no composition rules or forced rotation, a minimum length of 8 (15 when the password is the only factor), and a check against known breached passwords.
- **Sessions:** prefer server-side sessions with an opaque random ID in a cookie that is `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`), `Path=/`, ideally with the `__Host-` prefix. Regenerate the session ID on login and privilege change. Set idle and absolute timeouts. Logout and password change revoke sessions on the server.
- **Tokens,** if the CONTRACT needs them (mobile or third-party clients): short-lived access tokens, rotating refresh tokens with reuse detection, revocation on logout. Validate JWT signature, `iss`, `aud`, `exp` and the expected algorithm explicitly, and never accept `alg: none`. Tokens never go in URLs or logs.
- **OAuth and OIDC:** authorization code flow with PKCE, a validated `state` (and `nonce` for OIDC), exact redirect URI matching, and account linking by verified email only. Client secrets stay on the server.
- **MFA where needed:** offer TOTP (RFC 6238) or passkeys (WebAuthn) for admin accounts and wherever SPEC, payments or hipaa require it. Recovery codes are hashed and single-use.
- **Account flows:** email verification and password reset tokens are random, single-use, stored hashed, and expire (for example within an hour). Login, signup and reset responses do not reveal whether an account exists. Sensitive actions (changing email or password, deleting the account, payment changes) require recent re-authentication.
- **Account deletion** removes or anonymises server-side data as SPEC and SECURITY.md describe.

---

## 6. Authorization: deny by default

Broken object-level authorization (OWASP API1) is the most common serious API bug. Treat every ID in a request as attacker-controlled.

- **Deny by default.** Every route requires authentication unless it is explicitly marked public in code, and the public list is short and reviewed.
- **Object-level checks on every access:** load by ID and owner (or tenant) together, for example `WHERE id = $1 AND owner_id = $2`, or load then check with a policy function before returning or mutating. Return 404, not 403, for objects the caller may not see, so IDs cannot be probed.
- **Function-level checks** (OWASP API5): admin and role-restricted actions check the role on the server in the handler or a policy layer, never by hiding buttons.
- **Property-level checks** (OWASP API3): response schemas list exactly the fields each role may see. Never serialise a database row directly, because it leaks fields such as password hashes, internal flags and other users' emails.
- **One policy module.** Put rules such as `canEditProject(user, project)` in pure functions in one place, called by every handler, and unit-test them as a matrix of roles and ownership.
- **Business-flow abuse** (OWASP API6): limit bulk signup, scraping, and coupon or referral abuse where flows are valuable.
- **Fail closed:** if a policy check throws, deny.

---

## 7. Rate limiting and abuse

- **Rate-limit at least:** login, signup, password reset, OTP and verification, any endpoint that sends email or SMS, search, uploads, AI calls, and anything expensive. Key by account and by IP (respecting a trusted proxy header only when behind a known proxy).
- **Respond with 429 and `Retry-After`.** Use a shared store (Redis or the database) when there is more than one instance. An in-memory limiter is fine only for a single instance and must be documented as such.
- **Lock out gradually** (progressive delays) on failed logins, without letting an attacker lock a user out indefinitely.
- **Resource caps:** request timeouts, page-size maximums, GraphQL complexity limits, per-user quotas.

---

## 8. Background jobs and queues

- **Move slow or failure-prone work out of the request** (email, outgoing webhooks, image processing, AI calls, exports).
- **Use a proven queue:** Postgres-backed (pg-boss or Graphile Worker for Node, Oban for Elixir) when you run Postgres, Redis-backed (BullMQ, Sidekiq, Celery, RQ) when Redis is there. Use the host's scheduler for cron-like work.
- **Enqueue transactionally.** Write the job or outbox row in the same transaction as the data change, so a job never runs for a rolled-back change and is never lost for a committed one.
- **Jobs are idempotent.** Delivery is at least once, so each job carries an ID and checks whether its effect already happened before acting.
- **Retries with exponential backoff and jitter,** a maximum attempt count, then a dead-letter state that is visible and can be retried by an operator. Distinguish permanent failures (do not retry) from transient ones.
- **Each job has a timeout,** is safe to interrupt, and long jobs checkpoint.

---

## 9. Webhooks in and out

**Incoming**
- **Verify the signature on the raw request body** before parsing, using the provider's documented method (for example Stripe's `stripe.webhooks.constructEvent(rawBody, signature, secret)`) or HMAC-SHA256 with a constant-time comparison (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python). Reject a missing or bad signature with 400 or 401.
- **Reject replays:** check the signed timestamp against a tolerance (5 minutes is common) and record processed event IDs, ignoring duplicates.
- **Acknowledge fast:** verify, store, enqueue, return 2xx; process asynchronously and idempotently. Events can arrive out of order, so refetch state from the provider when order matters.
- **Webhook secrets** come from the human (`helm_need {about: "credentials"}`). Test locally with the provider's CLI forwarding in test mode where it exists (for example `stripe listen --forward-to localhost:3000/api/webhooks/stripe`).

**Outgoing**
- **Sign every delivery** (HMAC-SHA256 over the timestamp and body, following the Standard Webhooks specification if the CONTRACT has no other format), include an event ID and timestamp, and publish verification instructions.
- **Deliver from a queue** with per-attempt timeouts, backoff over hours, and disabling (with notice) of endpoints that keep failing.
- **Guard customer-supplied endpoint URLs against SSRF** (section 3) and require HTTPS in production.

---

## 10. File uploads

- **Prefer direct-to-storage uploads** with short-lived presigned URLs scoped to one object key, content type and maximum size, so large files never pass through your server.
- **Validate on the server:** size limits, an allowlist of types checked by content (magic bytes), not by extension or the client's `Content-Type`. Re-encode images to strip metadata such as EXIF location when users upload photos.
- **Store with random keys** outside the web root, in a private bucket by default. Serve through short-lived signed URLs or an authorised endpoint that checks ownership (section 6). Serve user files with `Content-Disposition: attachment` or from a separate domain so uploaded HTML or SVG cannot run scripts on your origin.
- **Malware scanning** before sharing, where the SPEC or hipaa need requires it.
- **Locally,** use a filesystem adapter or an S3-compatible container; a real bucket needs the human's credentials.

---

## 11. Email

- **Send through a transactional email provider's API or SMTP,** behind a small interface so tests and local development use a fake or a local catcher (such as Mailpit, which listens for SMTP on port 1025 with a web UI on 8025). A real provider account, sending domain, SPF, DKIM and DMARC records need the human (`helm_need`: credentials and access).
- **Send from a job,** not inside the request, with retries and idempotency so a retry never sends twice.
- **Templates** have a plain-text part and escape user content; links carry expiring single-use tokens, never session tokens.
- **Marketing email** needs consent, an unsubscribe link and a one-click `List-Unsubscribe` header (RFC 8058). Transactional email must not carry marketing.
- **Seed and test addresses use reserved domains** (section 18) and never receive real email.

---

## 12. Payments

- **Use the provider's hosted or embedded UI** (for example Stripe Checkout or the Payment Element) so card data never touches your server. That keeps PCI DSS scope to the smallest self-assessment. Never log, store or proxy card numbers.
- **Build in test mode** with test keys and the provider's test cards. Live keys, real charges, paid plans and payouts need the human: `helm_need` with `credentials` and `spending`.
- **The webhook is the source of truth** for payment state, not the browser redirect. Fulfil orders from verified webhook events, idempotently.
- **Send idempotency keys** on every create call to the payment API, and store provider IDs (customer, payment, subscription) against your records.
- **Prices and amounts come from the server,** never from the client request. Money is integer minor units with a currency.
- **Tell Security** about every payment path; payment findings rank one severity higher.

---

## 13. Realtime

- **Use realtime only when the SPEC needs it;** polling or revalidation is simpler for slowly changing data.
- **Server-Sent Events** for server-to-client updates (notifications, progress, feeds): plain HTTP, automatic reconnect, and resume with `Last-Event-ID`. **WebSockets** for bidirectional, low-latency interaction (chat, collaboration, multiplayer state).
- **Authenticate on connect** (session cookie with an `Origin` check, or a short-lived token), and **authorise every subscription and message** per channel or room with the same policy module as HTTP. A connection is not a permission.
- **Validate and rate-limit** every inbound message per connection.
- **Heartbeats** detect dead connections; bound per-connection buffers and disconnect slow consumers.
- **Scale out** through a pub/sub layer (Postgres `LISTEN/NOTIFY` or Redis) when there is more than one instance. The client must handle reconnects and refetch missed state, so events are hints and the database is the truth.
- **Collaborative editing** uses a proven CRDT library (`helm-code` section 6).

---

## 14. AI and LLM features

- **Keys stay on the server.** The browser or app calls your endpoint, which calls the provider. Provider keys come from the human (`helm_need {about: "credentials"}`). Real usage costs money: state the expected cost and ask for approval (`spending`) before anything beyond small development use.
- **No personal or private data to a provider without approval.** Sending user content, PII, health or payment data to a model provider needs `helm_need {about: "privacy"}` and an entry in SECURITY.md's data inventory. Minimise and redact what you send.
- **Every call has a timeout, a maximum output token limit, and a retry policy** for rate limits and transient errors, with backoff. Stream responses when the UI shows them progressively.
- **Cost caps:** per-user and global daily limits enforced on the server, rate limits on AI endpoints, and a usage log (tokens, model, user ID, cost estimate) without prompt contents. Fail with a clear error when a cap is hit.
- **Prompt injection is expected** (OWASP Top 10 for LLM Applications, LLM01). Treat model output as untrusted input: validate structured output against a schema, escape it before rendering, never execute it or pass it to SQL or a shell, and never let it choose which user's data to read. Tools the model can call are scoped to the current user's permissions and require confirmation for destructive or costly actions. Keep system instructions and retrieved documents separate from user input, and assume retrieved documents and web pages may contain hostile instructions.
- **Model name from an environment variable;** tests use a fake provider with fixed responses and never call a real model.
- **Do not claim output quality you did not measure.** If the SPEC sets quality criteria, keep a small fixed evaluation set and run it against the real model only with approval.

---

## 15. Observability without PII

- **Structured JSON logs** with level, timestamp, request ID (accepted from a trusted proxy or generated, and returned in a response header), route, status, duration, and opaque user or tenant IDs. Never log passwords, tokens, cookies, `Authorization` headers, API keys, full request or response bodies, emails, names, payment data or health data. Configure the logger's redaction for these paths and add a test that proves it (`helm-code` section 12).
- **Log security events:** logins and failures, credential changes, permission denials, admin actions, rate-limit hits, bad webhook signatures.
- **Health endpoints:** a liveness endpoint (for example `/healthz`) that returns 200 when the process is up, and a readiness endpoint (`/readyz`) that checks the database and required dependencies with short timeouts. Neither exposes versions of dependencies, configuration or secrets.
- **Error tracking:** report unhandled errors with the request ID and release version, scrubbing personal data before sending. A hosted error tracker needs an account (`helm_need`). Keep it optional and off when its DSN is not set.
- **Metrics:** at minimum request rate, error rate and latency per route, plus queue depth and failures. Use OpenTelemetry if the SPEC asks for tracing.
- **Graceful shutdown:** on SIGTERM stop accepting requests, drain in-flight work within a deadline, close connections.

---

## 16. Configuration and secrets

- **All configuration from the environment,** validated at startup by a schema, failing fast with the name of the missing or malformed variable and never its value.
- **Commit `.env.example`** listing every variable with a comment and a safe placeholder. Never commit `.env` or any real value. Check `.gitignore` covers env files and that none are tracked (`git ls-files | grep -E '(^|/)\.env'` must print only `.env.example`).
- **Secrets come from the human only** (`helm_need {about: "credentials"}`). Until then, run with local services and test-mode keys, and make features that need missing keys fail with a clear "not configured" error rather than silently doing nothing.
- **Separate environments:** development, test, preview and production use different databases and keys; production keys never sit on a developer machine or in CI logs.
- **Secrets never reach a client:** not in responses, HTML, or the frontend's public environment variables.

---

## 17. Testing

`helm-code` section 9 defines what a good test is. On the server, add:

- **Integration tests against a real database of the same engine and major version as production,** not mocks or SQLite standing in for Postgres. When Docker is in the project tools, start it with Testcontainers or a `docker compose` service. Each test runs in a transaction that rolls back, or against a freshly migrated schema. If Docker is not available, mark the integration check `"tier": "ci"`, add a CI job with a database service container, and say "integration verified by CI only" in your report.
- **HTTP-level tests** for every endpoint: success, each documented error code, validation failures, and limits, through the real router and middleware.
- **An authorization matrix test:** two users (and two tenants if multi-tenant) and each role. For every endpoint that takes an ID, user A's request for user B's object returns 404 and changes nothing. This is the test for OWASP API1.
- **Contract tests:** responses are validated against the CONTRACT schemas or the OpenAPI document, so a field rename fails a test before it breaks the Web builder.
- **Webhooks:** a valid signature is accepted, a bad or missing signature and a stale timestamp are rejected, and a duplicate event has no second effect.
- **Idempotency:** the same `Idempotency-Key` twice creates one record, and the same key with a different body is rejected.
- **Jobs:** run handlers with fixtures, including a retry after partial failure.
- **External services are faked at their boundary** (payment, email, AI, storage) with recorded or hand-written fixtures. Tests never call real third-party services or send real email.
- **Declare checks** for the lead's `.helm/checks.json` (send the exact commands, or write them as solo lead): for example `test` for unit tests, `test-integration` for database tests, `typecheck` and `lint`. Run each through `.helm/run-check.sh <name> -- <command>`.

---

## 18. Local development and seed data

- **One documented command starts** the API and its dependencies (for example `docker compose up -d` for Postgres and Mailpit, then the dev server). Without Docker, document native installs.
- **Migrations and seeds are separate commands;** the app never seeds itself on startup.
- **Seed data is clearly fake:** reserved domains (`example.com`, `example.org`, `.test`, `.invalid` under RFC 2606), obviously fictional names, fictional phone numbers, provider test card numbers only. Never copy real customer data into seeds, fixtures or tests.
- **Seed code never ships on a live path.** Keep it under a dev-only directory or script, exclude it from the production build, and make it refuse to run when the environment is production. Demo accounts with known passwords exist only in development. The Slop Hunter rejects fake data reachable in production (S2).
- **Seeds are realistic in shape:** long names, Unicode, empty and full lists, enough rows to exercise pagination.

---

## 19. Coordination

- **Web and platform builders:** publish the typed client or schema package with an example per endpoint, and tell them (`helm_message`, kind `info`) which commit has it. Breaking changes go through the lead as a CONTRACT bump.
- **Data builder:** agree on repository interfaces and who writes each query. Ask for schema changes with the reason and the query, and wait for the migration rather than working around it.
- **Security agent:** send them the list of endpoints, auth model, data stores, third-party processors and secrets (names only) for the threat model and data inventory in SECURITY.md. Fix their findings on your branch with a regression test, and report the commit.
- **Test agent:** share your seed command and test accounts.
- **Lead:** record decisions on auth provider, queue, hosting and data retention through the lead. Anything needing credentials, spending, real private data or access goes through `helm_need`, once, with options.

---

## Done means

**API and validation**
- [ ] Every CONTRACT endpoint exists with the specified schemas, status codes and error codes, and nothing undocumented is exposed.
- [ ] Every input is parsed by a schema with size limits, unknown fields cannot set protected properties, and all lists are paginated with a maximum page size.
- [ ] Unsafe creates that must not duplicate accept idempotency keys, and shared records use optimistic concurrency.

**Auth and access**
- [ ] Authentication uses a proven library or provider. Passwords use argon2id or bcrypt. Session cookies are HttpOnly, Secure and SameSite, and sessions rotate on login and are revoked on logout.
- [ ] Every route is authenticated unless explicitly public, and every object access checks ownership or tenant. The authorization matrix test passes.
- [ ] Sensitive endpoints are rate-limited and return 429 with `Retry-After`.

**Integrations**
- [ ] Incoming webhooks verify signatures on the raw body, reject replays, and process idempotently. Outgoing webhooks are signed, queued and retried.
- [ ] Jobs are enqueued transactionally, idempotent, retried with backoff, and dead-lettered visibly.
- [ ] Uploads are size- and type-checked by content, stored privately, and served with authorization. Email goes through a fake or local catcher in development.
- [ ] Payments use hosted card entry, test mode, and webhook-driven fulfilment. AI calls are server-side with timeouts, token limits and cost caps, and treat output as untrusted.

**Operations**
- [ ] Configuration is validated at startup, `.env.example` is committed, no `.env` is tracked, and no secret reaches a client.
- [ ] Logs are structured, carry request IDs, and a test proves sensitive fields are redacted. Liveness and readiness endpoints exist.

**Tests and evidence**
- [ ] Integration tests run against a real database of the production engine (or are CI-tier with a stated reason). Contract, webhook and idempotency tests exist and can fail.
- [ ] Seed data is clearly fake, dev-only, and refuses to run in production.
- [ ] Checks are declared in `.helm/checks.json` and exited 0 through `.helm/run-check.sh` on your last commit. `helm_slop_scan` is clean for your files.
- [ ] Every credential, spending, privacy or access decision went through `helm_need`, and the code works in test mode meanwhile.

## Evidence to commit

Under `reports/core/<task>/` if your BRIEF puts a reports folder in your scope. Otherwise leave these files untracked in your worktree and cite them as `report` refs, as `helm-specialist` describes:
- `tests-summary.txt`: unit and integration results with counts, the database engine and version used, and whether it ran in a container or CI.
- `authz-matrix.md`: the endpoints, roles and cross-user cases tested, with pass or fail for each.
- `openapi.json` or the schema package path, if the CONTRACT calls for it, plus the contract-test result.
- `headers-and-health.txt`: `curl -si` output for `/healthz`, `/readyz`, one 401, one 404 for another user's object, and one 429, from the local server with test accounts.
- `webhooks.txt`: results of the signature, replay and duplicate tests.
- `redaction-test.txt`: the log redaction test output.
- `ENV.txt`: runtime and database versions and the exact commands run.
- `needs.md`: each `helm_need` raised and what runs in test mode until it is answered.

## Sources

- OWASP API Security Top 10 (2023): https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- OWASP Authentication Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Session Management Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP Authorization Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- OWASP Server Side Request Forgery Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP File Upload Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OWASP Top 10 for LLM Applications: https://genai.owasp.org/llm-top-10/
- NIST SP 800-63B, Digital Identity Guidelines: https://pages.nist.gov/800-63-4/sp800-63b.html
- RFC 9457, Problem Details for HTTP APIs: https://www.rfc-editor.org/rfc/rfc9457
- RFC 2606, Reserved Top Level DNS Names: https://www.rfc-editor.org/rfc/rfc2606
- RFC 8058, One-Click Unsubscribe: https://www.rfc-editor.org/rfc/rfc8058
- Standard Webhooks specification: https://www.standardwebhooks.com/
- Stripe, webhook signatures: https://docs.stripe.com/webhooks
- Stripe, idempotent requests: https://docs.stripe.com/api/idempotent_requests
- PCI Security Standards Council: https://www.pcisecuritystandards.org/
- Testcontainers: https://testcontainers.com/
- OpenTelemetry documentation: https://opentelemetry.io/docs/
