# Work branch sessions

The plugin option `workBranches: [["ADA", "Cardpack"]]` enables private task
branches owned by ADA, in either request direction. It defaults to `[]`.
Names must uniquely identify two different Bots. The Harness must expose
`sessionController.fork`; creation fails explicitly when it cannot fork.

An outbound ADA task forks ADA and sends Cardpack the request with a reply
address in that branch. A new inbound Cardpack request executes in an ADA
branch and answers Cardpack. Follow-ups made while handling that branch's
reply reuse its address. Outside that turn, Cardpack can pass `message_bot`
`work: "<branch id>"` to choose an open ADA branch, or `work: "new"` for a
separate task. Without `work`, one open branch is reused; multiple open
branches are refused with their ids and titles; with none, a new branch is created.
The prompt and `list_bots` show current choices without broadcasting updates.
The parameter is ignored for unconfigured pairs.
An explicit `request_id` replays its receipt without creating another branch.
Branch receipts have separate scopes. Group messages, `reply_to: user` and
unconfigured pairs keep the original behavior.

The main chat's dock opens each branch directly. A branch uses ADA's identity,
model, permissions and inherited working directory. It can pull current main
chat information with `read_own_chat`; nothing is broadcast into it. Branches
do not switch conversation parts. They inherit the main chat's context, so a
branch forked from a nearly full main chat has less room for new work. Before
work becomes too long, call `close_work_branch` with `status: "blocked"` and
write the continuation point, completed work and remaining steps in its
conclusion. Continue in a new task branch from the current main chat after
it has room; the old branch does not rotate or recover an overflow itself.
Memory review excludes the inherited prefix.

Only the branch can call `close_work_branch({status, conclusion, link?})`.
Status is `done`, `blocked` or `cancelled`. The complete conclusion (including
title, status, branch id and link) must fit 1000 Unicode code points. Closure
keeps one conclusion event in the current main Session, with a durable id;
delivery and startup recovery check both the current and original main
Sessions for that id, including consumed messages and inbox splice events.
The conclusion may wake a main Bot turn, whose output is additional cost.
Closed branch records stay readable.

Failed answer deliveries retry after 1, 2 and 4 seconds (three retries), using
unref timers. Work stays pending until delivery and flush succeed. The dock
shows "Delivery failed; retry pending" while a failed answer is outstanding.
After retries are exhausted the persisted answer remains for startup recovery.
If a branch Session cannot be read, startup marks it failed and reports a
blocked conclusion to the main chat. An answer addressed to that unreadable
Session can still fail; it remains pending and cannot be claimed delivered.
Inspect or restore the Session before restarting to recover the answer.

Removing the option stops new forks. Existing branches keep routing and can
close. Keep this compatible plugin installed until all in-flight branches
have settled; reverting directly to a version unaware of branches is unsafe.

## Local acceptance (not performed by installation)

1. In an isolated Harness profile, link this worktree's `ds-bot` package and
   configure the pair. Rebuild with `npm run build`, then start that isolated
   profile. Do not use the user's production data for testing.
2. Use the mock model to exercise outbound and inbound tasks, follow-ups,
   restart recovery and two concurrent branches. Check their actual Sessions.
3. On each completed task, count `branch-summary` sources by `summaryId` in
   main Session messages and inbox splice events: one unique event, rendered
   conclusion at most 1000 code points. Separately count the main Bot's output
   after that wake-up and all Cardpack-related main-chat text.
4. Review dock navigation and conclusion cards in Web/Desktop. A passing mock
   suite does not establish installed-Desktop or real-model acceptance.
5. Only after acceptance, back up the production profile configuration, install
   or link this worktree package, configure the pair, and restart/reload DSH.
   None of these production steps are part of the prototype implementation.

Design note: `docs/plans/2026-10-29-work-branch-sessions.md`.
