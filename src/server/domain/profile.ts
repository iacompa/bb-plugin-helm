// Project profiles (§4.7): what a project is (its kind), what it needs, and which tools its
// agents use. Helm decides all three from the brief with the deterministic rules below
// unless the human or the planner names them, and shows each decision with its reason so the
// human can correct it before Approve. The squad (topology.ts), the craft skills (roles.ts)
// and the brief guidance (briefs.ts) all follow from the profile.

import type { Platform, ProjectKind, ProjectNeed } from "../../shared/types.ts";
import { KIND_LABEL, NEED_LABEL, PROJECT_KINDS, PROJECT_NEEDS } from "../../shared/types.ts";

export interface Profile {
  kind: ProjectKind;
  needs: ProjectNeed[];
  tools: string[];
  platforms: Platform[];
  platformsAssumed: boolean;
  /** Why Helm decided what it did, one short clause per decision ("Website: “online store”"). */
  why: string[];
}

export interface ProfileInput {
  name: string;
  tagline?: string;
  notes?: string | null;
  /** Platforms the human named (empty when none were named). */
  platforms: Platform[];
  kind?: ProjectKind;
  /** Named needs replace the inferred ones (an empty array means "none"). */
  needs?: ProjectNeed[];
  /** Named tools are added to the inferred ones. */
  tools?: string[];
}

export const KIND_INFO: Record<ProjectKind, { desc: string; deliverable: string }> = {
  app: { desc: "Native or cross-platform apps for iOS, Android, macOS and Windows.", deliverable: "a working app on each platform" },
  web: { desc: "Websites and full-stack web apps: frontend, backend, database, deployment.", deliverable: "a working website with its backend, deployable" },
  game: { desc: "Games for mobile, desktop or the web, in an engine such as Unreal, Unity or Godot.", deliverable: "a playable game build on each platform" },
  automation: { desc: "Bots, scheduled jobs, integrations, data pipelines and workflow tools.", deliverable: "automation that runs unattended, safely, with a runbook" },
  review: { desc: "An independent audit of an existing project: a report with evidence, no code changes.", deliverable: "REVIEW.md: findings with evidence and a remediation plan" },
};

export const NEED_INFO: Record<ProjectNeed, string> = {
  database: "Persistent server data: a schema in CONTRACT.md, versioned migrations, indexes for real queries, backups with a tested restore. Develop against a local database (Docker or SQLite); a hosted database needs the human's account.",
  auth: "Accounts: proven auth library or provider, hashed passwords (argon2id or bcrypt), secure sessions, deny-by-default authorization checked on every object.",
  payments: "Payments in test mode only: hosted checkout so card data never touches our servers, webhooks verified and idempotent, entitlements on the server. In-app digital goods use the store's billing. Live keys and real charges are the human's call.",
  security: "Security is a first-class requirement: a threat model, dependency and secrets audits, and findings fixed before Ready.",
  hipaa: "Protected health information: PHI inventory, minimum necessary, encryption at rest and in transit, audit logs, automatic logoff, no PHI in logs, analytics, notifications or AI prompts, and a BAA with every vendor that touches PHI (the human signs those).",
  privacy: "Privacy law (GDPR, CCPA, COPPA): data inventory, consent, export and deletion, retention limits, a privacy policy draft for counsel.",
  realtime: "Live updates (WebSockets or server-sent events): reconnect and resume, ordering, presence, and back-pressure.",
  ai: "AI features: provider keys on the server only, timeouts and cost caps, outputs validated, prompt-injection aware, no personal data sent without approval.",
  automation: "Scheduled jobs, webhooks or integrations: idempotent, retried with backoff, a dry-run mode, alerts on failure, and a runbook.",
  assets: "Art assets (3D, 2D, audio): an asset list with budgets, sources kept next to exports, licences recorded in assets/LICENSES.md.",
  multiplayer: "Online play: an authoritative server, client prediction, reconnects, and cheat resistance. Paid hosting is the human's call.",
};

export interface ToolInfo {
  label: string;
  desc: string;
  /** How agents use it from a terminal. */
  use: string;
  /** Binaries on PATH and app bundle paths (one `*` allowed per path) that mean it is installed. */
  probe?: { bins: string[]; paths?: string[] };
}

/** External programs Helm knows how to check for and brief agents on. Other names are allowed and passed through. */
export const TOOL_INFO: Record<string, ToolInfo> = {
  blender: {
    label: "Blender",
    desc: "3D modelling, rigging, animation and rendering.",
    use: "Run it headless with `blender --background --python <script.py>`; keep .blend sources under assets/source and export glTF or FBX for the engine.",
    probe: { bins: ["blender"], paths: ["/Applications/Blender.app/Contents/MacOS/Blender"] },
  },
  unreal: {
    label: "Unreal Engine",
    desc: "Epic's engine for high-end 3D games.",
    use: "Keep logic in C++ modules, build with the engine's Build script and RunUAT BuildCookRun, run automation tests with UnrealEditor-Cmd -nullrhi, and track .uasset and .umap files with Git LFS.",
    probe: { bins: ["UnrealEditor", "UnrealEditor-Cmd"], paths: ["/Users/Shared/Epic Games/UE_*/Engine/Binaries/Mac/UnrealEditor.app"] },
  },
  unity: {
    label: "Unity",
    desc: "Cross-platform engine for 2D and 3D games.",
    use: "Build and test from the command line with -batchmode -nographics -quit and -executeMethod; pin the editor version in ProjectSettings/ProjectVersion.txt.",
    probe: { bins: ["unity"], paths: ["/Applications/Unity/Hub/Editor/*/Unity.app"] },
  },
  godot: {
    label: "Godot",
    desc: "Open-source engine for 2D and 3D games.",
    use: "Run and export headless with --headless (export presets live in export_presets.cfg).",
    probe: { bins: ["godot", "godot4"], paths: ["/Applications/Godot.app/Contents/MacOS/Godot"] },
  },
  docker: {
    label: "Docker",
    desc: "Containers for local databases and services.",
    use: "Run local databases and services with `docker compose`; never point tests at hosted or production data.",
    probe: { bins: ["docker"] },
  },
  ffmpeg: {
    label: "FFmpeg",
    desc: "Audio and video conversion.",
    use: "Transcode and inspect media with `ffmpeg` and `ffprobe`; commit only small evidence clips.",
    probe: { bins: ["ffmpeg"] },
  },
};

/** BB plugins Helm knows are useful to some projects. Any installed plugin can be named. */
export const PLUGIN_INFO: Record<string, { desc: string; use: string }> = {
  "browser-automation": {
    desc: "Persistent headless or desktop browser sessions.",
    use: "Open the site in a browser session, click through the main flows and take screenshots for evidence (see `bb browser-automation --help`).",
  },
  automations: {
    desc: "BB's scheduled agent and script runs.",
    use: "Can run a finished job on a schedule inside BB (see `bb automation --help`); creating a schedule that acts on real accounts needs the human's approval.",
  },
  github: {
    desc: "Tracked GitHub repositories, issues and pull requests.",
    use: "Read issues and pull requests for context (see `bb github --help`); never push or open pull requests without the human's approval.",
  },
  secrets: {
    desc: "BB's secret store.",
    use: "When the human provides a credential, it lives in BB's secret store or the environment, never in the repository.",
  },
};

/** Plugins Helm never uses or offers (older orchestration plugins Helm replaces). */
export const BLOCKED_PLUGINS = new Set(["agent-graph", "chief", "command-center", "crew", "visual-workflows", "workflows", "helm"]);

const TOOL_ALIAS: Record<string, string> = {
  ue: "unreal",
  ue4: "unreal",
  ue5: "unreal",
  "unreal-engine": "unreal",
  unrealengine: "unreal",
  "unity3d": "unity",
  "godot-engine": "godot",
  "docker-compose": "docker",
  browser: "plugin:browser-automation",
  "browser-automation": "plugin:browser-automation",
  automations: "plugin:automations",
  "bb-automations": "plugin:automations",
};

const TOOL_RE = /^(plugin:)?[a-z0-9][a-z0-9._+-]{0,39}$/;

/** "Unreal Engine" → "unreal", "browser" → "plugin:browser-automation"; null when it cannot be a tool name. */
export function normalizeTool(raw: string): string | null {
  let t = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (!t) return null;
  t = TOOL_ALIAS[t] ?? t;
  if (!TOOL_RE.test(t)) return null;
  if (t.startsWith("plugin:") && BLOCKED_PLUGINS.has(t.slice(7))) return null;
  return t;
}

const NEED_ALIAS: Record<string, ProjectNeed> = {
  db: "database",
  database: "database",
  databases: "database",
  postgres: "database",
  postgresql: "database",
  mysql: "database",
  sqlite: "database",
  supabase: "database",
  firebase: "database",
  backend: "database",
  auth: "auth",
  accounts: "auth",
  account: "auth",
  login: "auth",
  logins: "auth",
  users: "auth",
  "sign-in": "auth",
  payments: "payments",
  payment: "payments",
  stripe: "payments",
  checkout: "payments",
  subscriptions: "payments",
  billing: "payments",
  iap: "payments",
  "in-app-purchases": "payments",
  security: "security",
  secure: "security",
  hipaa: "hipaa",
  phi: "hipaa",
  "health-data": "hipaa",
  privacy: "privacy",
  gdpr: "privacy",
  ccpa: "privacy",
  coppa: "privacy",
  compliance: "privacy",
  realtime: "realtime",
  "real-time": "realtime",
  live: "realtime",
  chat: "realtime",
  websockets: "realtime",
  ai: "ai",
  llm: "ai",
  automation: "automation",
  automations: "automation",
  jobs: "automation",
  cron: "automation",
  webhooks: "automation",
  integrations: "automation",
  assets: "assets",
  art: "assets",
  "3d": "assets",
  sprites: "assets",
  multiplayer: "multiplayer",
  online: "multiplayer",
};

/** "Payments" → "payments", "GDPR" → "privacy"; null when unknown. */
export function normalizeNeed(raw: string): ProjectNeed | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if ((PROJECT_NEEDS as string[]).includes(k)) return k as ProjectNeed;
  return NEED_ALIAS[k] ?? null;
}

const KIND_ALIAS: Record<string, ProjectKind> = {
  app: "app",
  apps: "app",
  "mobile-app": "app",
  "desktop-app": "app",
  "native-app": "app",
  web: "web",
  website: "web",
  "web-site": "web",
  site: "web",
  "web-app": "web",
  webapp: "web",
  "full-stack": "web",
  fullstack: "web",
  saas: "web",
  game: "game",
  "mobile-game": "game",
  "video-game": "game",
  automation: "automation",
  bot: "automation",
  script: "automation",
  pipeline: "automation",
  integration: "automation",
  review: "review",
  audit: "review",
  "code-review": "review",
};

/** A brief segment that names only a kind ("Website", "Game", "Audit"); null otherwise. */
export function kindWord(raw: string): ProjectKind | null {
  const k = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if ((PROJECT_KINDS as string[]).includes(k)) return k as ProjectKind;
  return KIND_ALIAS[k] ?? null;
}

/** Split "database, payments and HIPAA" into words. */
export function listWords(s: string): string[] {
  return s
    .split(/\s*(?:,|;|\+|&|\band\b)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ───────────── inference ─────────────

type Rule = { re: RegExp; label?: string };

const RE = {
  review: /^\s*(?:review|audit|assess|evaluate|critique)\b|\b(?:review|audit)\s+(?:of\s+)?(?:the|our|my|this|an?)\s+(?:existing\s+|current\s+|live\s+)?(?:app|apps|website|site|game|codebase|repo|repository|project|code)\b/i,
  game: /\b(?:game|games|gameplay|platformer|roguelike|roguelite|rpg|fps|shooter|arcade|puzzle game|endless runner|tower defense|idle clicker|unreal|ue5|godot|level editor)\b/i,
  gameUnity: /\bunity\b/i,
  automation: /\b(?:automate|automates|automating|automation|automations|bot|bots|cron|scheduled jobs?|scraper|scraping|etl|data pipeline|webhook relay|zapier|n8n|cli tool|sync job|workflow automation)\b/i,
  web: /\b(?:website|websites|web ?site|web ?app|webapp|landing page|saas|portal|e-?commerce|online store|storefront|blog|marketing site|full[- ]?stack|next\.?js|nuxt|sveltekit|admin panel|web dashboard)\b/i,
  webGame: /\b(?:browser game|html5 game|web game|phaser|three\.?js|babylon\.?js|pixi\.?js)\b/i,
};

const NEED_RULES: Record<ProjectNeed, RegExp> = {
  database: /\b(?:database|postgres(?:ql)?|mysql|sqlite|supabase|firebase|firestore|mongo(?:db)?|backend|server[- ]side|crm|inventory|bookings?|reservations?|orders|admin panel|multi[- ]tenant|saas|marketplace|listings)\b/i,
  auth: /\b(?:log ?in|logins?|sign[- ]?in|sign[- ]?up|user accounts?|accounts|user profiles?|members|membership|roles and permissions|admin panel|auth|authentication|sso|oauth|multi[- ]tenant|saas|portal)\b/i,
  payments: /\b(?:payments?|checkout|stripe|paypal|subscriptions?|billing|paywall|in[- ]app purchases?|iap|e-?commerce|online store|storefront|shopping cart|donations?|marketplace|selling|monetiz\w*)\b/i,
  security: /\b(?:secure|security|encrypted|encryption|password manager|vault|banking|fintech|crypto wallet|zero[- ]knowledge)\b/i,
  hipaa: /\b(?:hipaa|phi|patients?|medical records?|health records?|ehr|emr|clinics?|clinical|telehealth|telemedicine|healthcare providers?|doctors?|physicians?|therap(?:y|ist|ists)|prescriptions?|hospitals?)\b/i,
  privacy: /\b(?:gdpr|ccpa|cpra|coppa|children|kids|minors|personal data|privacy[- ]first|pii)\b/i,
  realtime: /\b(?:real[- ]?time|live (?:chat|updates|collaboration|scores?|tracking|sync)|chat|messaging|collaborative|collaboration|websockets?|presence)\b/i,
  ai: /\b(?:ai|a\.i\.|llm|llms|gpt|claude|openai|anthropic|gemini|chatbot|machine learning|ml model|embeddings?|rag|summari[sz](?:e|es|ing|ation)|transcrib\w*|transcription|generative)\b/i,
  automation: /\b(?:automate|automates|automation|automations|scheduled|cron|webhooks?|zapier|n8n|email digests?|integrations? with|syncs? with|scraper|scraping|etl)\b/i,
  assets: /\b(?:3d|three[- ]d|sprites?|textures?|pixel art|character animations?|animated characters|characters|blender|art assets?|low[- ]poly|voxel|tilesets?|sound effects)\b/i,
  multiplayer: /\b(?:multiplayer|online play|co-?op|pvp|matchmaking|leaderboards?|mmo)\b/i,
};

const NATIVE: Platform[] = ["ios", "and", "mac", "win"];

function hit(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m ? m[0].trim() : null;
}

const q = (s: string) => `“${s}”`;

/** Decide a project's kind, needs, tools and platforms. Pure and deterministic. */
export function inferProfile(input: ProfileInput): Profile {
  const text = [input.name, input.tagline ?? "", input.notes ?? ""].join(" \n ");
  const tagline = (input.tagline ?? "").trim();
  const why: string[] = [];
  const named = input.platforms;
  const nativeNamed = named.some((p) => NATIVE.includes(p));

  // ── kind
  let kind: ProjectKind = "app";
  if (input.kind) kind = input.kind;
  else {
    const review = hit(RE.review, tagline) ?? hit(RE.review, input.notes ?? "");
    const game = hit(RE.game, text) ?? (hit(RE.gameUnity, text) && /\b(?:game|level|player)\b/i.test(text) ? "Unity" : null);
    const auto = hit(RE.automation, text);
    const web = hit(RE.web, text);
    if (review) {
      kind = "review";
      why.push(`Review: ${q(review)}`);
    } else if (game) {
      kind = "game";
      why.push(`Game: ${q(game)}`);
    } else if (named.includes("web")) {
      kind = "web";
      why.push("Website: the web platform was named");
    } else if (auto && !nativeNamed) {
      kind = "automation";
      why.push(`Automation: ${q(auto)}`);
    } else if (web && !nativeNamed) {
      kind = "web";
      why.push(`Website: ${q(web)}`);
    }
  }

  // ── needs
  let needs: ProjectNeed[];
  if (input.needs) needs = [...new Set(input.needs)];
  else {
    const found: ProjectNeed[] = [];
    for (const need of PROJECT_NEEDS) {
      if (need === "automation" && kind === "automation") continue;
      const h = hit(NEED_RULES[need], text);
      if (h) {
        found.push(need);
        why.push(`${NEED_LABEL[need]}: ${q(h)}`);
      }
    }
    const add = (n: ProjectNeed, reason: string) => {
      if (found.includes(n)) return;
      found.push(n);
      why.push(`${NEED_LABEL[n]}: ${reason}`);
    };
    if (found.includes("multiplayer")) add("realtime", "online play needs live updates");
    if (kind === "web" && found.includes("payments")) add("database", "a website that takes payments keeps orders and customers");
    if (kind === "web" && found.includes("auth")) add("database", "accounts on a website are stored on the server");
    if (found.includes("hipaa") && (kind === "web" || found.includes("database"))) add("auth", "health data needs access control");
    if (found.some((n) => n === "payments" || n === "hipaa") && !found.includes("security")) add("security", "payments and health data raise the stakes");
    needs = found;
  }

  // ── tools
  const tools: string[] = [];
  const addTool = (t: string, reason: string | null) => {
    if (tools.includes(t)) return;
    tools.push(t);
    if (reason) why.push(`${toolLabel(t)}: ${reason}`);
  };
  if (/\b(?:unreal|ue5|ue4)\b/i.test(text)) addTool("unreal", "named in the brief");
  if (kind === "game" && /\bunity\b/i.test(text)) addTool("unity", "named in the brief");
  if (/\bgodot\b/i.test(text)) addTool("godot", "named in the brief");
  if (/\bblender\b/i.test(text)) addTool("blender", "named in the brief");
  else if ((kind === "game" || needs.includes("assets")) && /\b(?:3d|three[- ]d|low[- ]poly|voxel|characters|models)\b/i.test(text)) addTool("blender", "3D art is needed and Blender can be scripted headless");
  if (/\b(?:docker|containers?|kubernetes|k8s)\b/i.test(text)) addTool("docker", "named in the brief");
  else if ((kind === "web" || kind === "automation") && needs.includes("database")) addTool("docker", "runs the database locally for development and tests");
  if (/\b(?:ffmpeg|transcod\w*)\b/i.test(text)) addTool("ffmpeg", "named in the brief");
  if (kind === "web" || (kind === "game" && named.includes("web"))) addTool("plugin:browser-automation", "checks pages in a real browser and takes screenshots");
  if (kind === "review" && /\b(?:website|web ?app|site|url)\b/i.test(text)) addTool("plugin:browser-automation", "the audited project is a website");
  if (kind === "automation" && /\b(?:schedul\w*|cron|every (?:day|hour|week|morning|night|monday)|daily|weekly|hourly|nightly)\b/i.test(text)) addTool("plugin:automations", "the job runs on a schedule and BB can run it");
  for (const t of input.tools ?? []) {
    const n = normalizeTool(t);
    if (n) addTool(n, null);
  }

  // ── platforms
  let platforms = [...named];
  let platformsAssumed = false;
  if (!platforms.length) {
    if (kind === "web") platforms = ["web"];
    else if (kind === "game") {
      if (tools.includes("unreal")) {
        platforms = ["mac", "win"];
        why.push("macOS and Windows: Unreal games target desktop unless platforms are named");
      } else if (hit(RE.webGame, text)) platforms = ["web"];
      else platforms = ["ios", "and"];
      platformsAssumed = true;
    } else if (kind === "app") {
      platforms = ["ios", "and"];
      platformsAssumed = true;
    }
    // automation and review: no platforms unless named (a review covers what exists)
  }
  return { kind, needs: order(needs), tools, platforms, platformsAssumed, why };
}

function order(needs: ProjectNeed[]): ProjectNeed[] {
  return PROJECT_NEEDS.filter((n) => needs.includes(n));
}

export function toolLabel(t: string): string {
  if (t.startsWith("plugin:")) return `BB ${t.slice(7)} plugin`;
  return TOOL_INFO[t]?.label ?? t;
}

/** One line for plans and briefs: "Website · Database, Payments · Docker, BB browser-automation plugin". */
export function profileLine(p: { kind: ProjectKind; needs: ProjectNeed[]; tools: string[] }): string {
  const parts: string[] = [KIND_LABEL[p.kind]];
  if (p.needs.length) parts.push(p.needs.map((n) => NEED_LABEL[n]).join(", "));
  if (p.tools.length) parts.push(p.tools.map(toolLabel).join(", "));
  return parts.join(" · ");
}

/** The assumption shown before Approve when Helm decided something the human did not say. */
export function profileAssumption(name: string, p: Profile): string | null {
  if (!p.why.length) return null;
  return `${name}: Helm decided ${profileLine(p)} (${p.why.join("; ")}). Correct it with “· Website”, “· needs payments, HIPAA” or “· tools Unreal” on the line, or tell the planner.`.slice(0, 400);
}

/** Squad members a profile adds or changes are explained in topology.ts; this says what each kind delivers. */
export function kindDeliverable(kind: ProjectKind): string {
  return KIND_INFO[kind].deliverable;
}
