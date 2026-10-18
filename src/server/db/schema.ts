// Forward-only migrations (§3.4). Statement index = version. Never edit or
// reorder a shipped statement; append new ones.

export const MIGRATIONS: string[] = [
  // 1 — the §3.4 schema, plus the columns the engine needs (marked "+")
  `
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, name TEXT, status TEXT,
  brief TEXT, plan_json TEXT, settings_json TEXT,
  studio_project_id TEXT, apps_root TEXT,
  budget_cap REAL, max_agents INTEGER, concurrency INTEGER, spawns_paused INTEGER DEFAULT 0,
  auto_advance TEXT DEFAULT 'ask',
  created_at INTEGER, started_at INTEGER, ended_at INTEGER,
  dry_run INTEGER DEFAULT 0,                                   -- +
  slots_json TEXT,                                             -- + run slots (frozen at start; later edits are directives)
  limits_json TEXT,                                            -- +
  host_id TEXT,                                                -- +
  directive_seq INTEGER DEFAULT 0, need_seq INTEGER DEFAULT 0, finding_seq INTEGER DEFAULT 0, policy_seq INTEGER DEFAULT 0, -- +
  portfolio_dirty INTEGER DEFAULT 0                            -- +
);
CREATE TABLE IF NOT EXISTS apps(
  id TEXT, run_id TEXT, name TEXT, tagline TEXT, platforms TEXT,
  shape TEXT DEFAULT 'full', manager_node_id TEXT, project_id TEXT, repo_path TEXT,
  stage TEXT DEFAULT 'intake', priority TEXT DEFAULT 'normal',
  fix_round INTEGER DEFAULT 0, pct INTEGER DEFAULT 0, nouns TEXT,
  order_idx INTEGER DEFAULT 0,                                 -- +
  test INTEGER DEFAULT 0,                                      -- +
  slot_overrides_json TEXT DEFAULT '{}',                       -- +
  waived_gates_json TEXT DEFAULT '[]',                         -- +
  contract_version INTEGER DEFAULT 0,                          -- +
  integration_branch TEXT,                                     -- +
  integration_head TEXT,                                       -- + last verified integration commit
  platforms_assumed INTEGER DEFAULT 0,                         -- +
  notes TEXT,                                                  -- +
  PRIMARY KEY(run_id, id)
);
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT, run_id TEXT, app_id TEXT, tier TEXT, role TEXT, platform TEXT,
  parent_id TEXT, thread_id TEXT UNIQUE, status TEXT DEFAULT 'planned', also_lead INTEGER DEFAULT 0,
  slot TEXT, model_json TEXT, model_override INTEGER DEFAULT 0,
  brief_md TEXT, brief_version INTEGER DEFAULT 1, scope_globs TEXT, branch TEXT, environment_id TEXT,
  priority TEXT DEFAULT 'normal', now_line TEXT, topics TEXT,
  tokens INTEGER DEFAULT 0, turns INTEGER DEFAULT 0, cost REAL DEFAULT 0,
  created_at INTEGER, spawned_at INTEGER, ended_at INTEGER, last_activity_at INTEGER, prev_status TEXT,
  touched INTEGER DEFAULT 0,                                   -- +
  warning TEXT,                                                -- +
  first_in_line INTEGER DEFAULT 0,                             -- +
  nudged_at INTEGER,                                           -- + stall watchdog
  last_report_forward_at INTEGER,                              -- + progress digests ≤ 1 per 2 min
  provider_id TEXT,                                            -- +
  PRIMARY KEY(run_id, id)
);
CREATE INDEX IF NOT EXISTS nodes_run_status ON nodes(run_id, status);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(run_id, parent_id);
CREATE TABLE IF NOT EXISTS directives(
  id TEXT, run_id TEXT, ts INTEGER, type TEXT, target_node_id TEXT,
  cascade TEXT DEFAULT 'self', mode TEXT DEFAULT 'steer', policy INTEGER DEFAULT 0,
  text TEXT, value_json TEXT, model_from_json TEXT, model_to_json TEXT,
  affected_json TEXT, actor TEXT DEFAULT 'human', implicit INTEGER DEFAULT 0,
  summary TEXT,                                                -- +
  PRIMARY KEY(run_id, id)
);
CREATE TABLE IF NOT EXISTS directive_recipients(
  run_id TEXT,                                                 -- +
  directive_id TEXT, node_id TEXT, level TEXT,
  world INTEGER DEFAULT 0, state TEXT DEFAULT 'queued',
  outbox_id TEXT, delivered_at INTEGER, ack_at INTEGER,
  notice TEXT,                                                 -- + exact text sent
  ack_note TEXT,                                               -- +
  reminded INTEGER DEFAULT 0,                                  -- +
  flushed INTEGER DEFAULT 0,                                   -- + digest line delivered with a later message
  queued_message_id TEXT,                                      -- + BB queued-message id, for message.dispatched receipts
  PRIMARY KEY(run_id, directive_id, node_id)
);
CREATE INDEX IF NOT EXISTS recipients_node ON directive_recipients(run_id, node_id);
CREATE TABLE IF NOT EXISTS policies(id TEXT, run_id TEXT, text TEXT, scope_node_id TEXT, from_directive TEXT, created_at INTEGER, retired_at INTEGER, PRIMARY KEY(run_id, id));
CREATE TABLE IF NOT EXISTS outbox(
  id TEXT PRIMARY KEY, run_id TEXT, kind TEXT,
  node_id TEXT, payload_json TEXT, idem_key TEXT UNIQUE,
  state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
  created_at INTEGER, done_at INTEGER,
  result_json TEXT                                             -- +
);
CREATE INDEX IF NOT EXISTS outbox_state ON outbox(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS outbox_node ON outbox(run_id, node_id, state);
CREATE TABLE IF NOT EXISTS findings(
  id TEXT, run_id TEXT, app_id TEXT, gate TEXT, rule TEXT, severity TEXT,
  path TEXT, line INTEGER, quote TEXT, why TEXT, fix TEXT, commit_sha TEXT,
  status TEXT DEFAULT 'open', round INTEGER, waiver_directive_id TEXT, created_at INTEGER,
  owner_node_id TEXT,                                          -- +
  PRIMARY KEY(run_id, id)
);
CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY, run_id TEXT, app_id TEXT, name TEXT, command TEXT, status TEXT, exit_code INTEGER, output_ref TEXT, commit_sha TEXT, tier TEXT, ts INTEGER, node_id TEXT);
CREATE TABLE IF NOT EXISTS stage_history(run_id TEXT, app_id TEXT, stage TEXT, entered_at INTEGER, exited_at INTEGER, evidence_json TEXT);
CREATE TABLE IF NOT EXISTS needs(
  id TEXT, run_id TEXT, kind TEXT,
  node_id TEXT, title TEXT, body TEXT, evidence TEXT, options_json TEXT,
  interaction_id TEXT, state TEXT DEFAULT 'open', created_at INTEGER, resolved_at INTEGER, resolution_json TEXT,
  app_id TEXT,                                                 -- +
  dedupe_key TEXT,                                             -- +
  PRIMARY KEY(run_id, id)
);
CREATE INDEX IF NOT EXISTS needs_state ON needs(run_id, state);
CREATE TABLE IF NOT EXISTS node_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, ts INTEGER, kind TEXT, summary TEXT, ref TEXT);
CREATE INDEX IF NOT EXISTS node_events_node ON node_events(run_id, node_id);
CREATE TABLE IF NOT EXISTS comms(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER, from_node TEXT, to_node TEXT, kind TEXT, summary TEXT, directive_id TEXT);
CREATE TABLE IF NOT EXISTS seen_models(provider_id TEXT, model_id TEXT, first_seen_at INTEGER, last_seen_at INTEGER, acknowledged INTEGER DEFAULT 0, PRIMARY KEY(provider_id, model_id));
CREATE TABLE IF NOT EXISTS slot_presets(name TEXT PRIMARY KEY, slots_json TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, run_id TEXT, ts INTEGER, world_json TEXT);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, ts INTEGER, status TEXT, summary TEXT, evidence_json TEXT, verified INTEGER, problems_json TEXT);
CREATE TABLE IF NOT EXISTS verdicts(id TEXT PRIMARY KEY, run_id TEXT, app_id TEXT, gate TEXT, node_id TEXT, commit_sha TEXT, verdict TEXT, summary TEXT, checks_json TEXT, unverified_json TEXT, accepted INTEGER, problems_json TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS hidden_models(provider_id TEXT, model_id TEXT, PRIMARY KEY(provider_id, model_id));
CREATE TABLE IF NOT EXISTS observatory_adopted(run_id TEXT, thread_id TEXT, parent_node_id TEXT, adopted_at INTEGER, title TEXT, PRIMARY KEY(run_id, thread_id));
`,
  // 2 — per-node FYI inbox: digest lines and progress reports that must not wake an idle agent.
  // Flushed with the next message the node receives, or sent on their own while it is active.
  `
CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, ts INTEGER, text TEXT, directive_id TEXT, flushed_at INTEGER);
CREATE INDEX IF NOT EXISTS inbox_node ON inbox(run_id, node_id, flushed_at);
CREATE INDEX IF NOT EXISTS recipients_qmid ON directive_recipients(queued_message_id);
ALTER TABLE needs ADD COLUMN data_json TEXT;
`,
  // 3 — apps anywhere on the host: a named folder or an existing repository (adopted on a
  // Helm branch, the human's checkout untouched), plus read-only reference folders.
  `
ALTER TABLE apps ADD COLUMN target_path TEXT;
ALTER TABLE apps ADD COLUMN reads_json TEXT DEFAULT '[]';
ALTER TABLE apps ADD COLUMN adopted INTEGER DEFAULT 0;
ALTER TABLE apps ADD COLUMN helm_branch TEXT;
ALTER TABLE apps ADD COLUMN user_branch TEXT;
ALTER TABLE apps ADD COLUMN base_commit TEXT;
`,
  // 4 — supervisors steer their reports (helm_direct): the node that issued a directive.
  `
ALTER TABLE directives ADD COLUMN by_node TEXT;
`,
  // 5 — error journal: every failure Helm sees (server, RPC, agent tools, the panel), the
  // last 1000 kept, so problems can be debugged with `bb helm errors` without a screen.
  `
CREATE TABLE IF NOT EXISTS errors(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, source TEXT, at TEXT, run_id TEXT, message TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS errors_ts ON errors(ts);
`,
  // 6 — project profiles: each project's kind (app, web, game, automation, review), its needs
  // (database, payments, HIPAA…) and the tools its agents use (Unreal, Blender, BB plugins).
  `
ALTER TABLE apps ADD COLUMN kind TEXT DEFAULT 'app';
ALTER TABLE apps ADD COLUMN needs_json TEXT DEFAULT '[]';
ALTER TABLE apps ADD COLUMN tools_json TEXT DEFAULT '[]';
`,
  // 7 — names and custom agents: every agent may have a personal name (Gestra the Orchestrator,
  // Amer the Planner); a custom agent the Planner designed has a title, a mission and wake events.
  `
ALTER TABLE nodes ADD COLUMN name TEXT;
ALTER TABLE nodes ADD COLUMN title TEXT;
ALTER TABLE nodes ADD COLUMN charter TEXT;
ALTER TABLE nodes ADD COLUMN wake_json TEXT DEFAULT '[]';
ALTER TABLE nodes ADD COLUMN created_by TEXT;
`,
  // 8 — hands-off: a card the Orchestrator decides instead of the human (autonomy high), and the
  // install ledger: what the Git agent installed, where, why and for which agents.
  `
ALTER TABLE needs ADD COLUMN handler TEXT;
CREATE TABLE IF NOT EXISTS installs(id TEXT, run_id TEXT, what TEXT, where_path TEXT, state TEXT, needed_by_json TEXT DEFAULT '[]', command TEXT, note TEXT, by_node TEXT, created_at INTEGER, done_at INTEGER, PRIMARY KEY(run_id, id));
`,
];
