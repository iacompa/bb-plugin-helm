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
