// `bb helm doctor` (§10.1, Phase 0): every probe that is safe without spawning.
// Lives in bb/ because it reads BB directly.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { RealBB } from "./real.ts";
import type { Repo } from "../db/repo.ts";
import { MIGRATIONS } from "../db/schema.ts";
import type { HelmSettings } from "../engine/context.ts";
import { expandHome } from "../engine/context.ts";
import { TOOL_NAMES } from "../agent/tools.ts";
import { TOOL_INFO } from "../domain/profile.ts";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(bb: BbPluginApi, port: RealBB, repo: Repo, settings: HelmSettings, registered: { tools: number; hook: boolean }): Promise<{ ok: boolean; checks: DoctorCheck[]; lines: string[] }> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const attempt = async (id: string, fn: () => Promise<string>) => {
    try {
      add(id, true, await fn());
    } catch (e) {
      add(id, false, e instanceof Error ? e.message : String(e));
    }
  };

  let hostId: string | null = null;
  await attempt("bb.server", async () => {
    const cfg = await bb.sdk.system.config();
    hostId = cfg.primaryHostId ?? null;
    if (!hostId) throw new Error("BB reports no primary host; connect this machine in BB.");
    return `primary host ${hostId} (${cfg.primaryHostPlatform ?? "unknown platform"})`;
  });
  let home: string | null = null;
  await attempt("host.entry", async () => {
    const p = await port.host(hostId).probe({});
    home = p.home;
    if (!p.git) throw new Error("git is not installed on the primary host; Helm needs it for repositories and evidence.");
    const tools = [p.git, p.xcode && `Xcode: ${p.xcode}`, p.gradle && `Gradle: ${p.gradle}`, p.androidSdk ? "Android SDK" : null, p.dotnet && `.NET ${p.dotnet}`].filter(Boolean);
    return `${p.platform}: ${tools.join(" · ")}`;
  });
  // informational: which project tools are installed (a missing one is not a failure)
  try {
    const ask = Object.entries(TOOL_INFO).map(([id, t]) => ({ id, bins: t.probe?.bins ?? [id], paths: t.probe?.paths ?? [] }));
    const { found } = await port.host(hostId).toolProbe({ tools: ask });
    const have = Object.keys(TOOL_INFO).filter((id) => found[id]).map((id) => TOOL_INFO[id].label);
    const missing = Object.keys(TOOL_INFO).filter((id) => !found[id]).map((id) => TOOL_INFO[id].label);
    add("project.tools", true, `${have.length ? `installed: ${have.join(", ")}` : "none of the known tools installed"}${missing.length ? ` · not found: ${missing.join(", ")}` : ""}`);
  } catch (e) {
    add("project.tools", true, `not checked (${e instanceof Error ? e.message : String(e)})`);
  }
  await attempt("catalog", async () => {
    const cat = await port.catalog({ hostId });
    const by = cat.providers.filter((p) => p.available).map((p) => `${p.id} ${cat.models.filter((m) => m.providerId === p.id).length}`);
    if (!cat.models.length) throw new Error(cat.error ? `no models: ${cat.error.code} ${cat.error.detail ?? ""}` : "no models in the catalog");
    return `${cat.models.length} models (${by.join(", ")})${cat.error ? ` · ${cat.error.providerId}: ${cat.error.code}` : ""}`;
  });
  await attempt("database", async () => {
    const v = Number(repo.getMeta("schema_version") ?? (repo.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)?.version ?? 0);
    if (v !== MIGRATIONS.length) throw new Error(`schema version ${v}, expected ${MIGRATIONS.length}`);
    const failed = repo.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'").get() as { n: number };
    return `schema ${v} · ${repo.listRuns().length} runs · ${failed.n} failed side effects`;
  });
  add("agent.tools", registered.tools === TOOL_NAMES.length, `${registered.tools} helm_* tools registered`);
  add("dispatch.hook", registered.hook, registered.hook ? "observing messages typed into Helm threads (always proceeds)" : "not registered");
  add("apps.root", true, home ? expandHome(settings.appsRoot, home) : settings.appsRoot);
  await attempt("capacity", async () => {
    const active = await port.countActive();
    return `${active} threads active on BB now · Helm concurrency ${settings.limits.concurrency}`;
  });
  {
    const c = repo.countErrors(Date.now() - 24 * 3600_000);
    add("errors", c.error === 0, c.error || c.warn ? `${c.error} errors, ${c.warn} warnings in the last 24 h — bb helm errors` : "none in the last 24 h");
  }
  add("bb.threads", true, "thread spawn, lifecycle owner, archive and re-parent behaviour checked against BB 0.46.1 (docs/VERIFY.md)");

  const ok = checks.every((c) => c.ok);
  const lines = [...checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.id.padEnd(14)} ${c.detail}`), "", ok ? "Helm is ready." : "Some checks failed; see above."];
  return { ok, checks, lines };
}
