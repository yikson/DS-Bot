# Task sessions (v2)

- Date: 2026-10-30
- Related: Issue #11
- Revised after the review on PR #12, comment 6500091279
- Supersedes, where they conflict: [Work-branch sessions](2026-10-29-work-branch-sessions.md)
- Base examined: `origin/main` at `7fd222ad6dd09e6651e74c850dcda47215014c2e`

This note is in English. It defines the v1 task-session contract and the
implementation map. It records decided behavior; it is not evidence that the
implementation exists or has passed acceptance.

## Terms

- **Trunk**: a Bot's current own-chat Session, the one the user normally
  reads.
- **Task**: a flat v2 record with one root requester Bot and one or more Bot
  participants.
- **Task-owned Session**: a requester fork or fresh participant Session that
  belongs exclusively to one Bot and one task.
- **Task endpoint**: the Session where one task participant receives work. It
  is either task-owned or, for a non-task-enabled participant, that Bot's
  trunk.
- **Root requester**: the Bot that opened the task. Only its task-owned
  Session can close the task.
- **Participant**: any Bot that has an endpoint on the task after the root
  requester and initial assignee.

## Why v2

The current work-branch implementation:

- chooses one owner from a configured pair in `branches.js` `pairOwner()`;
- always forks the owner trunk in `createBranch()`, whichever side asks;
- reuses the only open branch in `routeBranch()` when no id is supplied;
- exposes mutable branch choices in the system prompt;
- can steer a private Bot request into a user-visible turn in `turns.js`;
- uses a single-owner persisted record that cannot represent per-Bot
  participant endpoints cleanly.

The useful parts are the durable message records, retry/recovery discipline,
and the separation of task detail from a trunk. V2 keeps those ideas while
making the routing, ownership, terminal state and legacy paths explicit.

## DSH constraints

These are hard constraints:

1. `sessionController.fork({ sessionId, atSeq?, allowMigration? })` copies a
   prefix of the Session log. It has no `cwd` parameter.
2. Omitting `atSeq` selects DSH's default boundary, the last completed turn.
   The current delegation and its tool call are not assumed to be inside that
   prefix.
3. A fork of a trunk with no completed turn can fail. The requester then uses
   a fresh Session instead.
4. `ctx.workingDirectory.set(agent, path)` changes one Session only.
5. `sessionController.create({ cwd | workspaceId })` creates a fresh root
   Session.
6. `sessionController.prompt()` requires an `AbortSignal`; its return only
   means the prompt was accepted for execution.
7. Completion is observed from `turn/end`; durable recovery reads the Session
   log. Only a completed turn can produce a successful result.
8. Profile recomposition stops the old plugin before loading the new one. A
   failed load leaves no plugin.
9. A same-host Session is not an external supervisor. It cannot survive a
   host exit.
10. An unhandled async rejection from a plugin listener or timer can exit the
    whole host.

## V1 scope

V1 is deliberately narrow:

- Tasks are created only by a Bot-to-Bot `message_bot` call from a trunk.
- A task is created only when both sides are task-enabled.
- All other capability combinations keep the trunk path. The S1 no-steer rule
  still applies to all Bots.
- Tasks are flat. There are no child tasks, parent pointers, depth counters,
  or task cycles.
- From inside a task-owned Session, `message_bot` keeps the existing task id
  for every target. `task: "new"` is refused there.
- A task-enabled target gets or reuses its own fresh participant Session for
  that task. A non-enabled target uses its trunk as today.
- Only the root requester's task-owned Session can close the task.
- Users cannot create or directly close tasks in v1. A user may talk inside a
  task Session opened from the dock; that conversation stays in that Session.
- `workdir` is only the initial directory for each newly created participant
  Session. There is no cross-Session workdir synchronization.
- Native `working_directory` inside a task Session is Session-only. It must
  not update the Bot, the task's initial folder, or another participant.
- There are no native workers in v1. Their later contract is in "Later:
  native workers".
- There is no new external release tool in v1. Release and rollback are
  explicit out-of-band manual procedures.

Config:

```js
taskSessionsEnabled: false // rollout gate; default off
taskSessions: ["ADA", "Cardpack"] // capability names
```

The legacy option remains:

```js
workBranches: [["ADA", "Cardpack"]]
```

`workBranches` is config compatibility only. Each valid pair contributes both
names to the effective capability set and logs one deprecation warning. It
does not enable `taskSessionsEnabled` by itself.

To stop creating new v2 tasks, remove the names from both `taskSessions` and
`workBranches`, or disable the rollout gate. Existing task records continue
to route and can close from their persisted mode, even after the names or
gate are removed.

## Decided behavior

### Capability matrix and task creation

Let `1` mean task-enabled and `0` mean not task-enabled. The root request is
made from a trunk.

| Requester | Target | Root routing |
|---|---|---|
| `0` | `0` | Today's trunk request/reply path; no task |
| `1` | `0` | Today's trunk request/reply path; no task |
| `0` | `1` | Today's trunk request/reply path; no task |
| `1` | `1` | Open one v2 task |

"Today's trunk path" means the existing endpoint is the target Bot's trunk.
The S1 no-steer hardening still applies: a private request never steers into
a user-visible turn.

A v2 task is opened only when:

- `taskSessionsEnabled === true`;
- the requester is in the effective `taskSessions` set;
- the target is in the effective `taskSessions` set; and
- the call is not `reply_to: "user"` and not from a group.

The task records `mode: "v2"` and the capability snapshot that created it.
Later capability changes do not change the record's mode. Legacy records use
`mode: "legacy"` through their separate compatibility path.

### Flat tasks and participant routing

A task has:

- one root requester;
- one initial assignee;
- zero or more additional participants discovered from later
  `message_bot` calls inside the task.

Participants are not child tasks. A message to another Bot from a task-owned
Session stays under the same task id. The caller's task Session receives the
reply. The task record records each participant's endpoint.

When the target is not yet a participant:

- if the target is task-enabled, create one fresh participant Session and
  attach it to the same task;
- if the target is not task-enabled, use the target's trunk as the endpoint
  and do not put that trunk in an exclusive task-session index.

When the target is already a participant:

- reuse its recorded task-owned Session; or
- reuse its recorded trunk endpoint.

An existing participant stays routable from the persisted record even if its
capability is later removed. A new participant is chosen with the capability
effective at the time of that message.

From inside a task-owned Session:

- `message_bot` with no `task` uses the current task.
- `message_bot` with this task id uses the current task.
- `message_bot` to any Bot stays in this task.
- `task: "new"` is refused.
- Any other task id, a missing task, or a terminal task is refused.

From a trunk:

- no task and a `1/1` pair opens a new task;
- no task in `0/0`, `1/0` or `0/1` uses today's trunk path;
- `task: "new"` opens a task only for a `1/1` pair;
- an explicit existing task id is accepted only when the caller is a
  participant and the target is another participant on that task.

There is no default "only open task" reuse. Two tasks between the same pair,
and concurrent A-to-B and B-to-A tasks, are distinct records with distinct
sessions.

### Fork boundary and explicit brief

The root requester's task Session is created as follows:

1. Call:

   ```js
   sessionController.fork({
     sessionId: rt.chatOf(requesterId),
     allowMigration: false
   })
   ```

   DSH chooses its default boundary, the last completed turn.

2. If the trunk has no completed turn or the fork fails with the corresponding
   boundary condition, create a fresh requester Session instead.
3. Record the actual `inheritedThrough` boundary when a fork succeeds. Record
   `null`/zero provenance when a fresh Session is used.
4. Carry the current delegation explicitly in the task brief. The task section
   in the system prompt and the message sent to participants include the task
   id, title, brief and optional context.

The implementation never assumes that the fork contains the current user
message, the current assistant analysis, the `message_bot` tool call, or the
tool result. Those are supplied by the explicit brief and task provenance.

The recipient participant Session is always fresh. It never forks the
recipient trunk.

### Fresh participant Session

Every fresh participant Session is configured before any prompt or followup:

1. Create the Session with the Bot's standard DSH preset, using the same
   `createSession()` path as the Bot's normal conversations.
2. Select the Bot's model and reasoning effort through `models.js`
   `selectSessionModel()`, preserving the profile default selection.
3. Apply the Bot's permission preset.
4. Mount the same capabilities and tools as the Bot.
5. Put the Session in DS Bot's task-session index so the identity and memory
   system-prompt sections render for the correct Bot.
6. Save the task, participant, endpoint and Session ids before delivery.

The fresh Session has the Bot's identity, permissions and capabilities but
not the other side's trunk history. Its task provenance is explicit.

### Initial workdir and native cd

The task may record `workdir` when it is opened.

- A fresh participant Session uses it as the initial `cwd`.
- A requester fork cannot take `cwd`; after resolving the agent, set the
  initial folder with `ctx.workingDirectory.set(agent, workdir)`.
- A participant added later uses the task's initial workdir when creating its
  Session, otherwise the Bot's normal folder default.
- Approval is checked for every newly created task-owned Session. Approval
  for one Session does not approve another side; a trunk endpoint is not
  moved by task creation.

`workdir` is not a live shared value. It is copied into each newly created
participant Session as its initial directory and then left alone.

Native DSH `working_directory` remains available. The existing `tools.js`
`tools/execute` listener:

- resolves the target path;
- keeps realpath and guarded-folder checks;
- requires approval when the Session's permissions require it;
- still lets the native tool run.

For a task-owned Session, the listener must skip
`rt.updateBot(bot.id, { workDir })` after a successful native move. The move is
Session-only. It must not change `bot.workDir`, the task's initial `workdir`,
another participant's Session, or the participant's approval scope.

There is no v1 `update_task(workdir)` synchronization tool.

### Context capacity and compaction

A task-owned Session stays on one Session id for the life of the task. V1 does
not add a second DS Bot part-switch system for tasks.

`parts.js` currently decides whether a target is a Bot target with:

```js
const isBotTarget = (target) => {
  const id = target?.session?.id
  return id !== undefined && (rt.selfOf(id) !== undefined || rt.roomOf(id) !== undefined)
}
```

Once task Sessions are visible through `selfOf()`, this would also disable
native DSH compaction for them. That is not allowed.

The v1 change is:

- `isBotTarget()` excludes task-owned Sessions;
- `ownedByBot()` therefore does not wrap their compaction;
- the DS Bot compaction wrapper/checkpoint logic does not run for a task-owned
  Session;
- native DSH in-place compaction remains available for pressure, overflow,
  `/compact` and explicit ranges;
- the DS Bot `agent/pre-step` part-switch and overflow rescue paths continue
  to bypass task-owned Sessions.

The Session id, task id, participant address and memory cursor remain stable
across native compaction. A near-full forked trunk is therefore allowed to
compact rather than becoming a dead task with neither compaction nor part
switching.

### Memory review

Fresh participant Sessions are Bot Sessions and must be reviewed as task
provenance, not as the Bot's user chat:

- a fresh Session is reviewed from seq `0`;
- a requester fork is reviewed only after its recorded `inheritedThrough`
  boundary;
- each task Session has its own cursor;
- the review source identifies the task id and Session, and its anchor opens
  that Session rather than claiming a normal own-chat part;
- a Bot-to-Bot task line is never presented to review as a user decision;
- a non-task trunk endpoint keeps its existing memory behavior.

The memory review changes belong to `memory.js` `reviewOf()`, `chatBatch()`,
`reviewChat()` and the review cursor/source helpers. Do not merely add a task
Session to `branchOwners`; that would misclassify task lines as ordinary own
chat and produce invalid part anchors.

Concurrent reviews for the same Bot on different task Sessions are isolated by
task Session/cursor. HMR interruption is recovered by the next review using
the persisted cursor, not by replaying a completed task twice.

### Unified task commit protocol

Every task mutation goes through one per-task serialized commit path:

- open the task and create its participant Sessions;
- save a new participant;
- send a request or follow-up;
- enqueue a reply;
- close the task;
- record a late result.

The serialized path does not rely on process memory alone. It reloads the task
record, checks the task's terminal state and the caller's endpoint, and checks
the current plugin generation before each side effect.

Creation rules:

1. Persist the task with `phase: "creating"` before fork/create.
2. Persist each Session id before using it.
3. Set `phase: "ready"` only after the participant is configured and its
   endpoint is saved.
4. No prompt or followup is sent while `phase !== "ready"`.

Send rules:

1. Acquire the task's serialized lane.
2. Re-read the task and reject a terminal task.
3. Persist the pending send, exchange id, task id and exact endpoint before
   calling `deliver`.
4. Re-check the terminal state immediately before the final inbox enqueue.
5. Enqueue and flush.
6. Mark the send delivered only after the enqueue and flush succeed.
7. If the generation is stopped after an await, leave the durable pending
   record and return "not delivered"; a stopped deliver is not success.

Task ids are required on requests, replies and follow-ups. A terminal task
never falls back to a trunk and never revives because a late message arrives.

### Closing and terminal state

The root requester's task-owned Session is the only Session that may call:

```js
close_task({
  task: "<task id>",
  status: "done" | "blocked" | "cancelled" | "failed",
  conclusion: "<text>",
  evidence?: "<PR, commit, test or path evidence; required for done>",
  link?: "<one URL, absolute path or Session link>"
})
```

A non-enabled participant has no task-owned Session and therefore cannot
close the task. A task-enabled participant other than the root requester also
cannot close it.

`done` requires non-empty evidence and is refused while the task has:

- a pending send to another participant;
- an open request/work tied to this task;
- an active task-owned turn or failure-retry path that can still produce a
  result.

`blocked`, `cancelled` and `failed` may close with outstanding work. Their
pending sends are marked terminal and their active non-caller task turns are
cancelled where possible. The closing caller's current turn ends normally.

Closing is one commit:

1. Serialize against sends.
2. Re-read the task state.
3. Set the terminal state, `closedAt`, conclusion and delivery record.
4. Persist before enqueueing the conclusion.
5. No further send may pass admission after this commit.

The close operation does not try to make future late results look successful.
Every reply or error that arrives after the terminal commit is appended to
the task's `lateReplies` record with:

- an exact count;
- the source exchange/result ids;
- the endpoint Session id;
- the time.

A late reply is not delivered to any trunk, does not reopen the task and does
not change the conclusion. A UI may show the late-result count on the closed
task.

### Exactly-once conclusion delivery

The conclusion is one task-conclusion followup to the root requester's trunk.
The trunk turn it may start is an accepted cost and is counted in model usage.

At the terminal commit:

1. Read the actual requester trunk Session id.
2. Persist:

   ```js
   delivery: {
     summaryId,
     targetSessionId,
     state: "pending" | "enqueued" | "delivered",
     enqueuedAt?,
     deliveredAt?
   }
   ```

3. Enqueue the followup to the recorded `targetSessionId`, not to a newly
   resolved "current trunk" during recovery.
4. Mark `delivered` only after the target inbox is observed and the Session
   flush succeeds.

If a trunk rotates from S0 to S1 to S2 after the record is written, recovery
uses the recorded S1 target and checks its inbox, consumed messages and part
forwarding records. It must not send a second conclusion to S0 or S2.

Delivery dedupe means "one DS Bot conclusion message is admitted once". It
does not mean arbitrary external side effects of a task are exactly-once.
The task's evidence and Session link are the basis for external verification.

### HMR generations and stopped work

Each loaded plugin instance has a generation token and a stopped flag. Every
task async job captures both and checks them after every await before:

- saving a task transition;
- creating or moving a Session;
- enqueueing a message;
- marking a receipt, reply or conclusion delivered;
- scheduling another recovery job.

Current `deliver()` returns an exchange id when `rt.isStopped()` is true. That
return is not delivery. The task layer must consume a typed skipped result or
otherwise distinguish it, leave the persisted pending record in place, and
let the next generation recover it.

Plugin disposal:

- cancels timers and subscriptions;
- prevents old-generation jobs from enqueueing or committing after dispose;
- drains only bounded synchronous state work;
- releases the store lock after the current durable write;
- leaves all incomplete task/outbox records for the next generation.

The old generation may finish an already-started model turn, but its task
handlers must not commit the result after stopped. The new generation settles
from the persisted task and Session log.

### Request receipts in v1

The existing `requests.js` receipt semantics remain in v1. A receipt is saved
pending before the work, and the delivered receipt is written after the work
with a non-required save.

Known crash gap:

if the message executes and the host crashes before the delivered receipt is
saved, a later replay can only return `uncertain`; it cannot prove the work
was not sent. V1 does not claim receipt replay is fail-safe across that crash
window. The receipt includes the task id where available so diagnostics can
connect it to a task, but the uncertain-after-crash behavior remains.

### Legacy compatibility

Persisted `bot.workBranches` records are not projected into `state.tasks`.
They keep their own compatibility path:

- `branchOwners` and `branchByWork` remain available;
- the legacy owner is the requester label for that compatibility record;
- `closed` legacy records are display-only and are never woken, rerun or
  redelivered;
- an `open` legacy record continues the old routing/closure semantics until it
  is closed;
- an old pending delivery or answer is surfaced as a diagnostic and is not
  turned into a new task execution;
- a peer trunk shared by several legacy branches is never put in the
  exclusive `taskBySession` index;
- legacy Session ownership never makes a shared trunk a task-owned Session.

`close_work_branch` remains for open legacy branches. It writes the legacy
record and uses the old delivery path. It does not create a v2 task.

Removing the configuration does not stop existing legacy branches from routing
or closing. Removing `workBranches` from config removes its capability alias,
but does not delete persisted records.

### Self-maintenance

In-plugin self-update is disabled in S1:

- `update.js` may check for a newer version, but `start()` must not call
  `pluginManager.installBundle()` or `removeBundle()` for `ds-bot`;
- every Bot Session, including a task Session, must be denied at execution
  time when it invokes native `plugin_manager` `set`, `install` or `remove`
  for `ds-bot`;
- hiding a tool schema or asking the model not to use it is insufficient;
  the execution guard is mandatory.

A same-host native Session is only isolated from a `ds-bot` plugin failure. It
does not survive a host exit, an app-boot fatal handler, or a failed host
startup. Release and recovery therefore run out of band in a separate process
or isolated profile, never in the plugin being replaced.

## Data model

V2 tasks live in `state.tasks`. There is no `state.workers` table in v1.

```js
{
  id: "task-id",
  mode: "v2",
  title: "Check the card pack",
  brief: "Check the card pack and report evidence.",
  requester: "ada-bot-id",
  assignee: "cardpack-bot-id",
  state: "open",                 // persisted: open | blocked | done | cancelled | failed
  phase: "ready",                // creating | ready | closing
  capabilityAtCreation: {
    requester: true,
    initialAssignee: true
  },
  sessions: {
    "ada-bot-id": "requester-task-session-id",
    "cardpack-bot-id": "assignee-task-session-id",
    "editor-bot-id": "editor-trunk-session-id"
  },
  participants: {
    "ada-bot-id": {
      role: "requester",
      kind: "fork",              // fork | fresh | trunk
      inheritedThrough: 127
    },
    "cardpack-bot-id": {
      role: "assignee",
      kind: "fresh",
      initialWorkdir: "<configured-folder>"
    },
    "editor-bot-id": {
      role: "participant",
      kind: "trunk"
    }
  },
  workdir: "<configured-folder>",
  openedAt: 1790000000000,
  updatedAt: 1790000000000,
  closedAt: null,
  conclusion: null,
  pendingSends: {},
  lateReplies: { count: 0, ids: [] }
}
```

`waiting` is a derived display state when `state === "open"` and at least one
task endpoint has outstanding work. It is not a second persisted truth.

Task-owned Sessions (`kind: "fork"` and `kind: "fresh"`) are indexed in
`taskBySession`. A trunk endpoint (`kind: "trunk"`) is only an address in the
task record and remains indexed by `chatOwners`; it is not inserted into
`taskBySession`, `taskOwners` or any exclusive task index.

The close record is stored separately from the public conclusion:

```js
{
  conclusion: {
    status: "done",
    text: "Archive checked; mismatches fixed and covered by tests.",
    evidence: "commit abc1234; ds-bot npm test passed",
    link: "https://github.com/yikson/DS-Bot/pull/42"
  },
  delivery: {
    summaryId: "task-id:closed",
    targetSessionId: "requester-trunk-session-at-close",
    state: "pending"
  }
}
```

## Invariants

1. A v2 task has exactly one root requester.
2. A v2 task is created only for a `1/1` capability pair.
3. The task records its creation mode and capability snapshot.
4. A task has at most one endpoint per Bot.
5. Only fork/fresh task-owned Sessions enter exclusive task indexes.
6. A trunk endpoint never becomes a task-owned Session.
7. A requester fork uses DSH's default boundary with
   `allowMigration: false`; first-turn/no-completed-turn falls back to fresh.
8. The current delegation is carried explicitly in the brief; inherited
   prefix content is never assumed to contain it.
9. A recipient participant starts in a fresh Session.
10. Task-owned Sessions have the correct Bot identity, preset, permission,
    model/effort, capabilities and memory provenance before execution.
11. A task-owned Session uses native in-place compaction and is not wrapped by
    DS Bot's part-switch/compaction steward.
12. A fresh task Session's memory review starts at seq 0; a requester fork
    starts after its inherited boundary.
13. Task messages carry the task id and route only to the recorded endpoint.
14. Inside a task, a message to any Bot stays in that task.
15. `task: "new"` is refused inside a task.
16. Only the root requester's task-owned Session can close.
17. Send and close share one serialized per-task commit path.
18. Every side effect is preceded by a durable intent record and followed by a
    durable completion record when appropriate.
19. A terminal task refuses sends and never revives.
20. Late replies after terminal are counted and identified but not delivered
    to a trunk.
21. A conclusion is one followup to the recorded requester target Session.
22. A skipped delivery because of HMR/stop is not success.
23. Removing a Bot archives only that Bot's task-owned Sessions; trunk
    endpoints and other participants' Sessions are not archived by task code.
24. Legacy work branches keep their own owner-requester compatibility path.
25. In-plugin self-update and execution-level `plugin_manager` self-change are
    denied.
26. No task/listener/timer path leaves an unhandled rejection.
27. User-originated task creation and nested tasks are absent from v1.

## File and function changes

### S1: safety foundation

| File | Current symbols | Required change |
|---|---|---|
| `ds-bot/src/host/turns.js` | `claimTrigger`, `user/message`, `turn/end`, `answerSender` | Record the visible/hidden trigger class; private Bot requests queue rather than steer into user-visible turns |
| `ds-bot/src/host/tools.js` | `message_bot`, `hideBotUnusedTools`, `tools/execute` | Apply the no-steer admission rule; add execution-level denial for `plugin_manager` set/install/remove of `ds-bot` |
| `ds-bot/src/host/update.js` | `start`, `installBundle`, `removeBundle` | Disable in-plugin self-install/remove; keep version checking only |
| `ds-bot/src/host/agents.js` and other timer/listener users | `setInterval`, fire-and-forget callbacks | Route every rejection through diagnostics; add tests that fail on unhandled rejection |
| `ds-bot/test/bot-messages.test.js`, `agents.test.js`, `install.test.js` | existing security/routing tests | Add visible-turn no-steer, self-update deny and async-host regressions |

### S2: task core

| File | Current symbols | Required change |
|---|---|---|
| `ds-bot/src/host/store.js` | `adopt`, `indexSessions`, `selfOf`, `isBotSession`, owner maps | Add `state.tasks`, v2 record validation, task-owned indexes and generation-aware saves; keep legacy branch indexes separate |
| `ds-bot/src/host/branches.js` | current branch lifecycle | Keep legacy owner-requester routing and add separate v2 task lifecycle: create, participant endpoint, send, close, terminal guard, late-result record |
| `ds-bot/src/host/tools.js` | `message_bot`, `working_directory` hook, `close_work_branch` | Add `task` routing, `list_tasks`, `close_task`; apply task-only cd branch that skips `updateBot`; keep `close_work_branch` legacy-only |
| `ds-bot/src/host/delivery.js` | `deliver`, `headerFor`, `EXCHANGE_ROLES` | Persist task/exchange/endpoint intent; add task headers and typed skipped result; do not count stopped return as delivery |
| `ds-bot/src/host/turns.js` | `answerSender`, turn settlement | Route task replies to the caller task endpoint; record late replies after terminal; preserve legacy branch routing |
| `ds-bot/src/host/handoffs.js` | `openWork`, `closeWork`, `dropWork`, `workOf` | Link work to a task id; expose pending task work for `done` refusal and terminal cancellation |
| `ds-bot/src/host/prompt.js` | `promptFor`, `workBranchChoices` | Remove mutable open-task choices; render a stable task section for task-owned Sessions; direct callers to `list_tasks` |
| `ds-bot/src/host/resume.js` | branch recovery | Recover v2 task creation, pending sends, typed stopped deliveries, conclusions and late-result records; keep legacy recovery |
| `ds-bot/src/host/permissions.js` | `setPermission`, `applyPermission` | Apply Bot permission changes to task-owned Sessions; never apply a group permission to a task |
| `ds-bot/src/host/models.js` | `applyModel`, `selectSessionModel` | Select model/effort for fresh participant Sessions without changing profile defaults |
| `ds-bot/src/host/capabilities.js` | `trackBotAgents`, `ensureCapabilities` | Track only task-owned Sessions as Bot Sessions for capability mounts |
| `ds-bot/src/host/folders.js` | `cleanWorkDir`, `workFolder`, `approveFolder` | Validate initial workdir and approve each target Session independently |
| `ds-bot/src/host/parts.js` | `isBotTarget`, `ownedByBot`, `agent/pre-step`, overflow rescue | Exclude task-owned Sessions from DS Bot compaction wrapping and part switching so native in-place compaction runs |
| `ds-bot/src/host/memory.js` | `reviewOf`, `chatBatch`, `reviewChat`, cursors | Add task provenance, seq-0 fresh review, inherited-boundary review, task anchors and independent cursors |
| `ds-bot/src/host/roster.js` | `deleteBot`, `createSession` | Archive only deleted Bot's task-owned Sessions; leave other endpoints; reuse standard preset for fresh task Sessions |
| `ds-bot/src/host/channel.js` | live `work.branches` | Expose task records, participant endpoints, terminal/late state and delivery status |
| `ds-bot/src/client/branch-dock.js` | `BranchDock` | Replace with flat `TaskDock`: task id/title, endpoint, state, late-result count, open task Session |
| `ds-bot/src/client/cells.js`, `sidebar.js`, `sources.js`, `i18n.js` | branch UI | Keep legacy branch rendering; add v2 task/normal-trunk endpoint distinction |
| `ds-bot/index.js` | module order | Install task lifecycle after state/delivery dependencies and before resume; keep legacy branch install path |
| `ds-bot/test/tasks.test.js`, `branches.test.js`, `resume` cases, `memory.test.js`, `sidebar-switch.test.js` | existing tests | Add the matrix, terminal, migration, memory, compaction, HMR and UI tests below |

The worker module, `run_worker`, `state.workers`, worker restrictions and worker
recovery are intentionally absent from S1/S2/S3.

## Integration and acceptance tests

Run in `ds-bot/`:

```sh
npm test
node scripts/build-client.mjs --check
npm run lint
```

Run the smoke path for host changes:

```sh
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset &&
  node dev/smoke.mjs smoke 3096
dev/bench.sh smoke 3096 8796 stop
```

Use the mock model and isolated `.dsh-test-task-sessions-*` data only. Never
point a test at the user's DSH data or the desktop app's data.

### Capability and route matrix

Test all four root combinations:

- `00`: no task; existing trunk request/reply;
- `10`: no task; existing trunk request/reply;
- `01`: no task; existing trunk request/reply;
- `11`: one task; requester fork/fresh plus assignee fresh.

Also test:

- removing capability after a task opens: existing task still routes and
  closes;
- removing names from both config lists: no new task, existing task closes;
- `workBranches` alias still present: it contributes names but does not
  bypass the rollout gate.

### Session and fork scenarios

- first user turn, no completed turn: requester falls back to a fresh Session;
- completed-turn fork: explicit brief contains the current delegation even
  when the last completed prefix does not;
- fork with `allowMigration: false` and recorded inherited boundary;
- first-turn fork failure, running trunk, concurrent trunk writes;
- two concurrent tasks for one pair, plus concurrent reverse-direction tasks;
- same `request_id` in two different tasks does not collide;
- a message from a task to another Bot:
  - enabled target gets one fresh participant Session;
  - already-added task target reuses its endpoint;
  - non-enabled target uses its trunk endpoint;
  - reply returns to the caller's task Session;
- `task: "new"` inside a task is refused.

### Commit, terminal and failure injection

- close/send/close race;
- close while a task-owned turn is active;
- `done` with pending work, no evidence, and after all work settles;
- each terminal state: `done`, `blocked`, `cancelled`, `failed`;
- late reply after every terminal state: count/id recorded, no trunk, no
  revival;
- fault injection after task create/fork, each Session save, each endpoint
  save, each pending-send save, before/after inbox enqueue, before/after flush,
  and before/after receipt/conclusion/result acknowledgement;
- crash between every side effect and its save; recovery is idempotent;
- full host restart with a v2 task and with a legacy open branch;
- deleting the root requester, the assignee, and an additional participant;
  only the deleted Bot's task-owned Sessions are archived.

### Conclusion and HMR

- S0 -> S1 -> S2 trunk rotation after close: recovery checks the recorded S1
  target and sends no duplicate to S0/S2;
- conclusion starts at most one trunk followup turn; its model cost is counted;
- summary delivery dedupe does not claim external side effects are
  exactly-once;
- old-generation async jobs cannot save/enqueue after stopped;
- skipped stopped delivery remains pending and is not marked delivered;
- new generation and old generation both attempt recovery: one durable
  conclusion and no duplicate task send.

### Workdir, compaction and memory

- initial workdir for requester/fresh task-owned endpoints; trunk endpoints
  are not moved by task creation;
- native cd inside a task Session does not call `updateBot`, does not change
  the other endpoint or task initial workdir, and preserves realpath,
  guarded-folder and per-Session approval checks;
- near-full trunk fork and a long task: native compaction works; task Session
  id/address remains stable;
- fork cost measurement: wall time, peak/extra memory, disk/log size and
  first-model prompt tokens, with no fabricated pre-existing numbers;
- fresh task Session memory review starts at seq 0;
- requester fork review starts after `inheritedThrough`;
- concurrent memory reviews for the same Bot on two task Sessions keep
  separate cursors and anchors;
- a Bot-to-Bot task line is not treated as a user decision.

### Legacy and user visibility

- old open branch maintains old routing and closes through the old path;
- old closed branch is display-only and never wakes a model or redelivers;
- old peer trunk is absent from `taskBySession`/`taskOwners`;
- user opens a task Session from the dock and talks there: text stays in that
  task Session, does not change root ownership and is not forwarded;
- no user-created task UI, no nested task UI, no worker UI in v1.

## Delivery slices

All v2 code is merged with `taskSessionsEnabled: false` by default. The code
may arrive as multiple PRs/commits, but the task core is not enabled until S3
acceptance passes.

### S1: safety foundation

Branch: `fix/private-steer-self-update-hardening`

Scope:

- no-steer for all Bots, including non-task pairs;
- execution-level denial of `plugin_manager` self set/install/remove;
- disable in-plugin self-update install/remove;
- unhandled-rejection and timer/listener hardening.

Acceptance:

- visible-turn no-steer regression passes;
- Bot calls to plugin-manager self-change are refused at the execution
  boundary;
- no plugin self-install/remove path remains;
- timer/listener fault tests do not leave an unhandled rejection.

### S2: task core closed loop

Branch: `feat/task-sessions-v2`

Scope:

- read-only compatibility model for legacy work branches;
- v2 task model, capability and route matrix;
- requester fork/fresh, explicit brief and recipient fresh Session;
- fresh/fork model, preset, permission, capability and memory setup;
- send/close serialization and terminal late-result handling;
- exactly-once v2 conclusion followup to the recorded target;
- initial workdir and task-only native cd;
- native compaction exclusion, task memory review, task dock and
  `list_tasks`;
- existing legacy branch path.

This may be split into implementation PRs/commits by subsystem, but no
intermediate merge enables v2 task creation. The default remains
`taskSessionsEnabled: false`; `workBranches` does not turn it on.

Acceptance:

- complete matrix and lifecycle tests above pass with the flag on in
  isolation;
- with the flag off, no task is created and no legacy path changes;
- flag on is tested only after all S2 parts are present.

### S3: isolated acceptance and release procedure

Branch: `test/task-sessions-acceptance` or the S2 branch before enabling.

Scope:

- isolated mock scenarios, concurrency, crash/HMR, memory and compaction;
- real UI task dock/user-inside-task demonstration evidence;
- manual out-of-band install/reload/rollback procedure;
- v2-aware rollback gate for existing task data.

Acceptance:

- all scenarios in this note pass against the current worktree and mock
  profile;
- existing `npm test`, client check, lint and host smoke pass;
- a UI change has a real task-dock/task-Session demonstration;
- rollback to a pre-v2 target is refused once v2 task data exists.

### Later: native workers

No worker code ships in S1/S2/S3. A later worker slice must be separately
flagged and default off. Its minimum contract is below.

## Manual release and rollback

V1 does not add a release helper or a general plugin manager. The release
operator works out of band:

1. Build the candidate from a clean checkout.
2. Run isolated tests and the mock acceptance profile.
3. Back up the current package, profile entry and team data.
4. Stop the host. A same-host Session cannot supervise this step.
5. Switch the profile/package dependency from outside the plugin.
6. Start/recompose once and verify the loaded `botVersion` through
   diagnostics plus a basic health check.
7. On load/health failure, restore the backup from outside the plugin and
   start/recompose once.
8. Before any rollback, inspect `state.tasks`: once a v2 task exists, the
   rollback target must be a v2-aware build. A pre-v2 build is not an
   acceptable rollback target.

Normal operational rollback:

- disable the rollout gate and remove names from both capability lists to
  stop new tasks;
- keep a v2-aware plugin installed while existing tasks route/close;
- do not rely on an in-plugin update or a replacing plugin to roll itself
  back.

## Later: native workers

This section records the reviewed API constraints; it is not v1 scope.

`run_worker({ task, prompt, workdir?, model? })` would:

1. Create a native DSH Session with an explicit worker preset, permission and
   model/effort. It must not inherit Bot memory or Bot capabilities.
2. Apply an execution-level deny of every team tool, including future tools,
   and wait for the restriction to succeed before prompting.
3. Use `sessionController.prompt({ sessionId, requestId, mode, content },
   signal)`. The signal is mandatory and `signal.throwIfAborted()` is called
   before work.
4. Install the completion listener before prompt and correlate the exact turn
   with `rpcId === workerId`.
5. Treat prompt acceptance only as accepted; confirm durability/flush
   separately.
6. Treat only `turn/end.reason.kind === "completed"` as success. `error`,
   `aborted` and `interrupted` are distinct failures.
7. Resolve a host crash after acceptance but before completion as
   interrupted/unknown. Do not auto-rerun a one-shot worker that may already
   have written files.
8. Deliver a bounded final assistant result with a stable result id and a
   Session link. The 4000-code-point bound includes the wrapper and link.
9. Deduplicate result delivery on restart; do not call delivery dedupe
   external-side-effect exactly-once.
10. Give the worker's explicit workdir the same realpath, guarded-folder and
    approval checks as the task Session; `workingDirectory.set` changes the
    directory, not permissions.

The worker result returns only to the calling task Session. It never wakes a
trunk directly.

## Known limits

- Receipt replay remains uncertain after the documented crash window.
- A non-enabled participant receives task work in its trunk; per-side context
  isolation applies only to a task-owned Session.
- A conclusion may start one model turn in the requester trunk and costs
  tokens.
- Delivery dedupe is not external-side-effect exactly-once.
- V1 has no native workers, nested tasks, user-created tasks, cross-side
  workdir synchronization, or in-plugin release.
- A fork is a copied event prefix, not a zero-cost pointer. Its time, memory,
  disk and first-model-context cost must be measured for near-full trunks.
