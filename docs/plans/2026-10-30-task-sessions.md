# Task sessions (v2)

- Date: 2026-10-30
- Related: Issue #11
- Supersedes, where they conflict: [Work-branch sessions](2026-10-29-work-branch-sessions.md)
- Base examined: `origin/main` at `7fd222ad6dd09e6651e74c850dcda47215014c2e`

This note is in English. It describes the v2 task model, grounded in the
current host code, and is a design for implementation rather than a report
that the implementation already exists.

## Terms

- **Trunk**: a Bot's current own-chat Session, the one the user normally
  reads. The trunk holds conversation with the user and conclusions, not the
  working detail of delegated tasks.
- **Task**: a first-class record linking a requester and an assignee for one
  bounded piece of work.
- **Task Session**: the requester-side fork or assignee-side fresh Session
  attached to a task. A Bot has at most one Session on each side of a task.
- **Worker**: a native DSH root Session started by `run_worker` for an
  execution subtask. A worker is not a Bot and gets no DS Bot team tools.
- **Requester side**: the participant responsible for the request and its
  conclusion. **Assignee side**: the participant responsible for the work.

## Why v2

The current work-branch code moves delegated detail out of one owner's trunk,
but its ownership is still pair-oriented and Session-oriented:

- `branches.js` `pairOwner()` chooses one Bot from a configured pair.
- `createBranch()` always forks that owner's trunk, in either request
  direction.
- `routeBranch()` reuses the only open branch when the peer sends without a
  branch id.
- `workBranchChoices()` is inserted into the system prompt by `prompt.js`.
- Only the owner has a real branch Session. The peer often continues in its
  trunk, so the same task can still fill the peer's user-facing context.
- `turns.js` can steer a private Bot request into any running turn, including
  a turn the user started or a scheduled turn. The request is handed back to
  a hidden turn afterwards, but the visible turn can already have included
  private text or reasoning in its visible output.

The persistence and recovery work is useful and should be retained. The
model around it needs to become requester/assignee based, with explicit
routing and a fresh context on both sides.

## DSH constraints

These are hard constraints for the implementation:

1. `sessionController.fork({ sessionId, atSeq? })` copies a prefix of a
   Session log. It has no `cwd` parameter.
2. `ctx.workingDirectory.set(agent, path)` changes the working directory of
   one Session. It does not imply a new Session or a new conversation part.
3. `sessionController.create({ cwd | workspaceId })` creates a root Session.
4. `sessionController.prompt({ sessionId, requestId, mode, content })` returns
   an acceptance result. Acceptance is not completion.
5. Completion is observed through the Session's `turn/end` event. Durable
   recovery reads the Session log.
6. Profile recomposition hot-reloads plugins, but stops the old plugin before
   loading the new one. A failed load leaves no plugin.
7. An unhandled async rejection from a plugin listener or timer can exit the
   whole host.
8. A throw from a tool body becomes a tool error. Validation failures may
   therefore be ordinary thrown errors in tool execution.

## Decided design

### 1. Responsibility stays with the requester

The design follows the coordinator/execution split used by PStack:

- A long-lived Bot coordinates, delegates, verifies and reports.
- Execution happens in short-lived task contexts.
- The trunk holds the user conversation plus one conclusion per task.
- Delegation does not transfer responsibility. The requester remains
  responsible for the result, evidence and closure.

This applies to both Bot-to-Bot work and work the user asks a coordinator to
delegate.

### 2. A task is a first-class record

New tasks live in `state.tasks`, keyed by task id. The old
`bot.workBranches` records and `branchByWork` index are upgraded into task
records or compatibility views; they remain loadable.

Required logical fields:

| Field | Meaning |
|---|---|
| `id` | Stable task id, generated when the task opens |
| `title` | First line of the brief, clipped to 80 Unicode code points |
| `brief` | Full task instruction, with the stored prefix bounded as messages already are |
| `requester` | Requester Bot id, or the literal `"user"` |
| `assignee` | Assignee Bot id |
| `state` | `open`, `waiting`, `blocked`, `done`, `cancelled`, or `failed` |
| `sessions` | `{ botId: sessionId }` for both task participants |
| `workdir` | Optional canonical folder for the task |
| `parentTask` | Optional parent task id |
| `openedAt` | Creation time |
| `updatedAt` | Last state or routing change |
| `closedAt` | Terminal transition time, when closed |
| `conclusion` | Optional `{ status, text, evidence?, link? }` |

Implementation metadata is also stored on the record:

| Field | Meaning |
|---|---|
| `phase` | Internal step: `creating`, `ready`, or `closing` |
| `sessionMeta` | Per participant `{ inheritedThrough?, trunkSessionId?, cwd? }` |
| `workIds` | Message exchange ids associated with this task |
| `pendingDelivery` | A task request that was persisted before delivery |
| `summaryId` | Durable id of the one conclusion delivery |
| `summaryDelivered` | Whether that conclusion was flushed and accepted |
| `legacy` | Migration provenance and untouched legacy routing fields |

`state.workers` is a separate top-level table, keyed by worker id. It does not
make a worker a Bot or add it to the roster.

### 3. Task states and transitions

The public states are:

- `open`: a participant can make progress now.
- `waiting`: no participant turn is running, and at least one child request,
  child task, worker, or pending delivery is outstanding.
- `blocked`: terminal result that needs a user or requester decision.
- `done`: terminal successful result with evidence.
- `cancelled`: terminal result closed deliberately.
- `failed`: terminal result caused by creation, delivery, recovery, or worker
  failure.

Allowed transitions:

```text
creating/open -> open <-> waiting
open|waiting -> done|blocked|cancelled|failed
```

`waiting` is informational. It does not permit `done` while dependencies are
still open. Terminal states are not reopened; a follow-up is a new task, with
`parentTask` set when it came from an existing task.

The task's `phase` protects crash recovery:

- `creating`: side effects may be incomplete.
- `ready`: both participant Sessions are recorded and usable.
- `closing`: the conclusion is durable but may not yet have been delivered.

### 4. Which Bots can open tasks

The plugin option becomes:

```js
taskSessions: ["ADA", "Cardpack", "Chief"]
```

Names are resolved exactly as Bot names are resolved today. An unknown or
ambiguous name is ignored and warned about once. The option is a capability
list, not a list of directed pairs.

For the first version, task routing requires both the sender and the target to
be task-enabled. This is provisional pending open question 2, but it preserves
the decided rule that non-task Bots keep today's behavior. A coordinator
delegating to a non-enabled executor uses the existing message path.

`workBranches: [["ADA", "Cardpack"]]` remains a compatibility alias for the
plugin option. Each valid pair enables both named Bots for task routing and
logs one deprecation warning. It no longer implies an owner. If both options
are present, their names are unioned.

Removing a Bot from `taskSessions` stops new tasks but does not hide or break
existing tasks. Existing tasks keep routing, recovery and closure.

### 5. Creation: requester fork, assignee fresh Session

When a task-enabled pair opens a new task:

1. Generate the task id and write the task record with `phase: "creating"`.
2. Save the record with `required: true` before external Session work.
3. Fork the requester's **current trunk**:

   ```js
   sessionController.fork({ sessionId: rt.chatOf(requesterId) })
   ```

   The fork keeps the conversation that explains why the task exists. Record
   the child id under `sessions[requesterId]` and its inherited event boundary
   under `sessionMeta[requesterId].inheritedThrough`.

4. Create a fresh root Session for the assignee. It must not fork the
   assignee trunk and must not copy trunk chatter:

   ```js
   sessionController.create({ cwd: workdir })
   // or
   sessionController.create({ workspaceId: await rt.ensureWorkspace() })
   ```

5. Record the assignee Session under `sessions[assigneeId]`, save, rebuild
   indexes, then resolve and configure both agents:

   - title;
   - Bot model and reasoning effort;
   - permission preset;
   - shared capabilities;
   - task workdir;
   - the Bot identity and memory prompt, which are supplied by the existing
     per-Session system-prompt sections once the task-session index is built.

6. Deliver the initial task brief to the assignee Session with a task-aware
   source, then mark the task `ready`.

The requester task Session does not need a copied task message: it is a fork of
the trunk and receives a stable per-Session task section with the task id,
title, brief and counterpart. The assignee gets the full brief as a task
message. Neither side gets the other side's trunk chatter.

A failure in steps 2-6 leaves the record recoverable. If a Session id was
written, recovery reuses it and never creates a second Session. If creation
may have happened but no id was recorded, recovery fails closed rather than
risk silently duplicating execution.

### 6. Explicit routing

`message_bot` gains:

```js
task: "<task id>" | "new"
```

The old `work` argument is accepted as a deprecated alias during the migration
window and is normalized to `task`. New prompts and receipts use `task`.

Routing is explicit:

- Inside a task Session, no `task` means the current task.
- Inside a task Session, an explicit other task id is accepted only if the
  calling Bot is a participant and the target is the other participant.
- Inside a task Session, `task: "new"` opens a new task. The source Session
  and `parentTask` behavior for this case is an open question below.
- From a trunk with no task, a task-enabled pair opens a new task.
- From a trunk, an explicit task id is accepted only if the task is active,
  the caller is a participant, and the target is the other participant.
- An unknown, terminal, or unrelated task id is refused with the matching
  open task ids, if any, and a reminder that `task: "new"` starts a new task.
- `reply_to: "user"` never opens a task.
- Group messages keep the existing group behavior.

The old "reuse the only open branch" rule is removed. Multiple concurrent
tasks between the same pair are normal and have no implicit winner.

Every request, reply and follow-up carries the task id in its message source
and is delivered to the participant Session recorded by `sessions`. Explicit
`replySessionId` remains an additional routing assertion, not a replacement
for the task link.

`request_id` stays an idempotency key scoped to the caller, task context and
payload. Replaying it returns the original receipt, including the task id.

### 7. User and private turns

- A user message written in a trunk stays in that trunk.
- A user can open either participant's task Session from the task dock.
- A user message written there stays in that task Session and is not copied to
  the trunk or the other participant.
- A user-origin turn in a task Session is visible to the user.
- Bot-to-Bot exchange turns in a task Session remain marked as hidden turns,
  as group and Bot-to-Bot turns are marked today.

A private Bot request must never steer into a user-visible turn. The routing
policy is:

- If the target's current turn is user-origin, scheduled, group-origin, or
  otherwise user-visible, queue the private request for a later turn.
- Steer only when the running turn is already a hidden Bot turn belonging to
  the same private work.
- Never merge a private request into an earlier user-visible inbox message.

This is both a privacy rule and a correctness rule: a private answer must not
depend on a turn whose output the user may already have seen.

### 8. Working folder

A task may carry one canonical `workdir`.

- It is set when the task is opened, or later through a task update tool.
- It is validated with the existing real-path and guarded-folder checks in
  `folders.js`.
- The fresh assignee Session uses it as `create({ cwd })`.
- The requester fork, which cannot take `cwd` in `fork`, is moved with
  `ctx.workingDirectory.set(agent, workdir)`.
- A later change moves every participant task Session with the same method.
- Outside an allowed team folder, the existing folder approval path applies
  before the change.

Task Sessions bypass DS Bot's Bot-folder and conversation-part switching. The
folder move happens in place on that task Session. Native DSH
`working_directory` remains available. Whether a native change should update
the task's shared `workdir` is an open question below.

### 9. Closing, evidence and conclusions

The tool is:

```js
close_task({
  task: "<task id>",
  status: "done" | "blocked" | "cancelled" | "failed",
  conclusion: "<text>",
  evidence?: "<PR, commit, test or path evidence; required for done>",
  link?: "<one URL, absolute path or Session link>"
})
```

`close_work_branch` remains an alias for the migration window:

- it closes the current task when called from a task Session;
- its old `{ status, conclusion, link? }` signature is accepted;
- migrated legacy branch Sessions remain able to close.

Only the requester-side task Session may close a task. The recipient cannot
declare the requester's task done.

`done` requires non-empty evidence. A done close is refused while the task has
any of these, and the tool lists them:

- an open child request in `state.works`;
- a child task with `parentTask` equal to this task and an active state;
- a pending or running worker in `state.workers`.

The conclusion is at most 1000 Unicode code points, including the fixed
rendered header. `link` has the same newline and scheme restrictions as the
current branch link.

Closing is durable before delivery:

1. Set `phase: "closing"`, the terminal state, `closedAt`, conclusion and
   `summaryId`.
2. Save with `required: true`.
3. Deliver one `task-conclusion` message to the requester's current trunk.
4. Mark `summaryDelivered` only after delivery and flush succeed.
5. On restart, inspect the current and original requester trunk logs and
   deliver only if that `summaryId` is absent.

The conclusion appears once in the requester trunk and remains readable in
the task Session. Closed tasks are not archived automatically.

The assignee trunk receives nothing. The assignee already has the task
Session, and a second trunk note would violate the trunk rule, add a hidden
exchange to the user-facing chat and cause another model turn in most cases.
The task dock and conclusion card show the terminal state instead.

### 10. `list_tasks`, not a growing prompt

The current open-branch list is inserted into every identity prompt by
`prompt.js`. That makes the stable prompt depend on mutable task state.

The v2 behavior is:

- The identity prompt contains only the stable task section for the Session
  it is rendering: task id, title, brief, counterpart and closure rules.
- The open task list is returned by `list_tasks`.
- `list_tasks` shows active tasks where the caller is requester or assignee,
  with id, title, counterpart, state, pending children and pending workers.
- The list is scoped to the caller and never injected into another Bot's
  prompt.

### 11. Native workers

`run_worker` is available only in a task Session and only when
`nativeWorkers: true` is configured:

```js
run_worker({
  task: "<task id>",
  prompt: "<self-contained execution brief>",
  workdir?: "<folder>",
  model?: "<provider/model>"
})
```

The `task` id must match the calling task Session.

Worker lifecycle:

1. Create a plain DSH root Session with `workspaceId` or `cwd`.
2. Disable every DS Bot team tool on that agent, using the same deny model as
   the existing DSH Agent in `agents.js`.
3. Select the requested model, or the profile default.
4. Persist the worker record before prompting:

   ```js
   {
     id,
     taskId,
     parentSessionId,
     sessionId,
     state: "prompting" | "running" | "done" | "failed" | "cancelled",
     prompt,
     startedAt,
     completedAt?,
     result?,
     resultDelivered?
   }
   ```

5. Call `sessionController.prompt({ sessionId, requestId: id, mode: "queue",
   content })`.
6. Mark the worker `running` only after the prompt is accepted.
7. Observe that Session's `turn/end`.
8. Read the final assistant text from the Session log, clip it to 4000
   Unicode code points, append a `session:<sessionId>` link, and deliver it
   only to the calling task Session.

The result is a bounded final answer, not the worker's full transcript and not
its tool output. The Session link is the way to inspect the full work.

After a restart or plugin reload, `state.workers` is reconciled with each
worker Session's durable log:

- a logged completed turn settles once and is not re-prompted;
- a turn still running remains running and the normal event listener settles
  it when it ends;
- a worker with no evidence that its prompt was accepted or its turn ran
  becomes `failed` with an explicit unknown outcome, rather than being
  prompted twice.

Worker completion does not wake the requester trunk. It re-enters only the
task Session.

### 12. Self-maintenance without self-reload

A Bot must not install, remove or reload its own `ds-bot` plugin from inside
DS Bot. A plugin cannot safely replace the code that is executing it.

Edits to `ds-bot` run in one of two places:

- a native DSH Agent Session, which uses ordinary DSH tools and survives a
  later `ds-bot` plugin failure while the host remains alive;
- an out-of-band process started outside the plugin lifecycle.

Release sequence:

1. Build the candidate package.
2. Run tests in an isolated profile and data directory.
3. Back up the currently loaded package and its profile entry.
4. Switch the profile/package dependency in the external process.
5. Trigger exactly one recomposition.
6. Verify the loaded plugin version and a fresh boot identity through
   diagnostics.
7. If load or verification fails, restore the backup and trigger one
   recomposition back.

The plugin may check for and describe updates. It may prepare a release. It
must not call `pluginManager.installBundle()` or `removeBundle()` for itself.

### 13. Async-host hardening

All listener bodies, timer callbacks, fire-and-forget promises and worker
completion handlers must return or route their errors into `rt.warn` or
diagnostics. No async function may be launched with a bare `void promise()`.

The current `agents.js` retry interval is an example to fix: it calls
`void restrictTeamTools(waiting)` from a timer. A rejection there can leave the
host with an unhandled rejection. The same audit applies to task creation,
task delivery, worker completion, resume and release helpers.

Tests must fail on an unhandled rejection, not merely print it. A process-wide
swallowing handler is not an acceptable substitute for local handling.

## Data model

Example new task:

```js
{
  id: "8c1c...",
  title: "Check the card pack",
  brief: "Check the card pack against the current archive and report evidence.",
  requester: "ada-bot-id",
  assignee: "cardpack-bot-id",
  state: "open",
  phase: "ready",
  sessions: {
    "ada-bot-id": "requester-fork-session-id",
    "cardpack-bot-id": "assignee-fresh-session-id"
  },
  sessionMeta: {
    "ada-bot-id": {
      inheritedThrough: 127,
      trunkSessionId: "ada-trunk-session-id"
    },
    "cardpack-bot-id": {
      cwd: "<configured-task-folder>"
    }
  },
  workdir: "<configured-task-folder>",
  openedAt: 1790000000000,
  updatedAt: 1790000000000,
  workIds: ["exchange-id"]
}
```

Example conclusion:

```js
{
  status: "done",
  text: "Archive checked. The two mismatches are fixed and covered by tests.",
  evidence: "commit abc1234; ds-bot npm test passed",
  link: "https://github.com/yikson/DS-Bot/pull/42"
}
```

### Indexes

`store.js` maintains:

- `taskBySession`: Session id to `{ taskId, botId, side }`;
- `taskByWork`: work id to task id;
- `workerBySession`: worker Session id to worker id;
- `tasksOfBot`: derived by scanning active tasks, or an indexed inverse;
- `branchOwners` and `branchByWork`: compatibility aliases for migrated
  callers.

`selfOf()` and `isBotSession()` must recognize task Sessions. `chatOwners`
must continue to contain only trunks.

## Invariants

1. A task id identifies exactly one task record.
2. Requester and assignee differ while a task is active.
3. A participant has exactly one Session on each task.
4. A task Session belongs to exactly one task and one Bot.
5. A task Session is never a trunk, group Session, past part or worker.
6. The requester Session is a fork; the assignee Session is fresh.
7. Every task message names the task id and lands in the target participant's
   task Session.
8. Terminal tasks are immutable except for delivery and recovery flags.
9. A terminal task has at most one conclusion.
10. A done conclusion has evidence and no open child request, child task or
    running/pending worker.
11. A private Bot turn never steers into a user-visible turn.
12. User-origin task messages are not routed to the trunk or another Bot.
13. No new task is inferred from "the only open task".
14. Task workdirs are real, allowed folders; unattended folder approval is
    never assumed.
15. Worker Sessions have no team tools and deliver only to their task Session.
16. No task listener, timer or completion promise leaves an unhandled
    rejection.
17. Disabling the feature stops new tasks but does not orphan existing ones.
18. Existing persisted `bot.workBranches` records remain loadable and
    routable.

## File and function changes

This is the implementation map. Names may be adjusted in review, but the
ownership and acceptance points should remain.

### Host state and task lifecycle

| File | Current symbols | v2 change |
|---|---|---|
| `ds-bot/src/host/store.js` | `adopt`, `indexSessions`, `selfOf`, `isBotSession`, owner maps | Add `state.tasks` and `state.workers`; validate fields; migrate legacy branches; build `taskBySession`/`taskByWork`; keep `branchOwners`/`branchByWork` aliases; save before side effects |
| `ds-bot/src/host/branches.js` | `replyTarget`, `deliverySession`, `install`, `createBranch`, `routeBranch`, `sendBranchTask`, `sendAnswer`, `closeBranch` | Replace branch ownership with task helpers: `taskOfSession`, `taskForWork`, `createTask`, `openTaskSessions`, `routeTask`, `sendTaskRequest`, `sendTaskReply`, `closeTask`; keep legacy aliases and `workBranches` projection |
| `ds-bot/src/host/workers.js` | none | New worker registry/lifecycle: `createWorker`, `promptWorker`, `observeWorker`, `settleWorker`, `recoverWorkers`, `cancelWorkersForTask` |
| `ds-bot/src/host/handoffs.js` | `openWork`, `closeWork`, `dropWork`, `workOf` | Attach `task` to work records; preserve parent/child roll-up; expose active children for close checks |
| `ds-bot/src/host/constants.js` | `TEAM_TOOLS`, `BRANCH_SUMMARY_HEADER`, limits | Add task state/status sets, task-conclusion and worker headers, conclusion/result bounds, task/worker tool names |
| `ds-bot/index.js` | `MODULES` | Install task registry and worker registry in dependency order; no circular install-time calls |

### Sessions, prompts and routing

| File | Current symbols | v2 change |
|---|---|---|
| `ds-bot/src/host/tools.js` | `message_bot`, `close_work_branch`, `hideBotUnusedTools`, `activeSessions` | Add `task` and task-open `workdir`; route explicitly; add `close_task`, `list_tasks`, `update_task`; gate `run_worker`; show/hide tools by task capability and task Session |
| `ds-bot/src/host/delivery.js` | `headerFor`, `deliver`, `EXCHANGE_ROLES` | Add task source fields and task headers; resolve the recorded participant Session; add `task-conclusion`; preserve long-message and merge behavior |
| `ds-bot/src/host/turns.js` | `answerSender`, `claimTrigger`, `speaksInGroup`, `turn/end` settlement | Route replies through task ids and participant Sessions; distinguish user-visible from hidden grants; do not auto-close a task from an ordinary turn; apply no-steer rule |
| `ds-bot/src/host/prompt.js` | `promptFor`, `workBranchChoices` block | Remove mutable open-branch choices; add a stable task section when `taskOfSession(id)` exists; point callers to `list_tasks` |
| `ds-bot/src/host/resume.js` | `resumeTurn`, `resumeAll`, branch recovery loops | Recover task creation, pending request delivery, pending reply, conclusion delivery and workers through session logs; keep the existing inflight queue semantics |
| `ds-bot/src/host/permissions.js` | `setPermission`, `applyPermission` | Apply permission changes to every task Session where the Bot participates, including legacy projections |
| `ds-bot/src/host/models.js` | `applyModel`, `selectSessionModel` | Apply model changes to task Sessions; set model explicitly on fresh/assignee and worker Sessions |
| `ds-bot/src/host/capabilities.js` | `trackBotAgents`, `ensureCapabilities` | Track task Sessions as Bot Sessions for capability mounts |
| `ds-bot/src/host/folders.js` | `cleanWorkDir`, `workFolder`, `sessionFolder`, `approveFolder` | Add task folder validation and `setSessionFolder`; use the same guarded-folder rules |
| `ds-bot/src/host/parts.js` | `folderMove`, `startSwitch`, overflow rescue | Exclude task Sessions from Bot/group part switching and folder-move recovery; task context moves in place or closes blocked |
| `ds-bot/src/host/roster.js` | `createSession`, `deleteBot` | Reuse `createSession` for fresh assignee/worker roots; deleting a Bot fails its active tasks, releases task turns and archives all participant Sessions |
| `ds-bot/src/host/agents.js` | `restrictTeamTools`, retry interval | Reuse the deny logic for workers; export a safe restriction helper; catch every retry promise |

### Channel and interface

| File | Current symbols | v2 change |
|---|---|---|
| `ds-bot/src/host/channel.js` | live state `work.branches` | Expose `work.tasks`, task capability, task state, pending worker state and task-session metadata; add task update/close endpoints if needed by the UI |
| `ds-bot/src/host/feed.js` | `chatOwners` stream filter | Stream user-visible task turns without displaying private exchange turns; keep hidden-turn filtering |
| `ds-bot/src/client/sources.js` | branch Session indexing | Index task Sessions as their Bot's detached sessions |
| `ds-bot/src/client/sidebar.js` | `isWorkBranch` handling | Keep task Sessions readable but out of the trunk/part list |
| `ds-bot/src/client/branch-dock.js` | `BranchDock` | Rename/replace with `TaskDock`: task id/title, counterpart, state, worker count, session link |
| `ds-bot/src/client/cells.js` | branch summary card | Render one task-conclusion card with evidence/link and "Open task"; use task labels |
| `ds-bot/src/client/index.js` | branch dock slot and styles | Register the task dock and generated styles |
| `ds-bot/src/client/i18n.js` | work-branch strings | Add task terminology while retaining old strings for migrated records |

### Maintenance and safety

| File | Current symbols | v2 change |
|---|---|---|
| `ds-bot/src/host/update.js` | `start`, `installBundle`, `removeBundle` | Remove self-install/self-remove behavior; expose update description/preparation only; external helper owns the switch |
| `ds-bot/scripts/release-local.mjs` | none | New out-of-band build/test/backup/switch/recompose/verify/rollback driver |
| `ds-bot/src/host/diagnostics.js` | `ownVersion`, `facts` | Report loaded package version plus fresh boot identity so the external verifier can prove the loaded code |
| Task, worker, resume, agent timers/listeners | Existing async callbacks | Route errors to diagnostics; add a lint/test guard against bare fire-and-forget async calls where practical |

### Tests

| File | Change |
|---|---|
| `ds-bot/test/branches.test.js` | Keep as legacy compatibility tests; update expectations to task projections |
| `ds-bot/test/tasks.test.js` | New model, routing, creation, closure and migration coverage |
| `ds-bot/test/workers.test.js` | New native worker lifecycle and recovery coverage |
| `ds-bot/test/bot-messages.test.js` | Add the no-steer regression and task-aware request/reply cases |
| `ds-bot/test/agents.test.js` | Cover task Session tool visibility and worker team-tool denial |
| `ds-bot/test/resume.test.js` or branch resume cases | Cover task and worker recovery through Session logs |
| `ds-bot/test/sidebar-switch.test.js` | Cover task Sessions in the dock and hidden-turn presentation |
| `ds-bot/test/memory.test.js` | Cover inherited boundary for requester forks and fresh memory for assignee Sessions |
| `ds-bot/dev/task-sessions.mjs` | New isolated mock scenario driver for the manual/integration cases below |

## Migration

The saved team format stays `version: 1`; adding fields does not require a
new top-level version.

Migration is additive and conservative:

1. Load `state.tasks` as an object; reject malformed entries rather than
   silently manufacturing execution.
2. Load every existing `bot.workBranches` record and build a task projection
   if no canonical task with the same id exists.
3. Preserve the original `bot.workBranches` records. Do not delete or rewrite
   them during the first implementation.
4. Use the first compatible `state.works[workId]` fields to infer legacy
   requester/assignee:

   - `from` is the requester;
   - `to` is the assignee;
   - the old owner remains the Bot under whose `workBranches` table the record
     was stored.

5. If the direction cannot be inferred, retain a `legacy` marker and keep the
   old close/routing behavior available; see open question 7.
6. Map old states:

   - `open` -> `open`;
   - `closed` -> the conclusion status (`done`, `blocked`, `cancelled`);
   - `failed` -> `failed`;
   - `creating` on a load where no live creator exists -> `failed`, matching
     the current resume behavior.

7. Build both participant entries in `sessions` from:

   - the owner's old branch Session;
   - the target's old `state.works[...].sessionId` or
     `replySessionId`, else its current trunk as a legacy fallback.

8. Preserve `workIds`, `targetBotId`, `trunkSessionId`, `inheritedThrough`,
   `pendingDelivery`, `summaryId`, `summaryDelivered` and old conclusion text
   under the task's `legacy` metadata where needed.
9. New tasks are written only to `state.tasks`. They are not mirrored into
   `bot.workBranches`, because the old single-owner shape cannot represent
   them. This is why rollback requires draining active v2 tasks.

Migration must be idempotent. Running it twice must not create a second task,
change a conclusion, or redeliver a message.

## Test plan

### Unit and harness tests

Run in `ds-bot/`:

```sh
npm test
node scripts/build-client.mjs --check
npm run lint
```

Run the smoke path for changes under `index.js` or `src/host/`:

```sh
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset &&
  node dev/smoke.mjs smoke 3096
dev/bench.sh smoke 3096 8796 stop
```

Required assertions:

1. **Legacy load**: open, closed and failed work-branch records load once,
   route to the expected Session, retain conclusions, and do not require
   `workBranches` to remain configured.
2. **Capability**: `taskSessions` resolves unique names; invalid names warn
   once; `workBranches` pairs enable both names; non-task pairs keep the old
   path.
3. **Creation**: requester gets a fork of its trunk, assignee gets a newly
   created Session, Session ids are saved before delivery, and neither side
   receives trunk text from the other.
4. **Concurrency**: two tasks between the same pair produce two distinct
   requester forks, two distinct assignee roots, separate request receipts,
   and no cross-delivery.
5. **Explicit follow-up**: inside a task no `task` uses that task; `"new"`
   starts another; an unrelated or closed id is refused; no sole-open reuse.
6. **User in task**: a user prompt in a task Session remains there, is not
   forwarded to the trunk, and does not change task routing.
7. **No-steer**: a private request arriving during a user/scheduled visible
   turn queues; it does not appear in that turn's output and is answered in a
   hidden turn.
8. **Workdir**: both participant Sessions receive `workingDirectory.set`; a
   fresh assignee uses `cwd` at create; a native change does not silently
   rewrite the shared task without the decided policy.
9. **Closure**: `done` without evidence is refused; open children/workers are
   listed; exactly one conclusion is delivered; 1000 code points is enforced;
   the assignee trunk receives no conclusion.
10. **Idempotent delivery**: repeated close and restart recovery do not deliver
    a second conclusion.
11. **Workers**: only a task Session can start one; team tools are denied;
    prompt acceptance is not completion; `turn/end` settles one bounded result
    and a Session link; recovery does not prompt twice.
12. **Hardening**: a rejected task/worker timer never raises an unhandled
    rejection; the test harness records and fails on one.

### Isolated branch-enabled mock scenarios

Use the mock model and throwaway data only:

- `dev/task-sessions.mjs` starts an isolated DSH profile with the current
  worktree plugin and a temp `.dsh-test-task-sessions-*` data folder.
- Do not use the user's DSH data or the desktop app's data.
- Configure a task-enabled pair in the profile.
- Count source ids in Session logs and inbox events rather than relying only
  on rendered UI text.

Scenarios:

1. Open two tasks between the same pair concurrently. Check the two pairs of
   Sessions, the task ids in requests, and that each answer lands only on its
   own requester fork.
2. Add a follow-up to each task while the other is active. Check no implicit
   reuse and no cross-delivery.
3. Restart the host with pending dispatch, pending reply and pending
   conclusion. Check one recovery each and no new fork/create.
4. Rebuild/recompose the plugin with an active task. Check the task resumes,
   the new plugin indexes both Sessions, and the old timer/listener set is
   gone.
5. Open the requester task Session, ask as the user, then have the assignee
   answer. Check the user's text stays in the task and no private Bot text
   overwrites a trunk turn.
6. Start a worker, reload while it runs, and verify its result reaches only
   the task Session after resolution from the durable log.

These scenarios are required before any installed build enables
`taskSessions`; unit tests alone are not enough for hot reload or user-visible
turn routing.

## Ordered PR slices

The slices are ordered so each merge leaves a coherent compatibility state.
Each slice includes its own tests and does not edit `CHANGELOG.md`.

### PR 1: Task model, capability and migration

Branch: `feat/task-session-model`

Scope:

- add `state.tasks`, state validation and indexes;
- add `taskSessions` and `workBranches` alias resolution;
- add legacy branch-to-task projections and compatibility functions;
- add `list_tasks`;
- preserve old prompt/routing behavior until the next slice.

Depends on: nothing.

Acceptance:

- all three persisted legacy record states load unchanged;
- indexes resolve task Sessions and work ids;
- `taskSessions` and legacy pairs resolve as designed;
- `list_tasks` returns only the caller's active tasks;
- existing tests and migration idempotency pass.

### PR 2: Explicit routing and dual-Session creation

Branch: `feat/task-session-routing`

Scope:

- `message_bot task` and deprecated `work` normalization;
- requester trunk fork and assignee fresh Session;
- task-aware source, reply and follow-up routing;
- remove sole-open-task reuse;
- stable task prompt and a minimal task dock;
- task-aware resume and deletion paths.

Depends on: PR 1.

Acceptance:

- concurrent tasks, follow-ups, user-in-task and explicit refusal cases pass;
- the recipient never reuses its trunk for a task request;
- task requests and replies carry the task id;
- non-task Bots keep their existing message path.

### PR 3: Private request no-steer fix

Branch: `fix/private-message-steer`

Scope:

- track whether a running turn is user-visible or hidden;
- queue private Bot requests that arrive during visible turns;
- allow steering only within a matching hidden private turn;
- update prompt text and receipts so a Bot knows a queued request may be
  answered later.

Depends on: PR 1 for task-aware turn classification; may be developed after
PR 2.

Acceptance:

- the user/scheduled visible-turn regressions in
  `test/bot-messages.test.js` never expose private text;
- hidden Bot turns still answer normally;
- queue, merge and `request_id` replay behavior remain correct.

### PR 4: Task workdir

Branch: `feat/task-session-workdir`

Scope:

- task `workdir` at open and through `update_task`;
- fresh create with `cwd`, fork move with `workingDirectory.set`;
- guarded-folder approval;
- exclude task Sessions from Bot/group part switching.

Depends on: PR 2.

Acceptance:

- both participant Sessions move to the requested real folder;
- denied/guarded folders leave the task unchanged;
- a native folder change follows the resolved policy;
- no task Session is silently rotated by the Bot folder switcher.

### PR 5: Closure, evidence, conclusions and dock

Branch: `feat/task-session-close`

Scope:

- `close_task` and legacy `close_work_branch` alias;
- evidence gate and child/worker refusal;
- exactly-once conclusion delivery;
- recipient trunk silence;
- task dock and conclusion card.

Depends on: PRs 2 and 4.

Acceptance:

- done without evidence or with open children fails with a useful list;
- conclusion is at most 1000 code points and appears once;
- requester trunk is the only trunk changed;
- restart and duplicate close stay idempotent;
- dock opens the correct task Session.

### PR 6: Native workers

Branch: `feat/task-native-workers`

Scope:

- `state.workers` and worker recovery;
- `run_worker` behind `nativeWorkers`;
- team-tool denial and completion routing;
- bounded result and Session link.

Depends on: PR 5 for closure gating.

Acceptance:

- only a task Session can create a worker;
- worker has no team tools;
- turn/end result reaches only the task Session;
- restart resolves from the Session log without duplicate prompts;
- `done` is refused while a worker is pending or running.

### PR 7: Out-of-band release and async hardening

Branch: `chore/task-release-hardening`

Scope:

- remove plugin self-install/self-remove from `update.js`;
- add isolated release helper with backup, one recomposition, verify and
  rollback;
- expose loaded version/boot identity;
- audit async listeners/timers and add regression tests for unhandled
  rejections.

Depends on: PRs 1-6 for the task-aware lifecycle.

Acceptance:

- the plugin never calls `installBundle` or `removeBundle` for itself;
- the helper builds, tests, backs up, switches, recomposes once, verifies and
  rolls back on a failed load;
- a rejected timer/listener path is recorded and does not terminate the host;
- a failed recomposition leaves a documented restore path.

## Rollback

### Configuration rollback

- Remove names from `taskSessions` or set it to `[]` to stop new task creation.
- Existing tasks still recover, route follow-ups and close.
- Set `nativeWorkers: false` to stop new workers. Existing workers are allowed
  to settle if their Sessions are readable.
- Keep a v2-compatible plugin installed until every active task and worker has
  reached a terminal state.

### Code rollback

Do not run a pre-v2 plugin while v2 task records are active. The old code knows
only `bot.workBranches`; it cannot route new `state.tasks` records and may send
task replies to a trunk.

Drain or cancel active v2 tasks, verify there are no pending conclusions or
workers, then restore the pre-v2 package. Migrated legacy branches remain in
their original tables and can still be read by the old build.

### Data rollback

- Never delete `bot.workBranches` during migration.
- Keep `state.tasks` and `state.workers` as append-only evidence on a failed
  rollout; a later migration can inspect them.
- If a task is malformed, do not invent a Session or a successful conclusion.
  Mark it failed or leave it read-only with a diagnostic.

### Release rollback

The external release helper keeps the previous package and profile entry.
After a failed load or failed version verification, it restores the backup,
triggers one recomposition, and verifies the restored version. The helper must
not depend on the plugin under test for this path.

## Open questions

These are conflicts or gaps found in the current code or the decided text.
They are not silently resolved by this note.

1. **Non-task no-steer precedence.** Section 5 says non-task Bots keep today's
   behavior, while section 7 says private Bot requests must never steer into a
   user-visible turn. Today `turns.js` does steer them. The safety rule should
   probably win for every pair, with "non-task" applying to task creation and
   Sessions only. Confirm before PR 3.
2. **Capability eligibility.** The wording says a task-enabled pair and also
   says the capability is per Bot. Does a task require both participants to be
   enabled, or only the requester? This note uses both to preserve non-task
   behavior and the "pair" wording. Confirm before PR 1.
3. **Nested task source.** From inside a task Session, `task: "new"` may mean a
   child task. The principle says the requester side forks its trunk, but a
   child should probably fork the current task Session and set `parentTask`.
   The current code has no such distinction. Confirm before PR 2.
4. **User as requester.** The record allows `requester: "user"`, but a user has
   no trunk and cannot call `close_task`. The UI needs a close/review action,
   and the conclusion destination for a user-created task is not specified.
   Decide before PR 5.
5. **Native workdir drift.** `folders.js` currently treats a Session's folder
   as fixed when made; DSH's `workingDirectory.set` changes one Session. If a
   Bot uses native `working_directory` inside a task, should `task.workdir`
   change, should only that Session change, or should the task refuse the
   native move? This note treats the task folder as a declared shared target
   and native changes as provisional per-Session moves, pending confirmation.
6. **Self-update contradiction.** `src/host/update.js` currently calls
   `pluginManager.installBundle()` and `removeBundle()` from inside the plugin
   being replaced. That directly contradicts decided rule 10. Decide whether
   the in-app update action becomes a handoff to the external helper, is
   disabled in the first release, or is removed before PR 7.
7. **Legacy direction uncertainty.** A persisted `bot.workBranches` record
   names an owner and a target but not a requester. Most records can be
   inferred from `state.works`, but an early or failed record may have no work
   rows. Should such a record remain legacy-only and closeable from the old
   owner Session, or should it be assigned a best-effort direction? Confirm
   before PR 1's migration is declared complete.
