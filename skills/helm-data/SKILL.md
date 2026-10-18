---
name: helm-data
description: Database craft (choice, schema, migrations, indexes, tenant isolation, PII and PHI, backups, seed data). Use when you are a Helm Data builder or own the database.
---

# Helm Data Craft

Excellent data work means the schema enforces the CONTRACT on its own, every change to it is a reviewed, tested, forward-only migration, every hot query has an index someone proved with `EXPLAIN`, sensitive columns are known, protected and deletable, and a backup has actually been restored. Another builder can read `CONTRACT.md` and `reports/data/` and know what is stored, why, and how to get it back. `helm-specialist` covers how you work inside Helm.

Your default write scope is `db/**`, `migrations/**`, `prisma/**`, `supabase/**`, `drizzle/**`, `packages/db/**` and `reports/data/**` (your BRIEF and ARCHITECTURE.md win if they differ). When there is no Data builder and you follow this skill as the Core builder, `reports/data/…` below means `reports/core/data/…`: stay inside your BRIEF's write scope. Application code that calls the database belongs to the Core builder unless your BRIEF says you own both; agree the boundary (repository functions, query module, generated client) with them through `helm_message`.

---

## 1. Choose the database deliberately

Write the choice and the reason in a short note under `reports/data/decision.md` and send it to your lead so it can be recorded in DECISIONS.md. Do not pick something exotic because it is fashionable.

- **PostgreSQL is the default for server apps.** It has real constraints, transactions, `timestamptz`, JSONB for the rare genuinely schemaless field, row-level security, partial and expression indexes, and every hosting provider supports it. Choose something else only for a stated reason.
- **SQLite for local, embedded and single-node apps:** desktop and mobile apps, CLIs, small automation jobs, a single-server web app with modest write volume. Turn on `PRAGMA foreign_keys = ON` per connection (it is off by default), use WAL mode (`PRAGMA journal_mode = WAL`), set a `busy_timeout`, and prefer `STRICT` tables so column types are enforced. One writer at a time is a design constraint, not a bug.
- **Managed options, with their trade-offs:**

| Option | Good for | Watch out for |
|---|---|---|
| **Supabase** | Postgres plus auth, storage and realtime, with RLS as the security model. A local stack via the Supabase CLI. | The client talks to the database through the API, so RLS is the only thing between a user and every row. Missing a policy is a data breach. |
| **Neon** | Serverless Postgres with branching (a database branch per preview or test run) and scale to zero. | Cold starts; use its pooled connection string from serverless functions. |
| **PlanetScale** | Managed MySQL on Vitess (and, more recently, Postgres) with schema-change workflows. | Check current foreign-key support and online-DDL behaviour for the engine you pick; do not assume Postgres features. |
| **Firebase (Firestore)** | Mobile apps that want offline sync and simple document reads. | No joins, no schema, limited transactions and queries; security rules are your authorisation layer and must be tested with the emulator. Model access patterns first. |
| **Self-hosted Postgres** | Full control, compliance needs. | You own backups, upgrades, monitoring and failover. |

- **A hosted account is the human's decision.** Creating a project, choosing a paid tier, getting a connection string, signing a BAA for health data: all need `helm_need` (about `credentials`, and `spending` if a paid plan is involved). Ask once, then keep building against a local database in Docker or SQLite with the connection string in an environment variable. Never block on the account.
- **Run the same engine locally as in production.** If production is Postgres, test on Postgres, not SQLite. Dialect differences (types, constraint behaviour, `ON CONFLICT`, case sensitivity) hide bugs. A local Postgres:

```bash
docker run -d --name app-db -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=app \
  -p 5432:5432 postgres:<current stable major>
export DATABASE_URL="postgres://postgres:devpassword@localhost:5432/app"
```

  With Supabase, `supabase start` runs the whole local stack and `supabase db reset` rebuilds it from migrations and seed. With Firebase, use the Emulator Suite (`firebase emulators:start`). Dev passwords like the one above are local-only and go in `.env.example` as placeholders; real connection strings never enter the repo.

---

## 2. Schema design from the CONTRACT

CONTRACT.md defines entities, fields and invariants. The schema is where they become impossible to violate. If the CONTRACT is ambiguous (Can this be empty? What happens to orders when a customer is deleted? Which timezone?), ask the lead with `helm_message` kind `ask`, choose the safest interpretation meanwhile, and note it in your report.

- **Normalise to third normal form by default.** One fact in one place. Denormalise only for a measured read problem, and then document what keeps the copy in sync (a trigger, a transaction, a rebuild job).
- **Primary keys:** a surrogate key on every table. Prefer **UUIDv7 or ULID** (time-ordered, so inserts stay index-friendly, and safe to generate on clients and in other services). Postgres 18 and later has a built-in `uuidv7()`; on older versions generate it in the application or with a well-known extension. Use `bigint generated always as identity` only for internal tables never exposed or merged. Never expose sequential IDs in URLs where enumeration matters.
- **Natural keys get a `UNIQUE` constraint,** not the primary key: email (on a normalised, case-folded column or with `citext`), slug, external provider IDs (`UNIQUE (provider, provider_id)`).
- **Constraints carry the invariants:**
  - `NOT NULL` on everything that the CONTRACT says is required. Nullable must be a decision, not a default.
  - `UNIQUE` for every uniqueness rule, including composite and partial ones (`UNIQUE (tenant_id, email) WHERE deleted_at IS NULL` as a partial unique index).
  - `CHECK` for ranges and simple rules (`CHECK (quantity > 0)`, `CHECK (ends_at > starts_at)`, `CHECK (status IN (...))` or a Postgres enum or a lookup table).
  - **Foreign keys on every reference, with a deliberate `ON DELETE`:** `CASCADE` for owned children (an order's line items), `RESTRICT` (or the default `NO ACTION`) when deletion must be blocked (a customer with invoices), `SET NULL` only when the CONTRACT says the link is optional. Write the choice beside each FK in a comment or the ER notes. Index FK columns; Postgres does not do it for you.
- **Money is integer minor units plus a currency code:** `amount_minor bigint NOT NULL`, `currency char(3) NOT NULL` (ISO 4217). Remember that not every currency has two decimals (JPY has zero, some have three). Never `float`, `real` or the Postgres `money` type. Use `numeric` only for rates and ratios.
- **Time:** instants are `timestamptz` stored in UTC (`created_at timestamptz NOT NULL DEFAULT now()`). Store the user's IANA zone in its own column when wall-clock time matters (recurring events, "9am every Monday"). Use `date` for calendar dates with no time (birthdays). Never store local time without its zone. In SQLite, store ISO 8601 UTC strings or epoch milliseconds, consistently.
- **Every table gets `created_at` and `updated_at`.** Keep `updated_at` correct with a trigger or the ORM, and test it.
- **Enums:** a lookup table or a `CHECK` constraint is easier to evolve than a Postgres enum type (adding values is fine; removing or renaming is painful). Pick one approach and use it consistently.
- **JSON columns are for genuinely variable data** (provider payload snapshots, user-defined settings). Anything you filter, join or constrain on is a real column.
- **Name things plainly and consistently:** snake_case, plural or singular tables (pick one), `<table>_id` for foreign keys, named constraints (`orders_quantity_positive`) so error messages are readable and migrations can drop them by name.

---

## 3. Migrations

Migrations are the most dangerous code in the project: they run once, against data you cannot see, and a mistake can lose it.

- **Versioned and ordered.** One tool owns the schema (Prisma Migrate, Drizzle Kit, the Supabase CLI, Flyway, Alembic, Rails, golang-migrate, sqitch, or the stack's equivalent). Its migration history table is the truth. No manual changes to any shared database, ever.
- **Forward-only. Never edit a migration that has shipped** (merged to the integration branch or applied anywhere shared). Fix forward with a new migration. Down migrations are optional; a restore from backup is the real rollback for destructive changes.
- **Reviewed SQL.** If the tool generates migrations from a schema file (`prisma migrate dev`, `drizzle-kit generate`), read the generated SQL before committing it. Generators sometimes drop and recreate a column where you meant a rename, which deletes the data. Commit the SQL, not just the schema file.
- **Transactional.** Postgres runs DDL inside transactions; make each migration atomic so a failure leaves the previous schema intact. Exceptions exist: `CREATE INDEX CONCURRENTLY` cannot run in a transaction, so put it in its own migration marked non-transactional. MySQL DDL is not transactional; keep each migration to one logical change there.
- **Expand, migrate, contract for anything breaking** (rename, type change, split, NOT NULL on an existing column), because old application code keeps running during a deploy:
  1. **Expand:** add the new column or table, nullable or with a default; the app writes both.
  2. **Migrate:** backfill in batches (not one giant `UPDATE` that locks the table), then switch reads.
  3. **Contract:** in a later release, add the constraint and drop the old shape.
  Adding `NOT NULL` to a big table: add a `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` separately, then set `NOT NULL`.
- **Locking awareness on Postgres:** set a `lock_timeout` in migrations that alter busy tables, create indexes `CONCURRENTLY` on tables with live traffic, and avoid rewriting a large table in one statement.
- **Test every migration two ways,** in CI and locally:
  - **Up from empty:** a fresh database migrated to head equals the expected schema (compare a schema dump, or use the tool's drift check such as `prisma migrate diff`).
  - **Up from the previous release:** restore a fixture or a dump of the last released schema with representative fake rows, apply the new migrations, and assert row counts and spot values survived.
  - Ask your lead to declare a `migrations` check in `.helm/checks.json` and run it through `.helm/run-check.sh migrations -- <command>`.
- **Destructive steps need a backup and a sign-off.** Dropping a column or table with real data, or rewriting values, is irreversible. Take and verify a backup first (section 9), and for any shared or production database ask via `helm_need` before running it. Never run migrations against production yourself unless the BRIEF explicitly says you deploy.
- **Keep a migration log** in `reports/data/migrations.md`: version, what it does, whether it is expand, migrate or contract, whether it locks or rewrites, and how it was tested.

---

## 4. Queries: ORM, query builder or SQL

- **Pick one primary access layer and use it consistently.** An ORM (Prisma, Drizzle, SQLAlchemy, ActiveRecord, Entity Framework, GORM) or a query builder (Kysely, Knex, jOOQ) is fine; raw SQL through the driver is fine. Mixing three styles makes review impossible. Verify the package name and API in its official registry and docs before adding it (`helm-code` covers dependency hygiene).
- **Parameterised queries only.** Never build SQL by concatenating or interpolating input, including in ORM escape hatches (`$queryRawUnsafe`, `sequelize.literal`, `text(f"...")`). Use the tagged or bound form (`$queryRaw` with a template, `text(...).bindparams`). Identifiers that must vary (sort column) come from an allowlist, never from the request.
- **Select only the columns you need,** especially when tables hold PII. `SELECT *` leaks new sensitive columns into every caller the day they are added.
- **Bound every list query** with a limit, and paginate with keyset (cursor) pagination on an indexed, unique ordering (`WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT 50`). `OFFSET` gets slower with every page.
- **Avoid N+1 queries.** Loading a list and then querying once per row is the most common performance bug. Use joins, the ORM's eager loading (`include`, `selectinload`, `includes`), or a batched `WHERE id = ANY($1)`. Detect it: enable query logging in tests and assert the query count for list endpoints.
- **Upserts** use the database's atomic form (`INSERT ... ON CONFLICT ... DO UPDATE`), never "select, then insert if missing", which races.

---

## 5. Indexes, justified and verified

- **Every index answers a query you can name.** List the hot queries (list screens, lookups by foreign key, auth lookups, background job scans) and the index that serves each. An index nobody uses costs every write.
- **Composite index column order follows the query:** equality columns first, then the range or sort column. `(tenant_id, created_at)` serves `WHERE tenant_id = $1 ORDER BY created_at DESC`.
- **Use partial and expression indexes where they fit:** `WHERE deleted_at IS NULL`, `lower(email)`.
- **Verify with `EXPLAIN`.** Load a realistic volume of fake rows (thousands to millions, matching ACCEPTANCE budgets), run `ANALYZE`, then:

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT id, title FROM tasks
WHERE tenant_id = '...' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50;
```

  Look for an index scan instead of a sequential scan on large tables, no unexpected sort, and row estimates close to actuals. On SQLite use `EXPLAIN QUERY PLAN` and look for `USING INDEX` rather than `SCAN`. Save the output in `reports/data/explain/<query-name>.txt` with the row counts used. `EXPLAIN ANALYZE` executes the statement: wrap writes in `BEGIN; ... ROLLBACK;`.
- **Encode the important ones as tests** where the stack allows: assert the plan does not contain a sequential scan, or assert a latency budget against seeded volume.

---

## 6. Tenant isolation and row-level security

If the app has more than one customer organisation or user whose data must never mix, isolation is the most important property of the schema.

- **Every tenant-owned table has a `tenant_id NOT NULL`** with a foreign key and leads its indexes. Child tables carry it too, so a query never needs a join to know whose row it is.
- **Enforce it in the database, not only in application code.** On Postgres, use row-level security:

```sql
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant_isolation ON tasks
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

  The application sets `app.tenant_id` per transaction (`SET LOCAL` or `set_config(..., true)`) so it cannot leak across pooled connections. The app connects as a role that is not the table owner and not a superuser, because superusers and roles with `BYPASSRLS` skip policies. On Supabase, policies use `auth.uid()` and the JWT claims; every table exposed through the API needs RLS enabled and a policy per operation.
- **Test isolation explicitly:** two seeded tenants; as tenant A, select, update and delete tenant B's rows by ID and assert zero rows affected. Test that inserting a row with another tenant's ID fails. Run these in CI. A missing policy is a Critical finding.
- **Firestore:** security rules play this role. Test them with the emulator and the rules unit-testing library, including the denied cases.
- **Service-role or admin connections** (migrations, background jobs, the Supabase service key) bypass isolation. Keep them server-side only, scoped to the jobs that need them, and never in client code.

---

## 7. PII and PHI: inventory, protection, retention

Know every column that holds personal data before anyone else asks. Coordinate with the Security specialist, who keeps the data inventory in SECURITY.md; your part is the column-level truth.

- **Keep a column inventory** in `reports/data/pii-inventory.md`: table, column, category (contact, identity, financial, location, health, credentials, free text that may contain anything), why it is collected (trace to SPEC or ACCEPTANCE), protection, retention, and how it is deleted. If you cannot justify a column, propose removing it.
- **Encryption at rest** is the baseline: managed providers encrypt storage by default; for self-hosted, use encrypted volumes. State which applies. It protects against stolen disks, not against a leaked connection string.
- **Field-level encryption for the sensitive few:** government IDs, health details, bank details, secrets that third parties gave you. Encrypt in the application with a vetted library (envelope encryption with a key from a KMS or secret manager), store ciphertext plus a key version so keys can rotate. Never invent cryptography or store the key in the same database. If you need to look up by an encrypted value, store a keyed hash (HMAC) in a separate indexed column. Real KMS keys are credentials: `helm_need`, and use a local dev key from an env placeholder meanwhile.
- **Passwords are never stored by you** in reversible form; if the app does its own auth, the Core or auth owner hashes with argon2id, scrypt or bcrypt, and you store only the hash.
- **PHI (the `hipaa` need):** health data tied to an identity requires a hosting provider that will sign a Business Associate Agreement, access logging, encryption in transit and at rest, minimum-necessary access, and an audit trail. Signing a BAA and choosing an eligible plan are human decisions (`helm_need` about `privacy` and `spending`). Until then, use only fake data; real PHI never enters dev or test databases.
- **Audit tables for sensitive actions:** an append-only `audit_log` (actor, action, entity, entity_id, at, request id, and a diff with sensitive values redacted). The application role can insert but not update or delete it. Do not put the sensitive values themselves in the log.
- **Retention and deletion:** each PII category has a retention period in the inventory and a job or procedure that enforces it. Account deletion removes or irreversibly anonymises personal data across every table, including derived copies, search indexes and audit rows where policy allows. Write a test that deletes a seeded user and asserts no row still holds their email, name or ID in personal-data columns. Remember backups: document how long deleted data survives in them.
- **Data export:** if SPEC or the privacy need requires it (GDPR access and portability), provide one function or query set that exports all of a user's data in a documented, machine-readable format (JSON or CSV), with a test that every PII table in the inventory is covered.
- **Real private data is never used in development or tests** without approval through `helm_need` (about `privacy`). Never copy a production dump to a laptop. If realistic data is needed, generate it.

---

## 8. Deletion semantics: soft or hard

Decide per entity, write it in the CONTRACT notes, and test it.

- **Hard delete** by default for data with no legal or product reason to keep it, and always when a user asks for erasure.
- **Soft delete** (`deleted_at timestamptz`) when the product needs undo, history, sync tombstones, or legal retention. Then: every read path filters it (a view, a default scope, or RLS), unique constraints become partial (`WHERE deleted_at IS NULL`), and a purge job hard-deletes after the retention period. Soft-deleted personal data is still personal data.
- **Archive tables** suit records that must be kept but are rarely read (closed invoices past a threshold).
- **Cascades are reviewed together with deletion semantics.** A `CASCADE` from a soft-deletable parent never fires; decide what happens to the children.

---

## 9. Backups and restore drills

A backup that has never been restored is a hope, not a backup. The restore test is the evidence.

- **Know the backup mechanism for the chosen platform** and write it down: managed providers offer daily snapshots and point-in-time recovery (PITR) on some tiers; self-hosted Postgres needs base backups plus WAL archiving (pgBackRest, Barman, WAL-G) for PITR. State the recovery point objective (how much data can be lost) and recovery time objective (how long a restore may take) from ACCEPTANCE, or ask the lead. Enabling PITR on a paid tier is `helm_need` (spending).
- **Logical backups** for portability and drills:

```bash
pg_dump --format=custom --no-owner --file="$TMPDIR/app.dump" "$DATABASE_URL"
createdb app_restore_test
pg_restore --no-owner --dbname=app_restore_test "$TMPDIR/app.dump"
```

  For SQLite, use the online backup API or `sqlite3 app.db ".backup 'backup.db'"`, never a raw file copy while the database is being written.
- **Run a restore drill** against a non-production target: back up a seeded database, restore it to a fresh instance, run the migration check and a set of row-count and integrity queries, and time it. Record date, source, method, duration, counts before and after, and result in `reports/data/restore-test.md`. Repeat it after major schema changes.
- **Backups contain everything,** including PII and deleted rows. They are encrypted, access-restricted, and their retention is documented in the PII inventory.

---

## 10. Seed data and test databases

- **Seed data is clearly fake and separate from migrations.** Migrations change structure (and insert true reference data such as a country list); seeds populate dev and demo databases and live in their own files (`db/seed/`, `supabase/seed.sql`, `prisma/seed.ts`). Seeds never run in production.
- **Fake means obviously fake:** emails on reserved domains (`@example.com`, `@example.org`), names and values that read as test fixtures, phone numbers from reserved fictional ranges where they exist. Never real people, real addresses or scraped data. Make the seed deterministic (fixed random seed) so tests and screenshots are stable. Use domain-realistic content for demos ("Quarterly roof inspection"), not "Item 1".
- **Shipped paths never read seed data.** The Slop Hunter rejects fake data on production paths.
- **Test databases, isolated per test:**
  - **Per-test transactions:** each test runs inside a transaction that is rolled back. Fast, but tests that need commits, multiple connections or `CONCURRENTLY` need another approach.
  - **Containers:** Testcontainers (or a Docker Compose service in CI) gives a real engine per suite; truncate or recreate between tests. Neon branches or `supabase db reset` work the same way.
  - Build the test schema by running the real migrations, never from a separate hand-written schema.
- **Test the schema itself:** constraint tests (insert a negative quantity and expect the `CHECK` to fail; insert a duplicate email and expect `UNIQUE` to fail; delete a parent and assert the `ON DELETE` behaviour), RLS tests, deletion and export tests, and migration tests. Each must fail if you remove the constraint, so prove that once.

---

## 11. Connections and transactions

- **Pool connections.** A long-running server uses one pool sized to the database's limits (start small: a few connections per CPU core is plenty). Serverless functions use the provider's pooler (PgBouncer, Supavisor, Neon's pooled endpoint, Prisma Accelerate or similar) because each invocation would otherwise open its own connection. In transaction-pooling mode, session state (`SET` without `LOCAL`, advisory locks, some prepared-statement setups) does not persist; check your driver's guidance.
- **Set timeouts:** a connect timeout, a `statement_timeout` for the application role, and `idle_in_transaction_session_timeout` so a stuck request cannot hold locks forever.
- **Transaction boundaries match business operations.** Everything that must succeed or fail together (an order and its line items, a write plus its outbox row) goes in one transaction. Keep transactions short: never call an external API or wait on a user inside one.
- **Choose the isolation level on purpose.** Postgres defaults to Read Committed. For read-modify-write logic, use `SELECT ... FOR UPDATE`, an optimistic `version` column (`UPDATE ... WHERE id = $1 AND version = $2`), or Serializable with retry on serialization failure. Test concurrent writers against the same row.
- **Idempotency for writes triggered by retries** (webhooks, job queues): a unique key on the external event or operation ID, so a replay inserts nothing new.

---

## 12. What goes in CONTRACT.md and reports/data/

You do not edit CONTRACT.md (the lead publishes it). Send the lead precise proposed text with `helm_message`, covering:

- Each entity's table, columns, types, nullability, constraints, and `ON DELETE` choices.
- ID strategy, money and time conventions, enum strategy, soft or hard delete per entity.
- Tenant model and isolation mechanism.
- The data access surface other builders may use (repository functions or generated client) and what they may not do (no raw SQL outside the data package, for example).

In `reports/data/` keep:

- **`er.md`**: the ER diagram as Mermaid text, kept in step with migrations:

```mermaid
erDiagram
  TENANT ||--o{ USER : has
  USER ||--o{ TASK : owns
  TASK {
    uuid id PK
    uuid tenant_id FK
    text title
    timestamptz created_at
  }
```

- **`decision.md`**, **`migrations.md`**, **`pii-inventory.md`**, **`explain/*.txt`**, **`restore-test.md`** as described above.

---

## 13. Pitfalls

- Trusting a generated migration without reading it, and shipping a drop-and-add that deletes a column's data.
- Editing an applied migration so environments silently diverge.
- Testing on SQLite while production is Postgres.
- RLS enabled but the app connects as the table owner or a superuser, so no policy applies.
- Setting the tenant with plain `SET` on a pooled connection, leaking it to the next request.
- Floats for money; `timestamp` without time zone; local times without a zone.
- Unindexed foreign keys and unbounded list queries that work in dev with ten rows.
- `SELECT *` exposing a newly added sensitive column.
- Seeds that run in production, or fake rows on a shipped path.
- Claiming backups exist without a restore log.

---

## Done means

**Choice and design**
- [ ] The database choice and reason are written in `reports/data/decision.md` and sent to the lead; any hosted account, paid tier or BAA was requested via `helm_need`, and work continued locally.
- [ ] Every CONTRACT entity and invariant maps to columns and constraints: `NOT NULL`, `UNIQUE`, `CHECK`, FKs with deliberate `ON DELETE`, indexed FK columns.
- [ ] IDs are UUIDv7 or ULID (or a justified alternative); money is integer minor units plus currency; instants are `timestamptz` in UTC.

**Migrations**
- [ ] Every schema change is a versioned, reviewed SQL migration; no shipped migration was edited.
- [ ] Breaking changes use expand, migrate, contract; long-running DDL is non-blocking.
- [ ] Migrations pass from empty and from the previous release fixture, with counts checked.

**Queries and performance**
- [ ] All queries are parameterised; dynamic identifiers come from allowlists.
- [ ] List queries are bounded and paginated; N+1 is ruled out by query-count tests.
- [ ] Each hot query has a justified index and a saved `EXPLAIN` against realistic volume.

**Isolation and privacy**
- [ ] Multi-tenant tables enforce isolation in the database, and cross-tenant tests prove it.
- [ ] The PII/PHI column inventory is complete, with protection, retention and deletion for each.
- [ ] Sensitive fields use field-level encryption with keys outside the database; audit logging exists for sensitive actions.
- [ ] User deletion and (where required) export are implemented and tested across every PII table.

**Recovery and test data**
- [ ] The backup mechanism, RPO and RTO are documented, and a restore drill succeeded and was logged.
- [ ] Seed data is deterministic, obviously fake, separate from migrations, and never on shipped paths.
- [ ] Tests run against the real engine with migrations applied, isolated per test, and constraint tests fail when a constraint is removed.

## Evidence to commit

- `reports/data/decision.md`: database choice, alternatives, reasons, account status.
- `reports/data/er.md`: Mermaid ER diagram matching the current migrations.
- `reports/data/migrations.md`: migration log with type (expand/migrate/contract), locking notes and how each was tested.
- `reports/data/explain/<query>.txt`: `EXPLAIN (ANALYZE, BUFFERS)` or `EXPLAIN QUERY PLAN` output with the seeded row counts.
- `reports/data/pii-inventory.md`: column-level PII/PHI inventory with protection, retention and deletion.
- `reports/data/restore-test.md`: restore drill log (date, method, duration, counts before and after, result).
- `reports/checks/` outputs from `.helm/run-check.sh` for tests and migrations, cited in `helm_report`.

## Sources

- PostgreSQL documentation, Constraints: https://www.postgresql.org/docs/current/ddl-constraints.html
- PostgreSQL documentation, Row Security Policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL documentation, Using EXPLAIN: https://www.postgresql.org/docs/current/using-explain.html
- PostgreSQL documentation, Backup and Restore: https://www.postgresql.org/docs/current/backup.html
- PostgreSQL documentation, Continuous Archiving and PITR: https://www.postgresql.org/docs/current/continuous-archiving.html
- PostgreSQL documentation, CREATE INDEX (CONCURRENTLY): https://www.postgresql.org/docs/current/sql-createindex.html
- PostgreSQL wiki, Don't Do This: https://wiki.postgresql.org/wiki/Don%27t_Do_This
- SQLite, Foreign Key Support: https://www.sqlite.org/foreignkeys.html
- SQLite, Write-Ahead Logging: https://www.sqlite.org/wal.html
- SQLite, STRICT Tables: https://www.sqlite.org/stricttables.html
- SQLite, EXPLAIN QUERY PLAN: https://www.sqlite.org/eqp.html
- RFC 9562, UUIDs (including UUIDv7): https://www.rfc-editor.org/rfc/rfc9562
- Martin Fowler, Parallel Change (expand and contract): https://martinfowler.com/bliki/ParallelChange.html
- OWASP SQL Injection Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- OWASP Database Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html
- Supabase docs, Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase docs, Local development with the CLI: https://supabase.com/docs/guides/local-development
- Prisma docs, Migrate: https://www.prisma.io/docs/orm/prisma-migrate
- Drizzle docs, Migrations: https://orm.drizzle.team/docs/migrations
- Neon docs, Branching: https://neon.tech/docs/introduction/branching
- Firebase docs, Emulator Suite: https://firebase.google.com/docs/emulator-suite
- Testcontainers: https://testcontainers.com/
- HHS, HIPAA Security Rule: https://www.hhs.gov/hipaa/for-professionals/security/index.html
- HHS, Business Associate Contracts: https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html
- GDPR, Article 17 (erasure) and Article 20 (portability): https://gdpr-info.eu/art-17-gdpr/
