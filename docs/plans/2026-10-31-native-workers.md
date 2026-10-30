# Native workers

- Date: 2026-10-31
- Related: Issue #41
- Base examined: `origin/main` at `3c34c2dd9e9951a7fba8f357b92e795b25a5fc06`
- DSH examined: `deepseek-harness` `master` at `687f282e8625c6b8d11ff58211a90524be2e4317`

This note is in English. It defines the decided contract for native workers:
native DSH Sessions used by task Sessions as bounded task executors. It is a
design record, not evidence that the implementation exists or has passed
acceptance.

The product model follows the poteto/pstack split: coordinators coordinate and
verify; workers execute. A coordinator is a Main Bot, a PM, or another Bot
working from a task-owned Session. A worker is not a new Bot identity and does
not become part of the long-lived team.

## Terms

- **Coordinator**: the Bot Session that creates or controls a worker. It must
  be a task-owned Session for an open task.
- **Task Session**: a Session owned exclusively by one task and one Bot, as
  defined by [Task sessions](2026-10-30-task-sessions.md).
- **Worker**: one plain root DSH Session created by a coordinator for one task.
  It has a native DSH transcript, DSH tools, its own model and permissions, and
  no DS Bot identity.
- **Run**: one prompt and its resulting turn in a worker Session. The first run
  starts the worker; later runs are explicit follow-ups.
- **Worker control tools**: `run_worker`, `worker_followup`, and
  `cancel_worker`.
- **Result**: the bounded, model-visible message delivered after a run ends to
  the exact task Session that requested it.

## Purpose and boundary

Native workers solve context and role pollution between coordination and
execution:

- A coordinator keeps the task goal, calls workers, reads their evidence, and
  closes the task.
- A worker receives one self-contained job, executes it in a separate DSH
  Session, and returns a bounded result.
- A worker does not inherit the coordinator's context, Bot memory, Bot
  capabilities, or long-term identity. The coordinator must write a complete
  prompt.
- A worker cannot call team tools, create tasks, message Bots, or control other
  workers.
- A worker's result returns only to the requesting task Session. It never wakes
  a Bot trunk directly.
- A worker is short-lived. Its Session may be followed up a bounded number of
  times, then it is cancelled or archived when the task ends.

This is not a central dispatcher, a new team of Bots, or a substitute for task
participants. Coordinators remain responsible for the task and its conclusion.

## DSH constraints

The design uses documented DSH APIs:

1. `ctx.sessionController.create({ cwd | workspaceId })` creates an ordinary
   root Session and returns its `sessionId`. It does not accept a title or a
   tool restriction.
2. `ctx.sessionController.prompt(request, signal)` requires an
   `AbortSignal`. It returns `{ accepted: true }` after the prompt enters the
   Agent inbox. Acceptance is not evidence that a turn started or completed.
3. The durable `user/message` source records the prompt `requestId` as
   `rpcId`. DSH uses that identity to deduplicate a repeated prompt.
4. `turn/end.reason.kind` is a merge-extensible union. The current kinds are
   `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`, and
   `forked`. Only `completed` means success.
5. `ctx.sessionController.cancel({ sessionId })` asks the live Agent to cancel
   its current turn and retains the inbox. A worker cancel must therefore also
   clear and flush that worker's pending inbox.
6. `agent.ctx.tools.restrict({ deny })` filters inherited tools by name. It
   throws for a name the profile does not serve. The restriction must be
   installed after the Agent exists but before its first step.
7. `agent.ctx.tools.guard()` is an execution-time, monotonic denial. It is
   defense in depth for a tool that is still visible or is registered later.
8. `ctx.workingDirectory.set(agent, path)` changes one Session. It does not
   change permissions or another Session.
9. A same-host Session cannot outlive the host. A host restart must reconcile
   persisted worker state instead of assuming an in-memory completion listener
   survived.

The `packages/subagent` implementation is useful comparison, not the runtime
for this feature. It provides provider-managed child activations, parent-child
lineage, completion notices, and optional continuation. Native workers need a
plain root Session owned by exactly one DS Bot task Session, exact routing back
to that Session, DS Bot's task commit lane, and DS Bot's team-tool deny set.
Using the subagent provider directly would add a second ownership and routing
model.

The existing "DSH Agent" in `agents.js` also creates plain native Sessions and
uses `tools.restrict`, but its restriction retry is asynchronous and can allow
the first prompt before the deny lands. Native workers must not reuse that
retry path. Worker setup completes and verifies the gate before the first
prompt, or the worker fails closed without prompting.

## Tool surface

Every refusal described below is a tool error. It creates no worker, consumes
no follow-up budget, and does not fall back to another Session.

### Eligibility

The worker control tools are scoped tools, not global tools. They are offered
only when all of the following are true:

- `nativeWorkers === true`;
- the Agent is a task-owned Session in `taskBySession`;
- the task is `open` and `ready`;
- the Bot was task-enabled in the task's creation capability snapshot;
- the task participant still exists; and
- no worker Session is indexed as a Bot Session.

The tools are never offered in a Bot trunk, a group Session, a legacy work
branch, a worker Session, or an archived task Session. Removing a Bot from the
team or removing the current capability does not convert an existing task
Session into a worker dispatcher.

### `run_worker`

```js
run_worker({
  prompt,
  title?,
  mode: "execute" | "verify",
  workdir?,
  model?,
  effort?,
  permission?
})
```

- `prompt` is required, non-empty, and self-contained.
- `title` is optional. The default is the first non-empty line of `prompt`,
  trimmed to 80 Unicode code points.
- `mode` defaults to `execute`.
- `workdir` defaults to the requesting task Session's current working
  directory.
- `model` accepts a full `provider/model` reference or an unambiguous model id
  or name.
- `effort` is resolved against the selected model. An unavailable effort is a
  tool error, not an ignored value.
- `permission` names an available DSH permission preset. `auto` is not a
  selectable worker permission.

Success returns immediately:

```text
started worker <worker-id>
```

The call does not wait for the run. The result is later delivered as a bounded
synthetic message to the exact requesting task Session.

There is deliberately no blocking option. A blocking tool call would keep the
coordinator's turn open, prevent it from starting independent workers together,
and make cancellation depend on the tool call returning. A coordinator that
has nothing else to do ends its turn; the result starts the next turn in the
same task Session. This follows DSH's own managed delegation behavior while
keeping DS Bot's task routing explicit.

### `worker_followup`

```js
worker_followup({ worker, message })
```

- The worker must belong to the caller's current task and must have been
  requested by this exact task Session.
- A follow-up is accepted only when the worker is settled: `idle` or
  `interrupted`. An accepted follow-up for `interrupted` warns that the prior
  outcome is unknown; the coordinator should inspect the linked Session first.
- A running, starting, or cancelling worker refuses follow-up with a tool
  error. Use `cancel_worker` and start a new worker if the work must change
  while it is running.
- A successful call returns immediately with an accepted run identity. The
  result is delivered like the initial result.
- The default limit is two accepted follow-ups per worker. The initial run
  does not count. A refused follow-up does not consume budget.

The continuation is PM-driven. It is not a hidden goal loop and does not add a
new worker identity. The same worker Session, model, and workdir are reused
unless the task is no longer open. Permission is checked again and clamped to
the Bot's current ceiling before prompt; it is never raised by a follow-up.

### `cancel_worker`

```js
cancel_worker({ worker })
```

- The worker must belong to the caller's current task and exact requesting
  Session.
- The operation cancels the worker's current DSH turn if one is live, clears
  every pending worker-owned inbox message, flushes the Session, and records
  the worker as `cancelled`.
- An idle worker is marked cancelled without a model call.
- Cancellation of an already cancelled worker is a successful no-op. A
  cancelled worker cannot be followed up.
- A cancellation failure leaves the worker nonterminal with a diagnostic. The
  coordinator may retry; it must not assume the worker stopped.

### `list_tasks`

There is no separate `list_workers` tool. `list_tasks` already exists in task
Sessions and is the coordinator's task inventory, so it is extended to show
each open task's workers:

```text
worker <id> | <mode> | <state> | <elapsed> | <session link> | <title>
```

The worker id, state, and Session link are included because the coordinator
needs them for `worker_followup`, `cancel_worker`, and inspection. Folding the
list into `list_tasks` avoids a fourth tool whose scope would be nearly
identical.

## Defaults and limits

Configuration is additive:

```js
{
  nativeWorkers: false,
  workerModel: undefined,
  verifierModel: undefined,
  maxWorkersPerTask: 2,
  maxWorkerFollowups: 2
}
```

- `nativeWorkers` is the rollout gate and defaults to `false`. Worker tools do
  not exist while it is false.
- `maxWorkersPerTask` is the total number of worker records a task may create
  over its whole life. The default 2 matches the pilot. It limits both
  concurrent and sequential replacements. A refused creation is a tool error;
  there is no worker queue.
- `maxWorkerFollowups` is the number of accepted follow-up runs per worker.
  The default is 2.
- Both limits must be non-negative safe integers. A value of 0 disables that
  operation.
- Worker data remains readable and recoverable when the rollout gate is later
  turned off. The gate stops new workers; it does not orphan existing records.

`workerModel` and `verifierModel` use the same accepted notation as
`summaryModel`: a full `provider/model` string or an object
`{ provider, model, effort? }`. A configured but unavailable model fails the
worker setup; it does not silently fall back.

### Model selection

For `mode: "execute"`, select in this order:

1. explicit `model`;
2. configured `workerModel`;
3. the requesting Bot's current effective route from its task Session.

For `mode: "verify"`, select in this order:

1. explicit `model`;
2. configured `verifierModel`;
3. configured `workerModel`;
4. the requesting Bot's current effective route.

For `effort`:

1. explicit `effort` wins;
2. when the selected route is the Bot's current route, use the Bot's current
   effort;
3. otherwise use the selected model's default effort.

The selected route is applied with `selectSessionModel()` and verified before
the first prompt. A worker never writes its route back to the Bot or another
task Session.

`mode: "verify"` should use a different model family when the deployment
configures `verifierModel`. The current DSH model catalog exposes provider,
model, and display metadata, but no generic model-family field. The design
therefore uses `verifierModel` as the explicit family-separation mechanism and
records a diagnostic when the verifier uses the same provider as the
coordinator. Automatic family inference remains an open question.

### Permissions

- `mode: "execute"` defaults to the requesting Bot's effective permission in
  the task Session.
- `mode: "verify"` defaults to `read-only`.
- An explicit `permission` must resolve from the permission preset catalog.
- A worker permission may never exceed the Bot's own permission.
- A requested preset is allowed only when its sandbox is no broader than the
  Bot's sandbox and its approval policy is no weaker. Sandbox order is
  `read-only < workspace-write < danger-full-access`. `ask` is stricter than
  `never`.
- `danger-full-access` requires both that the Bot's own effective sandbox is
  `danger-full-access` and that the caller explicitly supplied that
  permission. It is never selected by a default.

The permission is applied and read back before prompt. `workingDirectory.set`
does not change permissions.

### Working directory

- The default is the requesting task Session's current directory at the time
  `run_worker` executes, not the task's original initial folder.
- An explicit `workdir` must be an absolute existing directory. It receives
  the same realpath, guarded-folder, and approval checks as a task Session.
- The worker Session is created with that directory as `cwd`; if it is a
  resumed Session, `workingDirectory.set()` is used and verified.
- A native `working_directory` change inside the worker affects only that
  worker Session. It never updates the Bot, the task, the coordinator, or
  another worker.
- A missing or unapproved directory fails the run before the first prompt.

## Start gate

Setup is ordered and fail closed:

1. Acquire the task's serialized commit lane and re-read the task, requester
   Session, participant, and current generation.
2. Enforce the worker and follow-up limits and the task's open state.
3. Resolve title, mode, model, effort, permission, and workdir without changing
   anything.
4. Persist a `starting` worker record with a stable worker id, creation marker,
   requesting Bot id, requesting Session id, and resolved setup.
5. Call `sessionController.create()` with the resolved `cwd` and no Bot
   `agentPreset`. Persist the returned Session id immediately.
6. Rename the Session to its worker marker/title, index it in
   `workerBySession`, and attach the worker to the task record before any
   prompt.
7. Apply and verify the permission preset, model/effort, working directory,
   and absence of Bot identity, Bot capabilities, and memory review.
8. Apply the team-tool deny:
   - obtain the registered global tool names for this Agent;
   - call `restrict({ deny })` for the intersection of those names and
     `TEAM_TOOLS`;
   - install a worker-scoped execution guard that denies every name in
     `TEAM_TOOLS` plus every worker control tool, whether or not it is
     currently visible;
   - verify that none of those names is visible;
   - extend the existing `plugin_manager` self-change guard so a worker is a
     managed Session.
9. If any tool runtime is missing, any name cannot be denied, any gate is
   ambiguous, or the generation stops, do not prompt. Mark the worker
   `failed`, persist the diagnostic, and deliver one bounded failure result.
10. Install the turn listener before prompt, then call:

```js
ctx.sessionController.prompt({
  sessionId,
  requestId: workerId,
  mode: "queue",
  content: [{ type: "text", text: prompt }]
}, signal)
```

The initial prompt uses `requestId === workerId`. A follow-up uses
`${workerId}:followup:<n>`, because DSH deduplicates an already-used
`requestId`. Acceptance is persisted only as "accepted"; it is not completion.

No `setTimeout` retry may allow the prompt to run before this gate succeeds.
No Bot capabilities are mounted into the worker. No memory review is scheduled
for it.

## Turn correlation and results

The worker listener observes only the worker Session id. It:

1. waits for the `user/message` whose `source.kind === "user"` and
   `source.rpcId` equals the run's prompt id;
2. captures the turn number from the enclosing `turn/start`;
3. ignores every `turn/end` with a different turn number;
4. on the matching `turn/end`, records the reason and the last text-bearing
   `assistant/message` in that turn.

The listener is installed before prompt and is generation-scoped. The
Session log is authoritative: a lost event, HMR, or restart is reconciled by
inspecting the log for the same `rpcId` and turn boundary.

Only `turn/end.reason.kind === "completed"` counts as success. The result
reports the exact reason:

| Reason | Recorded outcome |
|---|---|
| `completed` | `completed`; success |
| `max-tokens` | `max-tokens`; incomplete, not success |
| `blocked` | `blocked`; not success |
| `aborted` | `aborted`; not success |
| `error` | `error`; not success |
| `interrupted` | `interrupted`; unknown, not success |
| `forked` | `invalid`; a worker must not be a fork |
| unknown future kind | `unknown`; not success |

The rendered result is one stable message:

```text
[Worker <state>: <title>]
<final assistant text, or "(no final text)">
Session: session:<worker-session-id>
Finish: <turn/end reason>
```

The complete rendered message, including the header and Session link, is at
most 4000 Unicode code points. The final assistant text is truncated only as
needed to preserve that bound. The full transcript remains in the worker
Session.

The result id is:

- `<workerId>:result` for the initial run;
- `<workerId>:followup:<n>:result` for follow-up run `n`.

Delivery is idempotent by this id. Before enqueueing, the task lane checks the
exact requester Session's inbox and consumed log for the id, persists a pending
delivery, enqueues with `followup()`, then flushes before marking it delivered.
A result never falls back to a trunk, another participant Session, or another
task.

The synthetic result source is:

```js
{
  kind: "worker-result",
  taskId,
  workerId,
  runId,
  resultId,
  requesterSessionId
}
```

It is model-visible in the task Session, classified as a private task trigger,
and rendered as a worker result rather than a user decision or Bot exchange.
The turn/inbox/recovery code must recognize it as next-turn work and must not
route it through `answerSender()`.

## Cancellation, failure, and restart

### Explicit cancel

For a live worker:

1. Persist `cancelling`.
2. Call `sessionController.cancel({ sessionId })`.
3. Clear all pending worker inbox entries and flush.
4. Persist `cancelled`, the cancellation time, and a diagnostic if the Agent
   was no longer live.
5. Never deliver a cancelled run as successful. A later `turn/end` may be kept
   as history but cannot revive the worker.

### Task close

`done` is refused while any worker is:

- `starting`, `running`, or `cancelling`;
- has an accepted run whose result is not yet delivered; or
- has a pending result delivery.

This extends the existing open-dependency rule. Idle or settled workers do not
block `done` after their result has been delivered.

For `blocked`, `cancelled`, or `failed`:

1. Acquire the task lane and set the task phase to `closing`.
2. Mark all nonterminal workers `cancelling`.
3. Cancel each live worker and clear its inbox.
4. Persist each worker as cancelled, or retain `interrupted` when the exact
   outcome cannot be established.
5. Suppress any still-pending result delivery. It remains in the worker record
   but is not sent to the task Session after the terminal commit.
6. Commit the task terminal state.

After the worker has no live turn, its Session is archived. Archiving keeps the
Session link readable and removes the worker from active execution; it does
not delete the transcript.

### Host restart or HMR

Every worker job captures the plugin generation and stopped flag and checks
both after every await before a save, creation, prompt, cancel, result enqueue,
or delivery acknowledgement.

On restart or plugin replacement:

- workers with a completed matching turn are settled and their pending result
  is delivered idempotently;
- a worker in `starting` or `running` with no terminal matching turn becomes
  `interrupted`; its result reports an unknown outcome;
- matching pending input is cleared and flushed;
- no worker is automatically prompted again;
- an explicit `worker_followup` may continue an interrupted worker only after
  the coordinator has the unknown result and chooses that continuation;
- a creation whose Session id was not saved may be adopted only by a unique
  documented marker lookup. Ambiguity or unavailable lookup marks the worker
  `interrupted`; it never creates a replacement automatically.

An old generation may finish a native model turn, but it may not commit a
result, deliver a message, or schedule another worker job after stop. The new
generation reconciles from persisted state and the Session log.

## Data model

Worker records are persisted under each task in `task.workers`. There is no
separate `state.workers` source of truth.

```js
{
  id: "worker-id",
  taskId: "task-id",
  requestedBy: "bot-id",
  requesterSessionId: "task-session-id",
  title: "Check the archive",
  mode: "execute",                         // execute | verify
  state: "running",                        // see below
  creationMarker: "worker:worker-id",
  sessionId: "native-session-id",
  workdir: "<current-task-folder>",
  model: {
    provider: "provider-id",
    model: "model-id",
    reasoningEffort: "medium"
  },
  permission: "workspace-write",
  followupCount: 0,
  currentRunId: "worker-id",
  runs: {
    "worker-id": {
      id: "worker-id",
      ordinal: 0,
      kind: "initial",                     // initial | followup
      promptRequestId: "worker-id",
      promptPreview: "Check the archive...",
      acceptedAt: 1790000000000,
      turn: 1,
      finish: "completed",
      result: {
        id: "worker-id:result",
        state: "delivered",                // pending | enqueued | delivered | suppressed
        text: "[Worker completed: ...]\n...",
        enqueuedAt: 1790000001000,
        deliveredAt: 1790000001001
      }
    }
  },
  createdAt: 1790000000000,
  startedAt: 1790000000100,
  updatedAt: 1790000001001,
  finishedAt: 1790000001001,
  archivedAt: null,
  diagnostic: null
}
```

Worker states:

| State | Meaning |
|---|---|
| `starting` | Creation or pre-prompt setup is in progress |
| `running` | A run has an accepted prompt or an open matching turn |
| `idle` | The last run settled; another follow-up may be accepted |
| `cancelling` | Cancellation was requested and is not yet recorded as terminal |
| `cancelled` | Terminal; no follow-up is allowed |
| `interrupted` | The host lost the exact outcome; no automatic rerun |
| `failed` | Setup failed before a usable worker Session existed |

`completed` is a run finish, not a worker state. A run with `error`,
`blocked`, `aborted`, or `max-tokens` leaves the worker `idle` and records the
non-success finish, so the coordinator may decide whether to follow up.

The full prompt is not duplicated in `state.json`; the native Session log holds
it after acceptance. `promptPreview` is bounded diagnostic text. The rendered
result is stored because it must be delivered idempotently after restart. Token
usage is not copied into this record: the Session id is the attribution key
used by the usage ledger.

For old tasks without `workers`, readers treat the map as empty. New worker
maps are always present on newly written tasks. Task validation must reject:

- a worker whose task id does not match its parent task;
- an unknown requester Bot or requester Session;
- a Session that already belongs to another task or Bot identity;
- duplicate worker Session ids;
- a follow-up count above the configured limit;
- a result id or delivery target that does not match the run; and
- a new worker or new run added after the task became terminal.

A terminal task may change existing worker bookkeeping only through the narrow
settlement path: `cancelling` to `cancelled`, `running` to `interrupted`, a
run finish/result append for an already-started run, and
`pending -> suppressed` for a result. It can never add a worker, add a
follow-up, or revive a worker.

`task.workers` is indexed into in-memory `workerById` and `workerBySession`
maps. Worker Sessions are deliberately excluded from `taskOwners`,
`chatOwners`, `groupOwners`, `branchOwners`, `taskSessions`, and every Bot
identity lookup. They are not trunk endpoints and not Bot parts.

## UI

The task header is the only team surface that lists workers. For each worker
it shows:

- mode and title;
- current state;
- elapsed time since the current run started, using the existing elapsed
  component;
- a link that opens the native DSH worker Session, like a DSH Agent Session;
- a compact finish/result state when settled.

Worker rows are not appended to a Bot's trunk dock, Bot part list, participant
list, or group view. DSH's own root-Session sidebar may still list the worker
Session because it is a native root Session; that is not a Bot trunk entry.

The result line in a task Session is rendered as a worker result with a
distinct label. It is not rendered as a user decision or a normal Bot message.
The task header uses the existing theme variables, type scale, corner radii,
and motion conventions in `docs/design/ui-standard.md`.

## Usage and diagnostics

Usage is attributed to the task, not to a fabricated worker Bot:

- `usage.js` indexes every worker Session as owner `task:<task-id>` and kind
  `worker`;
- both the usage page and the task header aggregate the worker Session,
  requester Session, and participant Sessions under the task;
- provider usage comes from the existing DSH `tokenUsage` fold, not from a
  separate estimator;
- the task view must show token usage even when a worker never completed, and
  must distinguish unknown usage after an interrupted run.

The current DS Bot usage ledger records tokens, not money. This design does not
invent a currency conversion. It records and displays per-task token usage;
adding monetary cost is a separate question.

Diagnostics record:

- worker id, task id, mode, configured/default model, and permission;
- whether the hard gate succeeded and which deny names were applied;
- prompt acceptance and correlation id;
- matching turn number and finish reason;
- result delivery state and exact requester Session;
- cancellation, restart, marker ambiguity, and generation-stop outcomes.

Diagnostics must not contain the full prompt, transcript, or credentials.

## Invariants

1. A worker belongs to exactly one task and exactly one requesting task
   Session.
2. A worker Session is never a Bot Session, Bot part, group Session, legacy
   branch, or task participant endpoint.
3. Worker control tools exist only in eligible task-owned Sessions.
4. A worker has no Bot identity, no Bot memory review, and no Bot
   capabilities.
5. Every team tool and every worker control tool is denied before the first
   worker prompt.
6. A worker also receives the existing `plugin_manager` self-change denial.
7. The hard gate fails closed; it never allows a prompt while restriction is
   missing or unresolved.
8. Model, effort, permission, workdir, and gate are applied and verified
   before every run.
9. Worker permission never exceeds the requesting Bot's permission.
10. A worker cannot create another worker or call team tools.
11. At most `maxWorkersPerTask` workers exist for a task.
12. At most `maxWorkerFollowups` follow-ups exist for a worker.
13. A worker has at most one active run.
14. Only a matching `rpcId` and matching `turn/end` settle a run.
15. Only `completed` is a successful finish.
16. Every result is at most 4000 Unicode code points including its wrapper and
    Session link.
17. Every result is delivered only to the requesting task Session.
18. Result delivery is idempotent by a stable run result id.
19. A terminal task cannot revive a worker or accept a new run.
20. A restart never automatically reruns a worker.
21. HMR cannot allow an old generation to commit a worker transition after
    stop.
22. `done` is refused while a worker is active or its result is pending.
23. Non-`done` close cancels running workers and suppresses undelivered
    results.
24. Worker usage is counted under its task.
25. Worker Sessions are archived, not deleted, after settlement.
26. Delivery dedupe does not claim exactly-once external side effects.

## File and function changes

The following is the implementation map, not a change made by this document.

| Area | File and current symbols | Required change |
|---|---|---|
| Module order | `ds-bot/index.js` `MODULES` | Install the worker module after task routing, task lifecycle, folders, permissions, and models, and before tools restore their scoped surfaces |
| Tool names | `ds-bot/src/host/constants.js` `TEAM_TOOLS` | Include the worker control tools in the deny set and add a test that every DS Bot model-facing tool is covered |
| Worker runtime | `ds-bot/src/host/workers.js` (new) `install`, `runWorker`, `followupWorker`, `cancelWorker`, `settleRun`, `deliverResult`, `recoverWorkers`, `cancelTaskWorkers`, `archiveSettledWorkers` | Own worker records, creation intent, hard gate, turn listener, lifecycle, restart, and result delivery |
| Tools | `ds-bot/src/host/tools.js` `registerTaskTools`, `syncTaskTool`, `listTasks`, task tool registry | Register the three worker tools only in eligible task Sessions; extend `list_tasks`; extend the `plugin_manager` managed-Session predicate to worker Sessions |
| Task validation | `ds-bot/src/host/tasks.js` `validateTask`, `commitTask` | Validate `task.workers`, worker/run identity, limits, and the narrow terminal settlement transitions |
| Indexes | `ds-bot/src/host/store.js` `indexSessions`, `selfOf`, `isBotSession`, task maps | Add `workerById`/`workerBySession`, keep workers out of all Bot indexes, and expose lookup helpers |
| Task lane | `ds-bot/src/host/task-routing.js` `withTask`, `taskContext`, `routeTask` | Reuse the per-task lane for worker creation/results; make task-owned requester verification available to the worker module |
| Close | `ds-bot/src/host/task-lifecycle.js` `dependencies`, `settleTerminal`, `closeTask`, `recover` | Block `done` on active/pending workers and cancel/suppress workers for other terminal states |
| Models | `ds-bot/src/host/models.js` `resolveModel`, `resolveEffort`, `selectSessionModel` | Resolve worker/verifier routes and apply them without changing the profile default or Bot record |
| Permissions | `ds-bot/src/host/permissions.js` `permissionCatalog`, `applyPermission`, `checkPreset` | Add permission-within-Bot comparison and apply/read back the selected worker preset |
| Folders | `ds-bot/src/host/folders.js` `cleanWorkDir`, `workFolder`, `approveFolder`, `sessionFolder` | Resolve the current task workdir, approval, create cwd, and Session-only worker directory changes |
| Agent setup | `ds-bot/src/host/agents.js` `restrictTeamTools`, `agentOf` | Reuse the native Session lifecycle idea only. Do not call the asynchronous retry helper as the worker gate |
| Turn source | `ds-bot/src/host/turns.js` `turnInput`, session-event tracking | Recognize `worker-result` as private task input and never route it through `answerSender` |
| Inbox/recovery | `ds-bot/src/host/parts.js`, `resume.js` inbox target, forwarding, resume paths | Keep worker results on next-turn delivery, preserve task scope, and restore exact result delivery after HMR/restart |
| State view | `ds-bot/src/host/channel.js` `state`, `live.work.tasks` | Expose worker state, elapsed data, result state, and task usage |
| Usage | `ds-bot/src/host/usage.js` `liveOwners`, `usageView` | Attribute worker Sessions to `task:<id>` and kind `worker` |
| Task UI | `ds-bot/src/client/branch-dock.js` `TaskHeader`, `BRANCH_CSS` | Render worker rows in the task header only |
| Message UI | `ds-bot/src/client/cells.js`, `sources.js`, `i18n.js` | Distinguish a worker-result source and add English/Chinese labels |
| Tests | `ds-bot/test/workers.test.js` (new), `tasks.test.js`, `task-lifecycle.test.js`, `task-dock.test.js`, `self-maintenance.test.js` | Cover the cases below; rebuild `client.js` if the UI changes |

The existing `client.js` remains generated. Any UI implementation changes
`src/client/`, runs `npm run build`, and commits both files.

## Tests

### Unit tests

- Tool registration: absent when `nativeWorkers` is false, absent on trunks
  and workers, present on eligible task Sessions.
- `run_worker` returns immediately and never waits for a turn.
- `maxWorkersPerTask`, `maxWorkerFollowups`, and all refusal paths are exact;
  refusals do not consume budget.
- Model precedence, effort validation, verifier default, and invalid configured
  routes.
- Permission precedence and comparison; verify defaults to read-only; full
  access requires the Bot's own full access and an explicit request.
- A follow-up after the Bot lowers its permission clamps the worker and never
  raises it.
- Default workdir follows live task Session cd; explicit workdir checks
  realpath, guarded roots, and approval.
- Hard-gate ordering: create, persist id, apply model/permission/workdir,
  restrict/guard, verify, listener, then prompt. A restriction failure must
  observe zero prompts.
- Worker scope cannot see or execute team tools or worker control tools.
- `plugin_manager` self-change is denied in a worker Session.
- `rpcId` correlation ignores a concurrent or unrelated turn.
- Every terminal reason maps to the correct result state; only `completed`
  succeeds.
- 4000-code-point truncation includes the wrapper and Session link.
- Result source targets the exact task Session, never a trunk.
- Result delivery is idempotent across repeated events and restart.
- Follow-up is refused while running; accepted follow-ups reuse the Session.
- Cancel clears queued worker input and does not cancel another task.
- `done` refuses active or result-pending workers; non-`done` close cancels and
  suppresses.
- Restart with a mid-turn worker marks `interrupted`, preserves the unknown
  outcome, and never prompts automatically.
- HMR generations cannot save, enqueue, or mark delivered after stop.
- Terminal worker bookkeeping cannot add workers, runs, or follow-ups.
- Usage is attributed to `task:<id>`, not to a Bot.

### Isolated integration

Run in `ds-bot/`:

```sh
npm test
node scripts/build-client.mjs --check
npm run lint
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset &&
  node dev/smoke.mjs smoke 3096
dev/bench.sh smoke 3096 8796 stop
```

Use the mock model and an isolated `.dsh-test-worker-*` data directory. Never
point a test at a user's DSH data, a Desktop profile, or a running Desktop.

W4 also runs the built worker slice against the pinned real DSH runtime from
the documented installation, with the mock model and synthetic data. This
proves the actual `sessionController.create`, `prompt(request, signal)`,
`rpcId`, `turn/end`, `cancel`, `tools.restrict`, `tools.guard`,
`workingDirectory`, and permission APIs on the target version. It does not use
a live user profile.

## Acceptance scenarios

1. From one task Session, start two execute workers with independent prompts.
   Both create native Sessions, run concurrently, and each result appears only
   in the requesting task Session.
2. A third `run_worker` is refused by `maxWorkersPerTask`, even after one of
   the first two becomes idle.
3. An execute worker asks its model to call every team tool. No team tool is
   visible or executable, and a prompt that tries anyway produces a denied
   tool result rather than a team action.
4. A fake setup failure after Session creation but before restriction results
   in no prompt, no model usage, and one bounded failure result.
5. A verify worker defaults to read-only and a different configured
   `verifierModel`; an explicit escalation beyond the Bot's permission is
   refused.
6. The task Session changes directory after opening. A new worker inherits
   that current directory, not the original task folder.
7. The first worker completes, receives one follow-up, and its result is
   correlated to the follow-up prompt. A third follow-up is refused.
8. `cancel_worker` while running cancels the exact worker, drops queued input,
   leaves another worker and task work running, and records a cancelled run.
9. `close_task({ status: "done" })` is refused while one result is pending;
   after delivery it succeeds. Closing `cancelled`, `blocked`, or `failed`
   cancels all active workers and suppresses their remaining results.
10. The host is restarted while a worker is mid-turn. The worker becomes
    `interrupted`, the result says the outcome is unknown, and no new prompt is
    sent automatically.
11. HMR replaces the plugin between prompt acceptance and turn/end. The next
    generation settles from the log once, delivers one result, and does not
    prompt again.
12. A crash after result enqueue but before delivery acknowledgement does not
    enqueue a second copy.
13. The task header lists worker state, elapsed time, and a working native
    Session link. The worker is absent from the Bot trunk dock and participant
    rows.
14. The usage page and task view count worker tokens under the task; a worker
    with an interrupted run is marked as having unknown usage rather than
    zero.
15. A worker attempts `plugin_manager` changes for `ds-bot`; the execution
    guard refuses it.
16. Turning `nativeWorkers` off stops new worker tools and creation while a
    worker-aware build still settles, cancels, and closes existing records.

## Rollback

Normal operational rollback:

1. Set `nativeWorkers: false`.
2. Stop admitting new worker work.
3. Keep a worker-aware DS Bot build installed while existing workers settle
   or are cancelled and existing tasks close.
4. Verify no `starting`, `running`, or `cancelling` workers and no pending
   worker result remain.
5. Archive settled worker Sessions.

Once any `task.workers` record exists, rollback to a build that does not
understand worker records is refused. Such a build could ignore active worker
Sessions, strand results, or close a task without cancelling its workers. A
worker-aware build is required even when the rollout gate is off.

If a worker-aware build fails during a release, follow the out-of-band release
procedure. Do not restore an older `state.json` unless the operator explicitly
accepts losing later work; keep the failed current data for diagnosis.

This document adds no release helper and does not change the rule that a Bot
Session cannot supervise replacement of its own plugin.

## Delivery slices

All worker code ships behind `nativeWorkers: false` until its slice and
acceptance criteria pass.

### W1: model, tools, gate, and first result

- Add `workers.js`, worker data validation/indexes, `run_worker`, model and
  permission setup, workdir handling, the hard gate, turn correlation, and
  bounded result delivery.
- Enforce the absolute `maxWorkersPerTask` safety cap.
- Add the `worker-result` source and query formatting to `list_tasks`.
- Extend `plugin_manager` self-change management to workers.
- Keep worker tools absent when the gate is false.

Acceptance:

- unit tests for setup, gate order, result truncation, exact routing, no trunk
  wake, and no prompt after a gate failure pass;
- the isolated mock smoke flow starts and completes one worker;
- no Bot identity, memory review, or Bot capability is observable in the
  worker.

### W2: follow-up, cancel, limits, close, and recovery

- Add `worker_followup`, `cancel_worker`, follow-up accounting, exact inbox
  clearing, task-close integration, generation checks, and restart
  reconciliation.
- Finalize all limit and refusal messages.
- Add terminal worker bookkeeping and result suppression.

Acceptance:

- follow-up, cancel, close, crash, HMR, and idempotent result scenarios pass;
- a nonterminal task cannot close `done` past an active/pending worker;
- no automatic rerun occurs after restart.

### W3: task-header UI

- Render worker state, elapsed time, Session link, result state, and usage in
  `TaskHeader`.
- Add the worker-result message presentation and localized labels.
- Rebuild and commit `client.js`.

Acceptance:

- the UI checks and task-dock tests pass;
- a real isolated task shows worker rows only in the task header;
- mobile and desktop layouts follow the UI standard.

### W4: isolated acceptance and release

- Run the full unit, client, lint, smoke, real-DSH-with-mock, restart, HMR,
  cancellation, and permission acceptance matrix.
- Exercise the out-of-band release and rollback procedure with synthetic data.
- Enable `nativeWorkers` only after W1-W3 are present and W4 acceptance is
  recorded.

Acceptance:

- all W1-W3 checks pass on the target DSH runtime;
- the release records the loaded DS Bot version, DSH version, worker data
  compatibility, and rollback target;
- no live user profile, private DSH data, or running Desktop is used in
  acceptance.

## Open questions

1. **Model family metadata.** DSH exposes provider and model identity but no
   generic family field. Is provider identity the intended definition of
   "different model family", or should DSH grow explicit family metadata?
   Until decided, `verifierModel` is the explicit preference and the worker
   records a same-provider diagnostic.
2. **DSH Agent retrofit.** The existing DSH Agent retry can leave its first
   prompt eligible before restriction lands. Native workers fail closed, but
   should the DSH Agent feature be hardened in a separate issue using the same
   awaited gate?
3. **Monetary cost.** The current usage ledger counts tokens and has no price
   field. Should a later costing slice add provider pricing to per-task usage,
   or is token accounting the contract?
4. **Native DSH delegation tools.** If the deployment composes DSH's own
   `subagent` family, those tools are outside DS Bot's task routing. Should a
   worker deny them as well to make "workers do not dispatch" absolute, or is
   the DS Bot team-tool boundary sufficient?

## Known limits

- A worker is a same-host Session and does not survive host exit.
- A result can report an interrupted/unknown outcome; it cannot prove that a
  worker made no external side effect.
- Delivery dedupe is not exactly-once execution of tools or file writes.
- A worker cannot inherit Bot memory or capabilities by design.
- The full transcript remains in the native Session and is not reproduced in
  `state.json`.
- Worker result delivery can start one model turn in the requesting task
  Session and consumes tokens.
- A task's worker count is lifetime-bound; a task that needs more independent
  jobs must close and open a new task under the existing task-session rules.
