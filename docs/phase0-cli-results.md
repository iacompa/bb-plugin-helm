# Helm Phase 0: BB CLI platform experiments

- BB version: 0.46.1 (`bb --version`)
- Date: 2026-10-16 (local) / 2026-10-17 UTC
- Agent threads spawned: **3** (budget 6). All of them used `--provider claude-code --model claude-haiku-5-5 --reasoning-level low`.
- Scratch: `$TMPDIR` = `/tmp/<sandbox>` (resolves to `/private/tmp/<sandbox>`)
- Timestamps are epoch ms from `bb thread log --json`.

---

## V8: Provider model catalog shape

**Result:** confirmed (the shape is known). Refuted: there is no legacy, hidden or release-date marker.

**Evidence**

`bb provider list --json`: a bare array. Top-level keys per provider:
`available, capabilities, completedTurnDisplay, composerActions, displayName, [family], [extensionKinds], id, logoUrl, maintenance{health,usage,installation}, pluginId, reasoningLevels[{id,label,description?}], serviceTiers[{id,label}], strings`.
`capabilities` = `{supportsThreadArchive, supportsThreadRename, supportsServiceTier, supportsNativeUserQuestion, permissionModes[], supportsFork, supportsSessionRewind, modelCatalogScope:"host"}`.

| provider | reasoningLevels | serviceTiers | permissionModes |
|---|---|---|---|
| codex | none, low, medium, high, xhigh, max, ultra | default, fast, ultrafast | accept-edits, auto, full |
| claude-code | low, medium, high, xhigh, ultracode, max | default, fast | accept-edits, auto, full |
| acp-cursor / acp-grok | low..max | default, fast | accept-edits, full (no `auto`) |

`bb provider models codex --json` / `bb provider models claude-code --json`: a bare array. These are the only keys used across all entries:
`id, model, displayName, description, supportedReasoningEfforts[{reasoningEffort, description}], defaultReasoningEffort, supportedServiceTiers?[{id,label,description}], isDefault`.

- codex: 7 models. `isDefault` = gpt-6.1-sol. Every codex model lists `supportedServiceTiers:[{id:"fast", description:"2x speed, increased usage"}]`. The luna models do not offer `ultra` effort.
- claude-code: 12 models. `isDefault` = claude-sonnet-5-5. **No model has a `supportedServiceTiers` key**, even though the provider-level `serviceTiers` lists default and fast. `claude-haiku-4-5-20251001` supports only `low`. `claude-opus-4-6` and `claude-sonnet-4-6` lack xhigh and ultracode.
- Age signal: the only place age appears is free text in `description`. Codex says "Previous generation…" or "Older generation…". Claude says nothing. No `legacy`, `hidden`, `deprecated` or `releaseDate` field exists (grep found none).
- `--selected-model <model>` ("Include a selected-only model if it matches") changed nothing for gpt-5.5, gpt-5-codex, claude-haiku-4-5, claude-sonnet-4-5 or a bogus id. The list stayed at 7 and 12 entries. Selected-only models therefore exist as a concept, but no hidden ones surfaced here.

**Implication:** the Helm model picker has to rely on `isDefault`, the catalog order and the `supportedReasoningEfforts` of each model. It cannot filter "legacy" models from data. A curated allowlist or a description heuristic would be needed for that, and the heuristic is fragile. Validate the service tier per model for codex and per provider for claude-code. Reasoning levels are provider-specific (`ultra` vs `ultracode`, codex `none`), so always validate against the chosen model's list.

---

## V9: Does `--new-environment worktree` need a git project?

**Result:** confirmed. Yes, it needs git, and the spawn is refused up front without starting an agent.

**Evidence**
```
bb project create --name helm-phase0-git   --root /tmp/helm-p0-git   --json  -> proj_…
bb project create --name helm-phase0-nogit --root /tmp/helm-p0-nogit --json -> proj_…
bb thread spawn --project proj_… --new-environment worktree --provider claude-code \
  --model claude-haiku-5-5 --reasoning-level low --permission-mode auto --prompt-file ok.txt --json
Error: Failed to create thread: HTTP 409: This project checkout has no usable git branch.
{"ok": false, "error": {"code": "error", "message": "Failed to create thread: HTTP 409: This project checkout has no usable git branch."}}
exit=1   (returned in under 1s)
bb thread list --project proj_… --include-hidden --json  -> []   (no thread record created)
```

**Implication:** Helm can attempt a worktree spawn and catch the 409 (`code:"error"`, message text only, no specific code), or pre-check the project, without burning an agent. Because there is no dedicated error code, matching on the message text is brittle. Prefer a pre-flight check: `bb thread show` env `isGitRepo`, or `git rev-parse` on the project source path. Fall back to `personal` or the shared environment for non-git projects.

---

## V2: What the parent receives when a child finishes

**Result:** changed. Each child turn completion delivers a `[bb system]` message that **starts a full new agent turn in the parent** (or steers into a running one), about 2 s after the child's turn ends. These notifications cascade up the tree.

**Evidence** (P = thr_…, C = thr_…, G = thr_…)

P log seq 30 (`client/turn/requested`):
```
source:"tell", initiator:"system", senderThreadId:null,
systemMessageKind:"child-completed",
systemMessageSubject:{kind:"thread", threadId:"thr_…", threadName:"helm-p0-C",
                      outcomes:[{threadId:"thr_…", status:"completed"}]},
target:{kind:"new-turn"}, execution:{model:"claude-haiku-5-5", reasoningLevel:"low", permissionMode:"auto"}
input text:
"[bb system]\n\n@thread:thr_… completed:\n\nDONE\n\nI created `child.txt` in the working directory with ... The file has no trailing newline."
```
- The text is `[bb system]\n\n@thread:<id> completed:\n\n<child's full final agent message>`. It includes a mention resource `{kind:"thread", threadId, projectId, label}`.
- Timing: C `turn/completed` at 1792202366086, then P `client/turn/requested` at 1792202368106, then P `turn/started` at 368115. That is a **~2.0 s delay**, and the same ~2.03 s showed up for G→C and C(2nd)→P, which suggests a fixed debounce.
- P (Haiku) then ran its own tool calls to verify `child.txt` (`ls -la child.txt`, `find ...`). It failed to find the file because C had a different worktree (see V6), and it wrote a long reply.
- **Cascade:** G finished → C got `child-completed` (seq 38, `new-turn`) → C replied → that reply's completion produced a **second** `child-completed` to P (seq 42). It arrived while P was mid-turn, with `target:{kind:"auto", expectedTurnId:"da44e6de04-t2"}`. P logged `turn/input/accepted` with no new `turn/started`, so the message was steered into the running turn.
- Other system kinds seen: `ownership-assigned` (to the new parent) and `ownership-removed` (to the old parent) after `bb thread update --parent-thread`. Each also started a full turn, which in turn triggered another `child-completed` from C to P (P seq 78 and 95; C seq 53).
- Cost: each notification turn on Haiku re-read about 28–33k context tokens (mostly cache reads). P's total went from 29.5k tokens (its own task) to 193k tokens after the 4 notification turns.
- The only thread outcome status seen was `completed`. Per `bb guide`, the parent also gets notified on failure and interruption.

**Implication:** if Helm's orchestrator is itself an agent thread with agent children, every child turn, and every grandchild turn relayed through its parent, wakes and bills the orchestrator. A naive tree causes notification storms and ping-pong ("noted…" replies that notify further up). Options:
- (a) Do not parent workers to an agent thread. Track them from plugin or server code by watching logs or `bb thread wait`, and keep `parentThreadId` null or point it at a non-agent anchor.
- (b) Keep trees one level deep, and instruct workers to never reply to `[bb system]` notifications. This is fragile.
- (c) Use the `systemMessageKind` / `systemMessageSubject` structure to parse outcomes programmatically.

Also expect a ~2 s latency between a child finishing and the parent noticing.

---

## V6: Child permission mode vs parent

**Result:** confirmed. The explicit child request wins (the child got `full` under an `auto` parent), and the shell command ran.

**Evidence**
- `bb thread get --json` exposes **no** permission-mode field. `bb thread options <id> --json` returns `{"options": null}`. The only record is in the log: `client/turn/requested.data.execution.permissionMode`.
- P seq 1: `"permissionMode": "auto"`. C seq 1: `"permissionMode": "full"`. G seq 1: `"permissionMode": "full"`. C's later system-initiated turns also used `full` (grep counted 2× `full` in C's log and 3× `auto` in P's log).
- C ran `printf 'hi' > child.txt && cat child.txt` with `exitCode:0`, `approvalStatus:null`, output `hi`. The file exists at `.../worktrees/thr_…-1/helm-p0-git/child.txt`.
- `bb guide threads`: "Subagents inherit the parent's permission mode by default… Explicit requests and a thread's recorded mode take precedence; nesting a thread does not cap its permissions. The host permission ceiling still applies."
- **Side finding (important):** C and G were spawned with no `--environment` or `--new-environment`, and each got its **own new worktree**, from the remembered project default (`env_…` and `env_…`, branches `bb/helm-p0-c-…` and `bb/helm-p0-g-…`). They did not share P's `env_…`. That is why P could not see child.txt.

**Implication:** Helm must pass the permission mode explicitly for every spawn. Nesting gives no safety cap, so Helm needs its own policy if it wants children to be at most as permissive as their parent. To read a thread's effective mode, Helm has to parse the latest `client/turn/requested.execution` from the log, or record it in its own state. To share a workspace, pass `--environment <parent env id>` explicitly. Otherwise each child gets a separate worktree.

---

## V20: Does archiving the parent cascade?

**Result:** confirmed. Archiving P archived C and G in the same call, with the same `archivedAt`.

**Evidence**
```
bb thread archive thr_… --json
{"ok": true, "threadId": "thr_…", "archivedThreadIds": ["thr_…", "thr_…", "thr_…"]}
thread get after 3s:
thr_… P status=idle archivedAt=1792202496909 owner=None             env=ready/retiring
thr_… C status=idle archivedAt=1792202496909 owner=thr_…   env=ready/retiring
thr_… G status=idle archivedAt=1792202496909 parent=P owner=thr_… env=ready/retiring
environment lifecycle: {"phase":"retiring","retireAt":1792202796917}   (= archivedAt + 300 s grace)
```
- Docs: `bb guide thread-lifecycle` says "bb thread archive [id] — Archive a thread (and children/hidden forks)". It also says "Archive is not a hard stop: for 30 seconds a running turn and the thread's terminals keep going". `bb guide threads` (Lifecycle ownership) adds: "Ownership is immutable. Archiving the owner archives and stops its dependents; deleting it deletes them… Stop does not cascade."
- Caveat: by archive time G had been reparented to P (V10), so G was both a child of P and lifecycle-owned by C, which was owned by P. This run cannot tell which rule archived G. The docs say both rules cascade.
- `bb thread stop` was run explicitly on all three afterwards (each returned `{"ok":true}`), because stop does not cascade.
- Gotcha: `bb thread list --project <p> --include-hidden --json` **without** `--archived` still returned the 3 archived threads. Filter on `archivedAt` client-side.

**Implication:** Helm can clean up a whole tree with one `archive` on the root, and `archivedThreadIds` gives the exact set to then `stop`. Worktrees are retired after a ~5 min grace window, and `restore-environment` can rebuild them. Since ownership is immutable, set `--lifecycle-owner-thread` correctly at spawn time.

---

## V10: Re-parent an idle thread

**Result:** confirmed, with side effects. `parentThreadId` can be changed, but `lifecycleOwnerThreadId` cannot, and both the old and new parents get woken.

**Evidence**
```
bb thread update thr_… --parent-thread thr_… --json   -> exit 0
get: {status:"idle", parentThreadId:"thr_…", lifecycleOwnerThreadId:"thr_…", visibility:"hidden"}
bb thread list --parent-thread thr_… --include-hidden  -> [G, C]
G log seq 30: system/operation {operation:"ownership_change", message:"Thread transferred to new parent",
  metadata:{action:"transfer", previousParentThreadId:"thr_…", nextParentThreadId:"thr_…", ...}}
P: systemMessageKind "ownership-assigned", text "[bb system]\n\n@thread:thr_… is now a child of this thread." -> new turn
C: systemMessageKind "ownership-removed",  text "[bb system]\n\n@thread:thr_… is no longer a child..." -> new turn
   -> C's reply then produced another child-completed into P (P seq 95, new turn)
```
`bb thread update` flags: `--title, --parent-thread, --clear-parent-thread, --section, --clear-section, --model, --reasoning-level, --visibility`. There is no lifecycle-owner flag.

**Implication:** reparenting works for UI and notification routing, but it costs up to 3 extra agent turns when both parents are agents. It does not move archive/delete ownership. Helm should choose parent and owner at spawn time and avoid reparenting agent-parented threads.

---

## V13: Worktree creation cost

**Result:** confirmed. Worktrees are cheap for a tiny repo. Real repos will scale with checkout size.

**Evidence** (repo = 1 commit, 1 file, `du -sh .` = 212K)
```
20 × git worktree add -q -b wtN $TMPDIR/helm-p0-wt/wtN   -> 0.775 s total (~39 ms each)
du -sh $TMPDIR/helm-p0-wt                                -> 160K
20 × git worktree remove + git branch -D                 -> 0.799 s total
```
BB's own worktree provisioning, from `system/thread-provisioning` events (first event to `status:"completed"`):

| thread | provisioning | spawn → `turn/started` | spawn → first `turn/completed` |
|---|---|---|---|
| P | 422 ms | 670 ms | 3.2 s |
| C | 308 ms | 572 ms | 6.3 s (one shell call) |
| G | 291 ms | 531 ms | 2.2 s |

BB worktrees live at `~/.bb/plugins/environment-git-worktree/host-data/worktrees/<threadId>-1/<repoName>`, on branch `bb/<slug(title)>-<threadId>`. P's env `createdAt` → `updatedAt` was 400 ms.

**Implication:** environment overhead is negligible next to agent turn time for small repos. For large repos, cost is dominated by checkout size (one full working-tree copy per worker; the `.git` object store is shared), so measure on the real target repo before giving every worker its own worktree.

---

## V14: Per-thread spend from bb--provider-usage

**Result:** refuted for per-thread spend. Provider usage gives account-level quota windows only. Per-thread **token** counts exist in thread logs and context, but there are no dollars.

**Evidence**
- `bb plugin list`: `bb--provider-usage@0.1.0 running (source: builtin:provider-usage)`. It contributes **no CLI command**. `bb usage` and `bb provider usage` both fail with `error: unknown command 'usage'`. `bb plugin rpc list bb--provider-usage` returns "No discoverable RPC methods." (A third-party `usage-tracker@0.1.9` plugin is also installed and running. It has no RPC methods and was not investigated further.)
- The usage API is exposed by the **provider plugins** as RPC: `provider-claude-code`, `provider-codex` and `provider-acp` each offer `provider-usage.v1.listResources` and `provider-usage.v1.getResource`.
  ```
  bb plugin rpc call provider-claude-code provider-usage.v1.listResources --input-file {} --json
   -> {resources:[{accountKey:"anthropic:account:…", id:"[\"host_…\",\"claude-code\"]", providerId, label, scope:{kind:"host",hostId,hostName}}]}
  bb plugin rpc call provider-claude-code provider-usage.v1.getResource --input-file {"resourceId":"…","refresh":false} --json
   -> {accountKey, observedAt, usage:{status:"ok", plan:{id:"max",multiplier:20}, planLabel:"Max (20x)", accountEmail:<redacted>,
       windows:[{kind:"five-hour",label:"Current session",usedPercent:10,resetsAt,model:null,cost:null},
                {kind:"weekly",label:"Weekly limit",usedPercent:3,...},{kind:"weekly",label:"Fable",model:"fable",usedPercent:0,...}]}}
  ```
  The output is per account and per host, as percentages of windows. `cost` was null.
- Per-thread data that does exist:
  - `thread/tokenUsage/updated` events in `bb thread log --json` carry `tokenUsage.total` / `.last` = `{totalTokens, inputTokens, cachedInputTokens, cacheReadInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}` plus `modelContextWindow`.
  - `bb thread context <id> --json` returns a context-window snapshot (usedTokens, contextWindowTokens, autoCompactAtTokens, categories). That is current context size, not cumulative spend.
  - `provider/rateLimits/updated` events also appear in logs (not inspected).

**Implication:** Helm's budget enforcement has to be token-based. Sum the latest `thread/tokenUsage/updated.total` per thread and apply Helm's own price table per model if dollars are wanted. Account-window `usedPercent` from `provider-usage.v1.getResource` can serve as a global circuit breaker. Do not build on a `bb usage` command; there is none.

---

## V11: `bb helm`

**Result:** confirmed. It is an unknown command (Helm is not installed).

**Evidence**
```
bb helm
error: unknown command 'helm'
Commands: browser, status, settings, project, prompt-history, provider, machine, server, updates, terminal, thread, environment, file, theme, plugin, marketplace, skill, guide, diagnostics, voice
Plugins add commands only while they are installed and enabled. If 'helm' is a plugin command, check `bb plugin list`.
```

**Implication:** the `helm` top-level command name is free for the plugin to register.

---

## Thread JSON field names and pluginMetadata

**Evidence**
- `bb thread get <id> --json` top-level keys: `thread, environment, pendingTodos`.
  - `thread` keys: `activeBackgroundAgentCount, archivedAt, canRestoreEnvironment, canSpawnChild, createdAt, deletedAt, environmentId, id, lastReadAt, latestAttentionAt, lifecycleOwnerThreadId, originKind, originPluginId, parentThreadId, pinnedAt, projectId, providerId, queuedMessageCount, runtime{displayStatus}, sectionId, sourceThreadId, status, title, titleFallback, updatedAt, visibility`.
  - `environment` keys include: `id, name, projectId, hostId, path, isGitRepo, isWorktree, branchName, baseBranch, defaultBranch, mergeBaseBranch, status, environmentProviderId, lifecycle{phase,retireAt,teardown}, hostLifecycle, environmentProviderSelection, environmentProviderInstanceKey, managed, workspaceProvisionType, createdAt, updatedAt, pullRequest`.
- `bb thread list --json` element keys: `activity{activeBackgroundAgentCount, activeBackgroundCommandCount, activeGoalCount, activePlanModeCount, activeWorkflowCount}, archivedAt, createdAt, deletedAt, environmentBranchName, environmentHostId, environmentId, environmentIsWorktree, environmentName, environmentPath, environmentProviderId, environmentWorkspaceDisplayKind, hasPendingInteraction, id, lastReadAt, latestAttentionAt, lifecycleOwnerThreadId, originKind, originPluginId, parentThreadId, pinSortKey, pinnedAt, projectId, providerId, queuedWork, runtime, sectionId, sourceThreadId, status, title, titleFallback, updatedAt, visibility`.
- **`pluginMetadata` appears in neither get nor list** (grep count 0 for both). Model, reasoning level and permission mode are also absent from get and list. They only appear in log `execution` blocks.
- `originPluginId` / `originKind` exist (null for CLI-spawned threads). They are likely set when a plugin spawns through the SDK, but that is not verified here.

**Implication:** Helm cannot stash state on thread records through the CLI. It needs its own store keyed by thread id. `originPluginId` might mark Helm-spawned threads when spawning through the Plugin SDK; verify that in a later phase.

---

## Created resources and final state

| thread | role | env | final state |
|---|---|---|---|
| thr_… | P (visible, auto, worktree) | env_… | archived (1792202496909), stopped, idle; env retiring |
| thr_… | C (hidden, full, parent+owner P) | env_… | archived (cascade), stopped, idle; env retiring |
| thr_… | G (hidden, full, owner C, reparented to P) | env_… | archived (cascade), stopped, idle; env retiring |

- **Agent threads spawned: 3** (≤ 6). The V9 non-git spawn was rejected before any thread or agent was created.
- **Projects created:** `proj_…` (helm-phase0-git, `/tmp/helm-p0-git`) and `proj_…` (helm-phase0-nogit, `/tmp/helm-p0-nogit`). Both are still registered. Delete them with `bb project delete <id>` when they are no longer needed.
- The 20 plain git worktrees from V13 and their branches were removed (`git worktree list` shows only main and the 3 BB worktrees, which BB retires on its own).
