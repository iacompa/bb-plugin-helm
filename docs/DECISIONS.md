# Helm — decisions

The open decisions from the brief (§17.2) took their defaults. Where reality on this machine (BB 0.46.1, plugin SDK 0.6.49) differed from the brief, the deviation is recorded here with the evidence that forced it.

## Defaults taken (§17.2)

| # | Decision | Taken | Where it lives |
|---|---|---|---|
| D1 | One repo per app | one git repo **and** one BB project per app, plus one Studio project per run | `engine.handleProject` |
| D2 | Where apps live | `~/Projects/helm/<run-slug>/<app>`; the Studio at `<run-slug>/_studio`. `~` is expanded with the host's real home (host-entry `probe`) | settings `appsRoot` |
| D3 | Visibility | Orchestrator visible; everything else hidden. Setting "Show App Leads in the BB sidebar" makes leads visible | `engine.handleSpawn` |
| D4 | Wave approval | `ask`. Later waves become a `plan` card in Needs you | settings `autoAdvance` |
| D5 | Squad shape | Full | `domain/topology` |
| D6 | SPEC approval | off | — |
| D7 | Fix rounds | 2, then a `slop`/`failed` card asks the human | settings `fixRounds` |
| D8 | Test agent | off (per-app option) | — |
| D9 | Permission mode | `auto` for every tier, one setting per tier. V6 showed the explicit request wins and nesting gives no cap, so Helm always passes the mode | settings `permission*` |
| D10 | Git remotes | off | settings `createRemote` |
| D11 | Planner model | the `code` slot's model at `medium` | wizard (Phase 4) |
| D12 | Windows/Android Ready without local verification | allowed; the sign-off card names the CI-tier platforms and sign-off records the acceptance note (`bb helm signoff <app> --accept "<note>"`) | `gates.tryReady` |

## Deviations from the brief

1. **SDK version.** The brief was written against an earlier SDK. This build targets `@get-bb/plugin-sdk` 0.6.49 on BB 0.46.1. Exact shapes are in `docs/SDK-NOTES.md`.

2. **No native parent links (V2).** In Phase 0, each child turn completion sent a `[bb system] child-completed` message that started a **full new turn in the parent** about 2 s later, and it cascaded up the tree. One Haiku parent went from 29.5k to 193k tokens in four such turns. Helm therefore spawns every non-Orchestrator node **without `parentThreadId`** and sets only `lifecycleOwnerThreadId` to its parent's thread. Archive cascades still follow ownership (V20). Reports travel through `helm_report`; Helm forwards them as one compact message, with verified evidence, only on `done`, `blocked` or `failed`.

3. **FYI inbox, not wake-ups.** Digest lines (directive notices at `digest` level) and progress reports **never wake an idle agent**. They are stored in Helm's inbox for that node. They ride along at the top of the node's next message, are flushed within about 20 s (coalesced) while the node is active, and always appear in `helm_context` / `helm_digest`. A digest recipient's receipt is `rec` as soon as the line is recorded. This is the brief's "notice spam" risk (§17.3-8) taken one step further, because every wake costs a whole-context turn (V2).

4. **Stop and pause are delivered by the action itself.** For a `stop`, the stop call is the delivery: every node it covers is marked delivered when BB accepts the stop, or failed after retries. No notice message is sent, because a message would start a new turn in a thread being stopped. A `pause` steers a notice only into a running node; an idle node's pause is held and marked delivered. Stops and pauses never get "please helm_ack" reminders. A thread Helm has stopped ignores a late `thread.active` that was emitted before the stop landed; Helm checks with `threads.get` once, on that event only.

5. **Branch names come from BB.** BB names managed-worktree branches itself (`bb/<slug>-<threadId>`, Phase 0 V13). Helm does not choose branch names. It reads each node's branch from `environments.get` after spawn. The lead's branch is the app's **integration branch**. Gates spawn on a worktree off that branch and are told to `git checkout --detach <commit>`. A gate's worktree must stay clean at that commit (read-only check, §5.3).

6. **Cost is in relative units only (V14).** `provider-usage` exposes account-level quota windows, not per-thread spend. Helm counts tokens per node from `threads.context` at each idle and prices them with relative per-model weights (settings "Pricing weights"). The budget cap is in the same units. Dollars are never shown.

7. **No "older models" toggle (V8).** The catalog has no legacy, hidden or release-date markers. NEW badges come only from Helm's own `seen_models` table. Hiding a model is a per-user choice stored by Helm.

8. **Helm keeps its own capacity bookkeeping.** `threads.count` counts every thread on the machine, including the user's own work. Helm's concurrency cap counts Helm's running nodes plus its pending spawns, from its own database. BB's built-in `concurrency-limit` plugin still applies on top; the stricter one wins.

9. **Git runs in a host entry (V16).** The plugin server never shells out. `host.ts` is a BB host entry that runs inside the host daemon and exposes a typed contract (`src/shared/host-contract.ts`): `ensureRepo`, `revParse`, `isAncestor`, `fileAt`, `status`, `readFile`, `writeFile`, `log`, `scan`, `probe`. It uses `execFile` with no shell, sanitised refs and paths, and timeouts. `ensureRepo` never overwrites an existing file.

10. **Waves are batched.** Admission is dynamic (§4.2), but proposing a wave every time a single app finished produced 16 approval cards for the 20-app sample. With `ask`, Helm proposes the next wave only when at least half the in-flight slots are free, the remaining queue fits, or nothing is in flight. Only one wave card is open at a time; a bigger proposal replaces a smaller one. The 20-app simulation now asks 8 times. With `auto`, every free slot is filled at once.

11. **Completing a run needs confirmation.** When every app is signed off or cancelled, Helm raises a `decision` card, "Every app is signed off — complete the run?". Approving it stops and archives everything, including the managers and the Orchestrator (§9.10, "after confirmation"). `bb helm complete --yes` does the same. Repos, branches and worktrees are never deleted.

12. **`--json` is declared per command.** BB's CLI parser rejects `--json` on any command that does not declare it (`unknown option '--json'`). It adds the `{ok:false,error}` envelope only for errors. Every `bb helm` command therefore declares a `json` flag.

13. **CLI files are read by the plugin server.** `--brief-file` and `--message-file` are resolved against the caller's working directory and read with `fs` in the server process. That is correct for a local BB (one machine, v1 scope, §17.1). A remote server would need these read through the host instead.

14. **Stall detection is database-only.** The watchdog runs every 5 minutes (`bb.background.schedule`). It reads only Helm's `nodes` table (`last_activity_at`, `nudged_at`) and asks BB nothing. A silent node is nudged once, then raised as `stalled`.

15. **Questions to the Orchestrator are not directives.** Text typed into the Orchestrator's thread that reads as a question (ends with `?`, or starts with what/which/how/why/status/…) is logged as a question. Anything else typed into any Helm thread becomes an implicit `tell` directive that informs the chain (V18).

16. **A lead can release squad members (found in smoke run 2).** The planned squad comes from the app's shape, but the SPEC can make a member pointless. In the second live run, a CLI-only app got a UI builder that correctly refused to invent a GUI, so Build → Integrate waited forever for a verified "done" that could never come. `helm_spawn_squad` now also takes `release: [{role, platform?, reason}]`. Helm stops the member (it is not archived until sign-off), records the reason on the node, never re-admits it, and Integrate stops waiting for it. A builder the human stopped is not waited for either. (The tool count was 17 then; `helm_existing_docs`, DECISIONS 24, made it 18.)
    The same run exposed an evidence hole: the cancelled builder reported `done` citing the commit its worktree started from, and Helm accepted it because that commit is on its branch. Helm now records the integration-branch commit when it spawns each specialist. A specialist's `done` must cite at least one commit that is not already contained in that base; otherwise the report is unverified, and the refusal points to `blocked` plus a lead release.

17. **S5 blocks Ready only when it logs user data, and CLI output is not S5 (found in smoke run 2).** Appendix B marks S5 zero-tolerance only "if it logs user data". Helm had treated every S5 major as blocking, and the scanner flagged a Swift CLI's `print` calls in `main.swift`, its actual output. The lead started rewriting correct code to dodge the gate. Now the gates use one predicate, `blocksReady`: zero-tolerance categories come from the setting, at blocker or major, and S5 only at blocker. The scanner also skips plain output in command-line entry points (`bin/*`, `cmd/*`, `cli/*`, `main.swift`, `main.go`, `main.rs`, `__main__.py`, `cli.ts|js|py`) unless the line touches user data. The planted-fixture thresholds still hold, and the Slop Hunter still judges every S5 it sees.

18. **A gate's pass closes its own earlier findings (found in smoke 2).** When the same gate accepts a `pass` on a newer commit than a finding's, Helm marks the finding `fixed`, linked to the passing verdict, and emits `finding.updated`. Scanner findings were already closed by re-scans (`syncScanFindings`). Findings at the judged commit itself, and findings of the other gate, are untouched.

19. **The planner (§7.7).** A brief in the structured shape is parsed deterministically. Anything else starts **one hidden planner thread** on the chosen model (D11 default: the `code` slot at `medium`). It runs in a scratch BB project at `<appsRoot>/_planner`, a folder with only a README and `.gitignore`, because BB needs a project to run a thread and a run's Studio does not exist yet. Its only tool is `helm_propose_plan`. Authority is the planner record for its thread id, not its metadata. The portfolio is validated with `PortfolioSchema` and then `planTopology`, and a rejection returns the reason so the planner can correct it in the same turn. When its turn ends (BB's `thread.idle`/`failed` event), it is either done, with the portfolio stored, or failed, with the reason. Either way Helm stops and archives it. `bb helm plan` waits up to 150 s for the result, driven by the session's completion with only a deadline timer. After that it prints the planner id and the exact `--planner <id>` command to continue. Questions the planner raises (at most 3) are printed, and in the wizard they become chips. A missing planner model is never substituted.

20. **Replacement threads and hand-overs.** Retrying a node whose thread is gone (reconcile wrote "thread missing", or the thread was archived outside Helm) used to send a retry message to the dead thread, which failed forever. Now:
    - The node gets a **new thread**. Its spawn key carries the generation (`…:<node>#2`), and the V17 lookup never adopts an archived thread, so the old one cannot be picked up again.
    - The new thread's brief starts with a **hand-over** built from Helm's records: the predecessor's last reports and their verified evidence, never a transcript.
    - A replacement **lead** branches from the existing integration branch, and its own branch then becomes the integration branch, so merged work is kept.
    - Send-back gate respawns now clear the old branch. Before, `branch: undefined` was a no-op, and the new gate's branch was never recorded.
    - Found while mapping crew's hand-over feature (ABSORPTION.md).

21. **No notifications (gap, by necessity).** Plugin SDK 0.6.49 has no API for posting a BB notification or a sidebar badge. `experimental_sidebarAccessory` is declared, but its docs say no host surface mounts it yet. Needs raised by Helm itself (plan, sign-off, budget, stalled, failed) therefore show only in Helm's Needs-you, the live count in Helm's top bar, `bb helm needs`, and the Orchestrator's world state. They are not pushed to the OS. When BB adds a notification surface, `raiseNeed` is the single place to call it.


22. **Apps can live anywhere on the host.** An app may name its own folder: in a structured brief, a `·` segment that starts with `/`, `~/` or a drive letter (`- Tide — breathing app · iOS · /Volumes/Work/apps/tide`), in the planner's `path`, or in the wizard's Folder field. `· reads /a, ~/b` lists read-only folders that its agents may read and never change (shared code, design systems). `bb helm plan --root` (or the wizard's "New app folders go under") moves the run folder for apps without their own folder. Path words never count as platforms, so `/Volumes/mac-ssd` is not macOS. Helm refuses, as plan problems that block the start:
    - the root of a disk, the home folder itself, the top of a mounted volume, and operating-system folders (`src/shared/paths.ts`);
    - two apps whose folders overlap;
    - a folder inside another repository, existing or to be created;
    - a non-empty folder that is not a git repository (the human runs `git init` themselves);
    - a repository with no commits;
    - a missing read-only folder (an unmounted disk);
    - a folder the host cannot create.
    `bb helm plan` prints, for every folder, what will happen. `helm_world` shows each app's `where`, so the Orchestrator and Managers can check that work happens in the right place.

23. **Existing repositories are adopted without a single commit.** When an app's folder is an existing repository, or a linked worktree, which is its own top folder, Helm adopts it at start:
    - It creates one branch, `helm/<run-name>-<run-id>/<app>`, at the human's current HEAD, through `git update-ref` with an empty old value (create-only). It writes nothing else: no files, no commit. The working tree, the index, HEAD and the human's branches are never touched.
    - The lead's worktree starts from that branch, and its own branch becomes the integration branch, as usual.
    - Helm never merges anything into the human's branches. The sign-off item names the result branch and says so.
    - The run's briefs and the evidence wrapper (`bin/run-check.sh`) live in the Studio, outside the repository, and adopted apps' briefs point there.
    - The spec-stage check counts a `SPEC.md`-style file only if this run changed it, so a pre-existing `ARCHITECTURE.md` does not pass the gate by accident.
    - `adoptRepo` can still add files, through a private `GIT_INDEX_FILE` and `commit-tree`, without touching the checkout, and never overwrites a file at HEAD. The engine passes none.
    - This came from a real portfolio: 24 clones and worktrees on an external disk whose brief forbade bootstrap commits and replacement repositories.

24. **`helm_existing_docs` (the 18th tool, leads only).** In an existing repository, the lead names the committed files that already serve as the spec, architecture, contract and acceptance documents, plus the repository's real check commands. Helm verifies each file is committed on the integration branch and stores the mapping in its own database, never in the repository. The spec stage then counts those files, and the review stage uses those checks when `.helm/checks.json` is absent. Gate briefs list the declared checks. It is refused in a new repository, for a missing file, and for a check that runs nothing real (`echo`, `true`). The lead skill says never to manufacture documents, commits or permissive checks to get past a stage, and to report `blocked` instead.

25. **Plan with an agent, inside New run.** Step 1 of the wizard has two modes: write a brief, or **Plan with an agent**. The second starts one **visible** thread, "Helm · plan a build", on the chosen model, in the planner's scratch project, and embeds it with BB's `ThreadChat` component. Its first message asks it to follow the `helm-planner` skill:
    - interview the user;
    - ask where each app lives;
    - read `bb helm models`, then go role by role through the models this machine has, recommending one for each role and accepting changes;
    - write the brief and run `bb helm plan`.
    It has no Helm tools and no Helm authority: it is not a node, and configure gives it only the `helm` and `helm-planner` skills. The plan it makes is an ordinary draft run, so the wizard lists it from the live `helm:runs` channel (never polled) with an **Open plan** button. It is visible so the user can return to it from the sidebar after closing the wizard.

26. **Skill files are live, and their frontmatter must be strict YAML (incident).** BB loads a path-installed plugin's `skills/` straight from disk. A planner-skill description containing `the user: interview them` was invalid YAML. BB read `name` and `description` as undefined, skipped the skill, and every `configure()` that selected it failed. The re-injection that followed restarted the shared Claude Code provider process, and two running agents of a live run (the Orchestrator and a Manager) lost their turns with "turn.submit failed". `test/unit/skills.test.ts` now rejects a plain frontmatter value containing `: ` or ` #`, or one that starts with a YAML indicator. Develop skills in a copy, or expect every save to reach running agents.

27. **Supervisors steer anyone below them (`helm_direct`, the 19th tool).** The Orchestrator, Managers and App Leads can `tell` (a binding instruction), `pause`, `resume` or set the `priority` of any agent below them, at any depth. Before this, an agent could only `helm_message` its direct parent, children or app siblings, so a Manager could not correct a specialist without relaying through its lead.
    - **Who hears it.** The target gets the notice directly and must `helm_ack`. Everyone between the supervisor and the target, and everyone above it, gets one FYI line. The Orchestrator gets it in world state. The supervisor is not a recipient; it gets the target's acknowledgement as FYI. The directive is stored with `actor: "agent"` and `byNode`, so it appears in the ledger, every chain member's Changes tab, `helm_world` (`by`) and the graph pulse.
    - **The human wins.** Supervisors cannot steer gates, whose independence only the human may touch. They cannot resume what the human paused or override a priority the human set. Models, scope, stop, waivers and policies stay with the human. Agent directives never mark an agent "touched", which means "changed by you".
    - **Bounded.** At most 3 per target and 12 per supervisor in 10 minutes. The skills say to batch: one complete instruction, then let it work.

28. **FYI lines ride along with tool results (token efficiency).** Digest lines, acknowledgements and progress reports used to be sent to a running agent as their own queued message every 20 seconds. A queued message to a busy agent becomes another turn. Now any Helm tool result carries the agent's unread FYI lines, at most 10, and marks them read and the digest receipts delivered. Agents call Helm tools constantly, so this costs no extra turn. The separate flush remains as a fallback, only for lines still unread after 2 minutes. Idle agents are still never woken for an FYI.

29. **Session tabs and a fresh start page.** Several runs can be open at once as tabs. The open tabs are remembered per browser in `localStorage`, and the runs keep going in the background. A tab shows the run's live state and open needs; the run list now carries `needs`, and `need.created` / `need.resolved` also publish on `helm:runs`. **New session** shows the start page with no run selected: write a brief, plan with an agent, or reopen a run. Tab selection is a pure function (`resolveSession`, tested), so a deliberate blank session is never replaced by the auto-selection that opens the newest run on a first visit. Popovers are measured against their real container and the top bar's popovers render outside the header. The run menu used to collapse to its title because it was sized inside the 52 px top bar.

30. **No opaque errors; an error journal for debugging (incident).** "Plan with an agent" refused a pasted contract with BB's generic "rpc input validation failed": the planning text was capped at 8,000 characters and BB validates RPC inputs before Helm sees them. Three changes:
    - **Limits.** Briefs and planning text now share one limit, `TEXT_MAX` (200,000 characters), in `src/shared/rpc-schemas.ts`. The planner receives the text in full.
    - **The panel checks every request first.** It uses the same zod schemas as the server, so a bad request fails with a sentence naming the field and the numbers. BB's generic wire errors are reworded and point to `bb helm errors`.
    - **Error journal.** Migration 5 adds an `errors` table, which keeps the last 1,000 entries. It records:
      - every server warning and error;
      - every RPC failure (a refused request as `user`, anything else as `error`, with the stack);
      - every refused or failed agent-tool call;
      - every panel failure: a rejected request, a crash caught by the panel-wide boundary (which offers *Try again*), or a ThreadChat failure. These are reported through the `client_error` RPC.

      Request contents are never stored, only their shape (field names, types, lengths). `bb helm errors [--hours N] [--all] [--json] [--clear]` lists the entries, and `bb helm doctor` adds an `errors` check for the last 24 hours. This is how problems are debugged without a screen. `test/sim/rpc-json.test.ts` and `test/unit/journal.test.ts` guard the RPC boundary in both directions.

31. **Starting a plan is one obvious step, and the panel remembers where you were (user report).** A user spent 25 minutes in "Plan with an agent", pressed **Open plan**, and saw a graph with no way forward. The only Start button was inside the run-name menu, and it said "Run started" even when the server refused (it ignored `ok: false`). The planner had also read Helm's source code to answer questions, wrongly claimed that adoption commits files, could not end an old run from the terminal, and sent the user to the panel. Leaving the panel lost the wizard and the planning conversation. Changes:
    - **Start bar.** A run in `planning` shows a bar above the views: what it is (apps, the most agents, an estimate), whether it can start, and **Start run**. The checks come from `run_readiness`, a new read-only RPC that runs the same model and folder checks as `start`. Folder notes, the run folder, what starting does (wave 1 now, later waves by approval) and the committed-work-only rule are under **Details**, with **Dry run** and **Discard plan**. Every start goes through `useStartRun`, which reports a refusal and its reasons instead of claiming success.
    - **Persistence.** `components/helm/persist.ts` (`useStored`; every stored value is shape-checked and falls back safely). The wizard's draft lives under `helm:wiz:*`: step, brief, name, portfolio, limits, models, wave approval, run folder, planner model, the planner session, and the planning conversation. Also saved: whether the wizard is open, the view, the selection, the inspector tab and width, and the drill-in. **Close** keeps the draft; **Discard** clears it; starting a run, or starting the plan the conversation made, clears it. An in-flight planner is re-asked on return.
    - **Faster wizard.** **Skip to review** appears when every role already has a model.
    - **Planner facts.** `helm-planner` now has an authoritative facts section and must not read Helm's source:
      - nothing is created at plan time;
      - adoption is one branch at HEAD at wave admission, with no commits or files;
      - worktrees see committed work only;
      - where the run folder and `_studio` go, and that the planner offers `--root`;
      - read-only folders are an instruction, not a lock;
      - how to end a run;
      - updates happen only when the user presses Update.

      The planner asks everything in one message and checks `bb helm runs` for live runs on the same folders.
    - **Plan output.** Each adopted folder says when its branch is made and how many uncommitted changes agents will NOT see. The run folder is printed with `--root`, and the output says how to start and how to discard. Another live run on the same folders is named, with its end command.
    - **`bb helm end --run <id> --yes`** cancels a run or discards a draft.
    - **Git reads never write the human's index.** Host git commands run with `GIT_OPTIONAL_LOCKS=0`, so `git status` during planning doesn't refresh the index files of their checkout or worktrees. `test/unit/host-ops.test.ts` proves this against real git, with a control that shows plain `git status` does write the index.

32. **A run that started but never spawned (incident).** A 22-app run at concurrency 4 showed the Orchestrator *queued, no thread yet* indefinitely, and a steer did not help. At start, the Orchestrator and the six Managers are all first in line. The scheduler's tie-break (fair share, then node id) put `m0`…`m3` ahead of `orch`, so the four Managers took all four slots. Their spawns then waited for the Orchestrator's thread, and the Orchestrator waited for a slot, forever. Fixes, in `domain/scheduler.ts` and `Engine.pumpRun`:
    - **Supervisors first.** In the start batch, the Orchestrator goes before the Managers, and the Managers before everyone else.
    - **Children wait without holding a slot.** A node is not admitted until its parent has a thread or a queued spawn.
    - **Recovery.** Spawns already blocked on a parent that isn't on its way don't count against concurrency, so a run that is already stuck frees itself.
    - **Children follow in the same pass.** The pump goes round again after admitting supervisors, so their children are admitted straight away.

    Reconcile at startup pumps every live run, so stuck runs recover when the plugin updates. `test/sim/start-order.test.ts` reproduces the stuck state, and all three of its tests fail without the fix.

33. **Concurrency is per run and changes live (incident).** A run planned with `--concurrency 4` ran its 6 Managers and nothing below them, while the user's Helm setting said 24. A run's limit was frozen at plan time: the capacity slider was disabled. On top of that, the scheduler counted every running agent of **every** live run against this run's limit, so a second run on the same machine starved it. Changes:
    - `pumpRun` counts this run's running agents and queued spawns only. BB's own thread limit still applies on top.
    - `run_setLimits` / `bb helm limits --concurrency N --budget N` / the capacity popover's **Apply now** change a run's concurrency and budget cap before or during a run. The change is recorded as an event, the Orchestrator gets one FYI line, and the scheduler runs straight away. Raising the budget above the spend lifts a budget pause.
    - `helm-planner` leaves `--concurrency` out unless the user asks, so a run uses the Helm setting.

    `test/sim/limits.test.ts` covers this. Its cross-run test fails when the scheduler counts every run.

34. **Autonomy: the Orchestrator runs the build (user request).** "It's like every second I have to approve things." Every agent's `helm_need` went to the human, and so did every wave and plan change. Runs now have `limits.autonomy`. New runs default to `high`; runs made before it existed read as `ask`. It is set in the setting, the wizard's Approve step, the capacity popover, and `bb helm limits --autonomy`. With `high`:
    - `helm_need` takes `about`: `credentials`, `spending`, `privacy`, `access` or `other`. The first four reach the human, labelled.
    - `other` goes to the asker's supervisor as a message marked "instead of the human". The Orchestrator is told to decide it, write it under Decisions in PORTFOLIO.md, and keep going.
    - Waves admit without a card. `helm_propose_plan` is approved and applied on the Orchestrator's behalf, as a `system` directive, so the ledger never attributes it to the human.

    Sign-off, failures, model problems, BB permission prompts and the budget cap still reach the human: the budget cap is the guard on spending. Switching autonomy on mid-run pushes the rule to every live agent as an FYI line, so it costs no extra turn. Role skills and briefs carry the rule. `test/sim/autonomy.test.ts` covers this, and the 20-app test now pins `ask`, because it covers wave approvals.


35. **Model changes cross providers (user report).** A provider ran out of usage. The user switched agents to another provider, but they kept failing. BB's `threads.update` refuses a model from another provider ("changing providers requires starting a new thread"). Helm still recorded the new model, so the panel showed the new provider while each thread stayed on the old one.
    - Before a model or slots change, Helm reads each affected thread's real provider (`ThreadState.providerId`). Same provider: `updateThread`, from the next turn, as before.
    - Another provider: `replaceThreadTx`. The old thread is stopped, not archived, because it may own child threads; it is archived when the run ends (`retired:<run>`). The node is queued first in line. The new thread reuses the old environment (`reuse:<run>:<node>`), so uncommitted work stays, and gets a hand-over saying so. If that environment is gone, it starts from the integration branch.
    - A stopped (idle) agent switches when it is retried. If `updateThread` still refuses (unknown provider), `handleUpdate` falls back to a replacement.
    - Slots with scope `all` ("Every agent in these roles, now", now the default mid-run) also move per-agent overrides and failed agents, and retry the failed ones. The Model Studio adds **Use for every role** and **Use instead of <provider> everywhere**. The CLI adds `bb helm slots --slot role=… | --replace <provider> --with provider/model:level [--future]`.

    `test/sim/model-switch.test.ts` covers this.

36. **A provider's permission modes (found while fixing 35).** BB refused every Grok spawn with "Provider acp-grok only supports accept-edits, full permission mode", because Helm spawns in `auto` by default. So no agent could ever run on Grok. Providers list their modes (`capabilities.permissionModes`), and the catalog now carries them.
    - When a provider cannot run the tier's configured mode and the run has no choice for it (`limits.providerPermission`), the agent waits in `needs`. One decision card per provider and run asks the human which supported mode to use.
    - Helm never picks for the human. Dropping to `accept-edits` sends every command to Needs you. Raising to `full` grants more access than the human configured. This is an access decision (HUMAN_ONLY), so autonomy never answers it.
    - The answer, or `bb helm limits --permission acp-grok=full`, is stored on the run and releases the held agents at once.

37. **Supervisors approve their delegates' permission prompts (user request).** In accept-edits mode, every command a Grok agent ran became a card in Needs you ("i dont want to keep approving things"). Blanket automatic approval was considered, partly built, and dropped: nothing would review the commands. Instead:
    - Setting `approvePrompts`, default `supervisor`. An agent's BB approval prompt goes to its parent: a builder's or gate's to its lead, a lead's to its manager, a manager's to the Orchestrator. It arrives as a waking message. The parent answers with `helm_approve {promptId, decision: allow|deny|escalate, reason}`.
    - Only the parent can answer. Allow and deny are sent to BB and recorded as events. Escalate raises the normal Needs-you card, noting who escalated and why.
    - The Orchestrator's own prompts, prompts whose parent has no live thread, and prompts unanswered after 15 minutes (watchdog, DB only) reach the human. `human` restores "ask me every time".
    - Pending prompts live in `meta` (`prompt:<run>:<interaction>`). An answer to an interaction already resolved in BB is a no-op.
    - The per-tier permission settings gained readable labels: Auto, Allow edits, Full access. They apply at spawn, because BB's thread update cannot change the mode.

38. **The Watcher (user request).** Grok agents hung mid-turn: BB showed them active, but nothing happened for an hour. The watchdog's nudge was a queued message, and a queued message never reaches a hung turn. So every stalled card said "nudged once and has not answered".
    - The plain watchdog now nudges with `steer`.
    - New optional slot `watcher` (a light model, e.g. Haiku low or Luna medium; "Cheap dev run" and "Max quality" include Haiku low).
    - With a Watcher, the 5-minute watchdog finds suspects from Helm's DB (silent past `stallMinutes`, or waiting after a failed command), at most 12 per pass. It reads only those threads from BB (state, last 500 characters of output, last report, nearest active supervisor) and sends one packet to a single hidden Watcher thread. The thread is replaced after 25 packets to keep its context small.
    - The Watcher answers with `helm_watch` verdicts, its only tool:
      - ok;
      - nudge (steer);
      - restart (stop the turn, then a queued resume message, in per-node FIFO order; a retry for failed agents);
      - escalate (to the nearest supervisor that is alive: lead, then manager, then Orchestrator);
      - human (a stalled card).
    - Each agent is looked at once per stall window. No suspects means no tokens.

39. **Craft skills, tailored tasks and manager isolation (user request).** "Make a skill for each … each one could have their own system prompt that's light but tailored for the task … each manager is just managing their own apps."
    - Every builder loads two skills: `helm-specialist` (protocol) plus a craft skill for its kind of work: `helm-ui`, `helm-code`, `helm-ios`, `helm-android`, `helm-macos`, `helm-windows`, `helm-security`, `helm-test`, `helm-research` or `helm-docs`. A solo lead (who builds the app itself) also loads its platforms' skills, at most two. The leadership, Reviewer and Slop Hunter skills were rewritten with researched craft, and their protocol was kept.
    - Budgets: each skill is under about 10,000 tokens. The Orchestrator's skill is the largest, then the lead's and the manager's. The Slop Hunter's is the smallest gate skill.
    - **Tasks.** `helm_set_task {nodeId, task}` (Orchestrator, managers and leads, for any agent under them) and an optional `task` on each `helm_spawn_squad` item. A task is at most 6,000 characters and is stored in `meta` (`task:<run>:<node>`).
      - It goes into the agent's system prompt (identity and protocol ≤1,500 characters, plus the task, ≤4,000 in total) and its BRIEF under "Your task (from <author>)".
      - A running agent is told and its brief file is rewritten.
      - Writing for an agent outside your org is refused. Helm warns when a squad member is spawned without a task.
    - **Managers see only their own apps.** A manager's brief lists no other managers as peers and gains a "Your scope" fence naming its apps. Its digest was already limited to its own leads, and it has no `helm_world`. Anything that crosses groups goes to the Orchestrator.
    - **`bb helm refresh`.** BB applies a plugin's tools, skills and instructions only when a session is next started or resumed. Refresh rewrites every brief, widens untouched platform scopes, stops each running agent's turn and resumes it with a message (waiting agents get the message only), supervisors first. Each supervisor is told which agents under it still have no task.
