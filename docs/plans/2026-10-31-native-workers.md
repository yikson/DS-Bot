# Native workers

- Date: 2026-10-31
- Related: Issue #41, PR #42; reviewed at `2365efda`
- DS Bot base examined: `3c34c2dd9e9951a7fba8f357b92e795b25a5fc06`
- DSH source examined: `687f282e8625c6b8d11ff58211a90524be2e4317`
- Revised for review R1-R13, the three-item re-review and the maintainer's
  decisions on 2026-10-31

This English note defines the implementation contract, not completed runtime
acceptance. The review decisions below supersede the earlier text of this note.
The [task-session contract](2026-10-30-task-sessions.md), including flat tasks,
in-place compaction, root closing authority and terminal commit, still applies.

## Purpose and scope

The poteto/pstack split is the purpose: Main Bots and PMs coordinate and verify;
native workers execute self-contained jobs. A worker is one fresh native DSH
root Session owned by one task and one requesting participant Session. It has
no Bot identity, Bot memory review, or Bot MCP capabilities. It never becomes a
long-lived teammate or a central dispatcher.

The coordinator provides the brief, checks evidence and decides follow-ups.
Results return only to that exact task Session. Worker completion does not send
a trunk summary; the task retains its single `${taskId}:closed` conclusion.
DSH's normal tools, loop, model routing and native Session UI do the execution.
There is no second agent runtime or subagent-provider ownership model.

Workers cannot dispatch through DSH tools. This is an execution policy over
DSH tool calls, not process isolation: an allowed shell can still start another
process or agent CLI. That limit is explicit under Known limits.

## Source checks and supported DSH APIs

These are source findings at the DSH commit above. They must also pass on the
fixed target runtime in W1; source inspection is not runtime acceptance.

| Concern | Public API and inspected source | Contract |
|---|---|---|
| Creation and model | `ctx.agents.create({ sessionId, agentOptions, meta, setup })`; `packages/core/agent/README.md`, `src/index.ts` | The documented root factory accepts initial provider, model and reasoning effort without a profile-default write. Omit `parentAgent`; do not spawn a DSH subagent |
| Default preset | `ctx.agentPresets.resolve()` and `mount(agentCtx, id)`; `packages/preset/agent-preset-registry/src/index.ts` | Resolve and mount the deployment's default preset in unpublished setup, recording its id in Session metadata. No custom worker preset is required |
| Durable route authority | Controller model-selection projection and `request/header`; `packages/api/session-controller/src/agent.ts` | With a request header present, controller cold resume reads the route/effort from DSH's own durable state. Workers install no second model helper; a headerless restart closes worker admissions |
| Controller alternatives | `SessionCreateRequest`, `SessionCommandController.selectModel`; `packages/api/session-controller/src/types.ts`, `commands.ts` | Controller create has no model/effort parameter. Controller selectModel writes the profile default in the background; workers use the supported root-factory path instead |
| Sandbox | `setSandboxMode(session, mode)` from `@deepseek-ai/dsh-sandbox-policy`; `sandboxPolicy.resolve({ session })` | Apply/read actual mode values. `workspaceRoot` uses immutable `session.header.cwd`; live cd is a separate value |
| Approval | `setApprovalPolicy(session, 'never')` from `@deepseek-ai/dsh-user-approval` | `never` automatically rejects every operation requiring approval before answerers are consulted |
| Execution policy | `ctx.tools.guard`, with the `tools/pre-execute`/final-guard pattern already used by S1b in `tools.js` | A monotonic name-based execution deny covers scoped registrations and native/PTC sub-calls. It does not bind a tool definition across the later `tools/execute` await; `tools.restrict` only affects presentation |
| Admission | `sessionController.prompt(request, signal)` | Signal is mandatory. `{ accepted: true }` is inbox admission, not completion or flush. The controller may await inside admission after its entry signal check |
| Correlation | `agent/inbox/inserted`, `agent/inbox/claimed { message, turn }`; `packages/core/agent-loop/src/inbox.ts` | Persist/replay `agent/inbox/spliced`; bind the identified message to its claimed turn before any `user/message` exists |
| Lifecycle | Awaited serial `agent/created`; `Agent.cancel`, `whenIdle` | Creation holds queued work until listeners finish. Cancellation acknowledgement is only a request; quiescence needs evidence |

The root-factory creation path supplies provider, model and reasoningEffort
only through `agentOptions`. Prompt that newly created Agent immediately after
its required setup/durability checks so the first DSH `request/header` records
the actual route and effort. Workers do not install `installModelSelection`,
append a competing model-selection event, call `sessionController.selectModel`
or write `agentDefaultModel`. DSH's own request header and controller replay
remain the single durable authority. Its native Session remains addressable
by the ordinary controller prompt/cancel/history APIs, subject to the
headerless-restart refusal below.

Existing S2 task Sessions still use `models.js` `selectSessionModel`: that
wrapper selects through the controller and attempts to restore the default.
It does not guarantee isolation from concurrent UI selection or failed
restoration. That S2 limitation remains outside this worker slice; workers do
not repeat the mechanism. If a target DSH lacks the supported Session-scoped
creation/routing API, worker admission is refused with a clear compatibility
error rather than silently falling back to the profile-writing wrapper.

## Eligibility and tools

A new run requires all of:

- `nativeWorkers === true`;
- an open, ready task and its exact recorded task-owned participant endpoint;
- a Bot that exists and is task-enabled **at call time**, using
  `taskCapabilities()`;
- writable state, current generation, resolved worker policy and permission
  services.

This includes later-added task-owned PM participants. No task-creation
capability snapshot is consulted. Trunks, shared-trunk task handlers, groups,
legacy branches and workers cannot start runs. Removal of capability or the
rollout flag refuses new runs, including follow-ups; it does not invalidate
history or prevent cancellation, result settlement or task closure.

Worker tools are scoped to eligible task-owned Sessions. Execution repeats
eligibility after every admission await and immediately before its side effect;
schema presence is not authority. Invalid input, wrong ownership, exceeded
limits, unsupported APIs and refused paths are tool errors, with no trunk
fallback.

### `run_worker`

```text
run_worker({
  prompt,
  title?,
  mode?: "execute" | "verify",
  workdir?,
  model?,
  effort?,
  permission?: "read-only" | "workspace-write"
})
```

`prompt` is nonempty and self-contained. Title defaults to its first nonempty
line, capped at 80 Unicode code points. Mode defaults to execute. `permission`
selects a sandbox mode, not a named permission preset or an approval policy.
Full-access workers are out of scope and an explicit full-access request is
refused.

After bounded admission/setup, return `started worker <id>` without waiting for
the run's result. There is no blocking option: the coordinator can launch its
two independent jobs and keep working, then end its turn when only waiting
remains. Results enqueue a later turn in the same task Session.

### `worker_followup`

```text
worker_followup({ worker, message })
```

Only the exact requesting task Session may continue its worker. The prior run
must be completed, failed or unknown, its result must be settled, and the
native Session must actually be idle with no pending worker admission/input.
A cancelled run or worker whose admissions are closed cannot be continued.
In particular, restart before the first request header permanently refuses
follow-up on that Session; the PM must call `run_worker` for a new worker.
Unknown means the prior outcome may have external effects; the coordinator
should inspect its Session before proceeding.

An accepted follow-up starts a new run in the same worker Session, retaining
its current cd and DSH's own durable route/effort when a header exists. It
never reapplies a route from the worker record, resets cd to initial workdir
or raises permission. No goal/automatic continuation is used.

### `cancel_worker`

```text
cancel_worker({ worker })
```

Only the requesting task Session controls this worker. Cancellation remains
available for its existing workers after gate/capability removal. It requests
stop and waits a bounded time for evidence; a timeout reports `cancelling`,
not cancelled. Repeating cancellation is idempotent. Idle completed/failed/
unknown history is retained; cancellation closes that worker to future runs.
The exact protocol is under Run states, cancellation and recovery.

### Listing

Extend `list_tasks` rather than add `list_workers`. Within a task Session,
show worker id, mode, current run state, elapsed time, result status and native
Session link. Listing grants no control over another participant's workers.
There are no worker rows on Bot trunks or extra Bot/sidebar identities.

## Configuration and model selection

```js
{
  nativeWorkers: false,
  workerModel: undefined,
  verifierModel: undefined,
  maxWorkersPerTask: 2,
  maxWorkerFollowups: 2
}
```

`workerModel` and `verifierModel` accept `provider/model` or
`{ provider, model, effort? }`. Explicit model arguments also accept a unique
model id/name through `resolveModel`. Configured unavailable routes and
unsupported explicit/configured efforts are errors; they do not silently pick
another model.

Execute route: explicit argument, then `workerModel`, then the requesting task
Session's effective Bot route. Verify route: explicit argument, then
`verifierModel`, then `workerModel`, then that same Bot fallback.

Effort precedence is explicit argument, selected configuration entry's effort,
Bot effort when supported by the selected route, then the model default.
Changing route does not carry an incompatible Bot effort to another model.
An explicit model override does not inherit a different config entry's effort.

There is no model-family inference. Without `verifierModel`, verification
independence relies on a fresh Session only; it does not promise a different
model or family. Read-only is the verification permission boundary.

Persist the requested initial route/effort for admission/audit and pass them
only as `ctx.agents.create` `agentOptions`. There is no second worker model
helper or select/restore operation to serialize. The first prompt follows
creation immediately after setup/flush, using that live Agent; check its actual
request header/effort in acceptance. Later config changes affect new workers
only. Follow-up and cold resume use the controller's own header/projection;
the initial route in the worker record is not a competing restore authority.

If the host restarts after creation but before any `request/header` exists,
record the run as unknown, set `admissionsClosed` with reason
`restart-before-first-header`, and never prompt that worker Session again.
Refuse follow-up and native UI/API activation before model work can run;
history remains readable. The PM may start a new `run_worker` within the normal
admission limits. This prevents a headerless cold resume from running on the
profile default, without adding another model-selection middleware.

Limits are nonnegative safe integers and constrain only **new admissions**:
at most two lifetime worker records per task by default, and at most two
accepted follow-ups per worker. A value of zero refuses new admissions of
that kind. There is no wait queue. Reducing a limit never invalidates existing
records; validation checks stored counts structurally, not against config.

## Permissions and directories

### No approval path

Every worker has approval policy `never`. Apply it with the documented direct
setter during setup, read back its durable policy, and reassert it on resume
and before dispatch. Anything needing approval is automatically denied.
Neither a PM nor a human approval answerer is consulted.

There is no worker approval UI, answerer, approval-wait state, or initial
`approveFolder()` call. In particular, setup must not ask for approval from
an idle worker outside an open turn. Closed approval pages, disconnection and
absent answerers cannot strand a worker because it has no approval path (R5).

### Effective sandbox and tightening

Read `sandboxPolicy.resolve({ session: requesterAgent.session })`, not
`bot.permission`, a preset name, or the profile default alone. Read the actual
Session approval facts too for diagnostics; ask/never on the requester never
changes the worker's forced `never`.

Execute defaults to the minimum of the requesting task Session's effective
sandbox and workspace-write. Verify always uses read-only. A lower explicit
mode is allowed; a higher mode than the effective requester is refused.
An explicit workspace-write request in verify mode is refused.

Use `setSandboxMode(workerSession, selectedMode)` and verify with
`sandboxPolicy.resolve`. No named `read-only` preset is required. If the target
cannot apply and verify read-only through the documented API, refuse verify
mode with `Worker verification requires supported read-only sandbox control`.
Missing sandbox/approval enforcement services refuse worker setup generally.

Workers are added to a permission-propagation index keyed by requesting Bot
and task Session, alongside the task-Session propagation path. This index is
not a Bot-identity index. `setPermission` tightening applies immediately to
running workers as well as idle ones. Actual requester `sandbox/mode` changes
and changed effective policy are also reconciled; every worker dispatch
rechecks the current ceiling and denies while reconciliation is incomplete.
Raising the Bot or requester ceiling never raises an existing worker.

Persist the reduced worker mode, apply it to the live native Session and
verify/flush. Cancel in-flight worker work on tightening rather than claim
that a changed mode retroactively confines an already-started process.
Subsequent confined operations read the new mode. UI changes in a worker cannot
grant `ask` or wider mode: reconcile back to its recorded ceiling or deny.
Cold resume reads policy before releasing queued tool work. An unreadable
requester during reconciliation denies further worker execution; deleted Bots
are handled by terminal settlement, not by rejecting historical data.

### Immutable root and live cd

The worker's `header.cwd` is the requesting task Session's `header.cwd`.
Persist that root, canonicalize its realpath, and verify it matches the
requester's resolved sandbox root. Never use the requester's current cd as
the worker's header cwd. Missing/ambiguous roots fail closed.

The starting live cd defaults to the requester's current cd, but both it and
an explicit absolute `workdir` must resolve to an existing directory inside
that canonical root. Resolve symlinks/junctions and apply the existing
guarded-data-root checks. Cross-root paths are refused with no approval or
new-root creation, even when inside the team's general folder.

Create with `meta.cwd = requester.header.cwd`; then set the worker's live cd
with `workingDirectory.set(agent, checkedWorkdir)`. Compare the actual root
and cd again before prompt. Parent or child cd changes never change the root.
A retargeted root symlink/junction must not silently replace the saved
canonical root: revalidate it and deny execution if it no longer matches.

Add a worker branch **before** the Bot-only early return in `tools.js`'s
native `working_directory` execution path. Every worker cd, including PTC,
resolves realpath against its current cd, stays inside its saved root, and
checks guarded roots before calling the native tool. The execution policy
denies directory-changing names/aliases outside the supported native cd path.
It never calls `updateBot`, updates the task workdir, or moves another Session.
Follow-up retains and revalidates the worker's current cd.

## Execution policy and Session ownership

### Authoritative tool deny

Use the same documented execution hooks as the S1b `plugin_manager` deny:
an awaited `tools/pre-execute` policy plus a monotonic `ctx.tools.guard`
at the policy boundary before dispatch. The guard is **name-based**: a denied
name is denied whatever definition is registered. Key it by durable worker
Session ownership, not Bot identity, mode, schema visibility or definition
identity. Ownership or policy lookup failure is deny, never "ordinary Session".

| Tool family | Worker execution policy |
|---|---|
| All DS Bot team tools, including future team registrations | Deny |
| `run_worker`, `worker_followup`, `cancel_worker` and aliases | Deny |
| All DSH native subagent/delegation/control tools and configured aliases | Deny |
| `create_goal`, `update_goal`, `get_goal` and aliases | Deny |
| Schedule creation/change, including update, resume and removal | Deny; v1 allows no schedule tool as a convenience exception |
| `plugin_manager` | Deny the entire tool, all actions/targets, including self-change |
| MCP tools, whether attached to a Bot or exposed by the default profile | Deny in v1; no worker MCP capability is granted |
| Unknown or unclassified tool names, including new aliases | Deny by name until included in the permitted native execution names |
| Permitted native file/shell/search/cd names | Allow only subject to worker sandbox, root, approval and lifecycle policy |

Include composed delegation and other forbidden aliases in the denied names;
unknown names are denied by default. Do not infer authority from descriptions
or claim that inspecting `tools.get()` binds a definition to later execution.
The same denied name remains denied across scoped registration, HMR and
re-registration, independent of the implementation installed under it.

The policy runs on scoped tools and every PTC sub-call; outer `run_code` is
only a transport and cannot authorize a denied inner call. Cosmetic
`tools.restrict` hides registered inherited deny names when possible. A scoped
tool remaining visible does not weaken execution denial; restrictions do not
establish the hard guarantee.

Allowed shell tools can still run CLIs, spawn processes or call services inside
their available sandbox. That is outside this tool-policy guarantee. Trusted
preset/plugin code itself is also outside the threat model; a hostile native
plugin can execute host code without a model tool call.

DSH runs the guard before an awaitable `tools/execute` waterfall and resolves
the implementation by name again when dispatching the body. The guard neither
freezes nor binds that definition. Replacing an **allowed** name with another
implementation during that await requires an installed host plugin to
re-register it. That is inside the trusted-host-plugin boundary and outside
this guarantee, including ordinary HMR replacement; workers do not promise to
reject such replacement by definition identity. Denied names cannot reach a
body merely because their definition is replaced.

### Creation, cold resume and HMR gate

Persist the worker marker and exact reserved native Session id under the task
**before** creating or resuming it. Load ownership before installing any
prompt-capable worker; unknown/malformed claims stay denied. Creation uses the
default Agent preset, including any extra scoped tools. The execution deny
makes forbidden preset tools unusable; there is no worker-specific preset.

The minimal worker setup helper installs policy, permissions and listeners
during unpublished `ctx.agents.create` setup; initial route/effort are supplied
only by `agentOptions`. Its final publication check revalidates the task,
reservation and generation. Awaited serial `agent/created` restores policy
for controller/native UI cold resumes and refuses headerless restarted workers
before queued work is released. It never installs a second model helper,
starts detached work or waits for `whenIdle()` inside creation. Failure is
propagated as a controlled creation/resume error with diagnostics, not an
unhandled listener rejection or app-boot fatal.

For HMR-surviving live Agents, reattach before permitting another tool or
coordinator prompt. Keep a deny-all transition barrier in the Agent scope
until the new generation has loaded and verified ownership/policy; a stopped
generation cannot leave an unguarded execution window. Worker-scoped effects
are owned by the Agent scope, with explicit takeover/cleanup on generation
replacement. An unready or failed replacement remains denied. Each prompt has
a final policy/permission/generation check too; `agent/pre-step` alone is too
late to establish the first schema surface.

### Bidirectional ownership

Check both sides of every claim using persisted records, independent of
index-load order:

- Worker creation/reconciliation refuses any Bot, group, part, DSH Agent,
  legacy branch, task endpoint or other worker Session.
- DSH Agent adoption and Bot/task endpoint assignment refuse a worker-marked
  Session, including cold/archived Sessions and unresolved creation intents.
- A native fork of a worker is not adopted as a Bot/Agent/task endpoint by
  DS Bot; DS Bot ownership paths inspect fork provenance before adoption.
- Removing/archiving history never removes the worker ownership tombstone.

Only these worker-conflict checks are added to existing ownership paths.
The existing DSH Agent gate retrofit is tracked separately in Issue #43 and
must ship in its own PR with its own acceptance. W1 does not replace its retry
or alter DSH Agent create/adopt/resolve behavior when no worker is involved.

## Admission and correlation

Use short `withTask`/`commitTask` transactions to reserve/check/commit. Do not
hold the task lane while creating an Agent, awaiting prompt admission,
`whenIdle()`, cancellation or a completion callback that needs the same lane.
Every continuation reacquires it and rechecks durable state.

1. Validate eligibility/inputs and resolve route, sandbox, root and live cd.
2. In the task lane, reserve worker id, Session id and initial run id. Lazily
   create `task.workers` here. Persist the `pending` run, stable admission key
   from the caller Session/tool invocation, `promptRequestId`, prompt digest
   and exact requester Session. Tool replay returns this reservation; it
   never creates a second worker.
3. Create the ordinary root through the supported factory with its default
   preset, `agentOptions`, root metadata and unpublished setup. Save/flush
   the configured Session before driving it. Unknown creation is reconciled
   against the reserved id; absence of a response never authorizes recreation.
4. Install inbox/turn listeners before prompt. Persist the prompt admission
   intent before calling `sessionController.prompt(request, signal)`. Initial
   `requestId === workerId`; follow-up n uses `<workerId>:followup:<n>`.
   Call `signal.throwIfAborted()` immediately before entry.
5. Observe the inserted inbox message with matching `source.rpcId`, save its
   actual DSH `message.id` and insertion splice seq, and flush the worker log.
   Record the accepted receipt only after durable evidence.
6. After prompt returns, recheck generation, cancellation and task state.
   A stale/cancelled admission is cancelled/drained, not reported as a run
   start or allowed to enqueue unowned future work.

The prompt's signal owns admission only and DSH has an internal await after
its entry check. Cancellation therefore cannot rely on aborting that signal.
Track the in-flight admission Promise until it settles; after a stale await,
the only permitted old-generation action is compensating cancellation of
that exact admitted operation. It cannot save, deliver or retry. The successor
reconciles the durable intent. A pending late enqueue remains fenced against
tool dispatch, is cancelled and accounted for; it is not treated as absent.

### Bind the exact turn

Use `agent/inbox/claimed { message, turn }` for the matching message id to
bind the run to its turn. This notification comes after a durable deletion
splice and before assemble/pre-step/model preparation. Persist the claim and
turn reference. Do not wait for `user/message`.

On recovery replay the raw inbox splice history, reconstruct the pending lists
and match that message's insertion and non-cancelled deletion to the enclosing
turn boundary. A deletion with `outcome: 'canceled'` proves dropped input,
not claimed execution. Match any later `user/message.rpcId` as corroboration.
Never guess the latest turn when the exact message/turn relationship is
unreadable or ambiguous.

Pre-step rejection (`blocked`), assembly/prepare failure (`error`), cancellation
before user-message admission and a completed turn with no final assistant
text all settle that exact run. Only `turn/end.reason.kind === "completed"`
is success. A matched `interrupted` reason always maps to unknown, including
DSH's synthetic cold-resume closer with or without the original user/message.
Preserve its exact reason and the warning `may have partially run; not re-run`.
All other/unknown reasons remain non-success and preserve the reason; no final
text is rendered as `(no final text)`.

### Outside input

The native worker Session belongs to the user, so direct UI/API input and
steering are allowed. Record other user-message/inbox identities since the
run's admission, excluding known runtime context, and include the literal
notice `worker received outside input` in its result. Input claimed into the
same turn can affect the result; input in a separate turn is not mistaken for
this run. Outside activity may keep the Session busy and block follow-up or
cancellation confirmation; it never grants another coordinator worker rights.

## Run states, cancellation and recovery

Each run follows:

```text
pending -> running -> completed | failed | unknown
pending | running -> cancelling -> cancelled
```

`pending` covers creation/setup and unsettled prompt admission. `running`
requires accepted/claimed evidence. A synchronous failure may settle pending
as failed without a model call. DSH completed maps to completed; blocked,
error, max-tokens or an unrelated abort maps to failed with its exact reason.
Every matched `turn/end.reason.kind === "interrupted"` maps unconditionally
to unknown. Keep the exact reason plus `may have partially run; not re-run`;
never classify a synthetic closer as ordinary failed or completed just because
it is terminal evidence. This mapping also takes precedence over a pending
cancellation result. Host restart without terminal evidence, and restart
before the first request header, also map to unknown. `cancelled` requires
stop/drain evidence, not an API acknowledgement. State on the worker row/UI is
derived from its current run; idle is a native Agent fact, not a second
persisted run state. No automatic retry creates another run.

### Cancel and drain

1. Under the task lane, persist cancellation intent, fence further admissions
   and set the unsettled run to cancelling. Release the lane.
2. Request cancellation of the exact live Agent/turn. Drain in-flight prompt
   admission within the same bounded attempt; if it returns after cancellation,
   request stop again and account for its matching inserted message.
3. Give the whole attempt, including admission drain, at most 20 seconds for
   `whenIdle()`/Agent-idle and matched
   terminal evidence, or proof the matching message never ran and no admission
   remains. Terminal turn evidence does not make a still-running Session idle.
4. Only after quiescence, clear pending worker input with the documented inbox
   API and flush the worker log. User input accepted during the cancellation
   window is included in that cleared queue, like the native stop action.
   Recheck idle/queue/admission identities before committing cancellation.
5. Reacquire the lane and record cancelled plus its one result/settlement.
   An open task gets the bounded cancelled result; a terminal task gets a late
   record. Once acknowledged, that cancelled run has no outstanding dependency.
   If the matched end reason is interrupted, keep unknown and its exact
   warning instead; cancellation cleanup can confirm idle/close admissions
   without rewriting that unknown outcome as cancelled.

A timeout, including an admission Promise that has not settled, returns a
bounded cancelling status and keeps its durable intent.
Do not archive or admit follow-up. Retry cleanup with bounded backoff, and
report an unresolved stop if its budget expires. Cancellation observation and
native waiting never depend on a listener acquiring the lane held by cancel.
Cancellation of an idle worker closes its future admissions while preserving
already-delivered successful/failed runs.
If a matched terminal event predates the cancellation request, preserve its
completed/failed/unknown finish rather than rewriting history as cancelled.

### Plugin-only HMR

First inspect whether the exact native Agent is still live and whether the
matching turn has ended. If it is running, reinstall the policy barrier and
listeners and continue observing that same run. Do not mark it unknown,
clear its accepted input or issue another prompt. If it already ended while
the plugin was absent, flush/read the log and settle once. A cancelling live
Agent stays cancelling until quiescence.

If DSH tears an Agent down during recomposition, use its actual abort/terminal
evidence. Missing evidence during plugin replacement remains reconciliation
pending; it is not proof of host restart. Preserve HMR generation checks after
every await, with only the exact admission-compensation exception above.

### Host restart

Reconcile terminal tasks before considering result delivery. For an open task,
flush/inspect the exact raw worker history without waking model work. Matched
terminal evidence settles according to its reason: interrupted is always
unknown with the exact reason and `may have partially run; not re-run`.
This applies when native UI/API resumes the Session before worker recovery
scans and DSH has already appended synthetic interrupted closers, with or
without the original user/message. Do not skip unknown because a closer exists.

A confirmed host restart with no terminal evidence marks the old run unknown
and reports `unknown outcome; not rerun`. If no first request header exists,
also permanently close that worker's admissions with
`restart-before-first-header`. Even an idle Session may not receive follow-up
or any new prompt; native UI/API activation is refused before model execution,
and the PM must start a new `run_worker`. Preserve an exact interrupted reason
when present rather than replacing it with the admission-block reason.

With a header present, DSH's own controller restores route/effort; the worker
does not install route middleware or reapply its initial config. Cancel/drop
leftover accepted input before any permitted explicit follow-up. If history
is unreadable, retain reconciliation pending with a diagnostic rather than
inventing success or absence.

Follow-up is admitted only from completed/failed/unknown after result
settlement, no admission in flight, no pending worker input and an actually
idle Session whose admissions remain open. A headerless restarted worker
always refuses. Other permitted follow-ups retain the current cd and DSH's
own route authority, not the old prompt or an independently restored route.

## Result durability and delivery

Reuse task delivery and conclusion machinery instead of adding a worker
outbox implementation:

1. Flush the worker's accepted inbox and matching terminal log **before**
   committing the settled run/result. A session/event callback is post-append,
   not disk acknowledgement. Inspect the raw log and save the exact message,
   turn and end seqs used as evidence. Synthetic setup/unknown/cancel outcomes
   identify their evidence honestly.
2. Under `withTask`/`commitTask`, store the bounded result and its stable id:
   `<workerId>:result` or `<workerId>:followup:<n>:result`. The existing
   `task.sends[resultId]` delivery ledger owns target/state/ack; the run only
   references it. The target is the saved requesting task Session.
3. Extend `task-lifecycle.js` `prepare`, `destination`, `matches`, `observe`,
   `alreadyPresent`, `atBoundary`, `acknowledge`, `runDelivery` and
   `attemptConclusion` to handle worker-result sources/ids with the same
   guards and retry budget. Do not weaken Bot delivery or conclusion checks.
4. Persist target+id before enqueue. Inspect that exact Session's raw inbox
   splice and consumed-message log plus its live inbox. An existing copy must
   be flushed before acknowledgement too; compaction does not erase the
   raw-log dedupe evidence.
5. After all awaits, synchronously recheck task open/ready, exact endpoint,
   run/result identity, active attempt and generation, with no await before
   the next-turn enqueue. Enqueue with `followup`, flush receiver, then ack.
   An HMR-skipped delivery is still pending.

Use the existing 20-second attempt deadline, at most five attempts per retry
budget and exponential backoff. Temporary inspect/save/flush failure retries
while the plugin runs, rather than requiring restart. After exhaustion retain
pending+diagnostic, release all lanes, and allow a bounded explicit recovery
attempt or the next generation to reconcile. Expired attempts cannot later
save or enqueue. This budget also bounds source flush/reconciliation attempts;
it never resends a prompt.

A task-owned endpoint has one Session id and compacts in place. An unexpected
deleted/archived/moved endpoint remains pending with diagnostics; it never
migrates to a trunk or another participant. A terminal task always takes the
late-result path before delivery, including on restart.

The complete rendered result is at most 4000 Unicode code points, reserving
room for title, exact finish reason, Session link, outside-input notice and
the mandatory interrupted warning `may have partially run; not re-run`.
Use the final text-bearing assistant message of the matched turn, truncated
within the remaining budget. Reasoning/tool output is not a fabricated final
answer; the full transcript stays in its native Session.

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

This is private task input and next-turn work. `turns.js` does not pass it to
`answerSender`; `delivery-id.js` and raw-log matching preserve its result id.
There is one logical delivered result, not an exactly-once claim for file
writes or other external effects.

## Task close and late results

Keep the approved close protocol. In the task lane re-read state/dependencies
and atomically persist terminal state, `closedAt`, conclusion and the existing
`${taskId}:closed` summary id **first**. New worker/run/send admissions are
refused after that commit. Only the root requester's task Session can close.

`done` is refused while any run is pending, running or cancelling, any prompt
admission/cleanup is unresolved, or any worker result is unsettled. Preserve
the rule excluding the closing caller turn from its own dependency check.

After any terminal commit, a narrow, idempotent settlement path fences
admissions, cancels/drains workers and records cleanup. Use it from
`close_task`, `removeTaskBot`, task setup failure, recovery failure and startup
reconciliation. Host-generated failure conclusions keep their existing
authority; they do not invent another Bot closer.

Release the task lane while awaiting native stop; return only to record
settlement evidence. Cancellation timeout cannot undo terminal state or
replace the conclusion. A crash halfway through cancellation resumes cleanup
from the durable terminal record and cancel intents. Settlement never adds a
worker/run, changes the conclusion, or creates another summary id.

A result arriving after terminal is appended once to `lateReplies` by its
stable result id, never delivered or used to revive the task. A not-yet-queued
result is suppressed/late-recorded. An already-enqueued result cannot be made
absent merely by marking it suppressed: withdraw it only if its exact pending
identity is still present, and flush. If consumed or racing consumption, keep
the source and record it as late. It may start a task Session turn, as existing
queued task work can, but terminal admission checks deny new task/worker work
and prevent a second conclusion.

Archive a worker Session only after the task is terminal, all admissions are
drained, its Agent is idle and result/late bookkeeping has settled. Persist
archive/cleanup confirmations and retry failed archives without deleting
history. Idle workers on open tasks stay unarchived for explicit follow-up.

## Data model and compatibility

Persist workers only under `state.tasks[taskId].workers`. Add this optional map
only when the first run is reserved; ordinary tasks are not rewritten with
`workers: {}`. Absent/empty maps mean no worker history. In-memory lookup and
permission-propagation indexes are derived; there is no second worker table.

Example of one settled run (optional lifecycle timestamps omitted):

```js
{
  id: "worker-id",
  kind: "native-worker",
  taskId: "task-id",
  requestedBy: "historical-bot-id",
  requesterSessionId: "requesting-task-session-id",
  sessionId: "reserved-native-session-id",
  marker: "worker:task-id:worker-id",
  title: "Verify the change",
  mode: "verify",
  sandboxRoot: "<requester-header-cwd>",
  initialWorkdir: "<checked-directory-inside-root>",
  sandbox: "read-only",
  approval: "never",
  initialModel: { provider: "provider-id", model: "model-id", reasoningEffort: "medium" },
  followupCount: 0,
  currentRunId: "worker-id",
  admissionsClosed: false,
  admissionBlockReason: null,
  runs: {
    "worker-id": {
      id: "worker-id",
      ordinal: 0,
      state: "completed",
      admissionKey: "caller-session:turn:tool-call-id",
      promptRequestId: "worker-id",
      promptDigest: "<digest>",
      admission: { state: "settled", insertedSeq: 8, messageId: "dsh-message-id" },
      turn: 1,
      claimSeq: 10,
      requestHeaderSeq: 12,
      endSeq: 24,
      outsideInput: false,
      finish: { kind: "completed" },
      result: { id: "worker-id:result", text: "<bounded-result>" }
    }
  },
  cleanup: { state: "none", cancelRequestedAt: null, confirmedIdleAt: null },
  archivedAt: null
}
```

The existing task send ledger, not a duplicate field on the run, stores result
delivery state, fixed target, retry observations and acknowledgement. Runtime
Promise/generation/Agent handles are not serialized. Full accepted prompts
and transcripts stay in native logs; the admission key/digest identifies an
attempt without pretending a missing accepted prompt can safely be rerun.
`initialModel` is the creation request for audit only. Actual route/effort come
from the native request header referenced by `requestHeaderSeq`, not a second
worker model authority. A headerless restart stores the permanent admission
block reason without discarding its unknown result or exact finish reason.

Validation depends only on stored structure and immutable historical
references: identity strings, nonnegative counts, unique message/run/Session
ids, legal transitions and links to that task's persisted participant record.
It never requires the Bot to remain in the live roster, checks current config
limits, or resolves current files/presets to read history. Bot removal retains
the recorded requester/task endpoint ids.

Separate admission validation uses current limits/capability/Bot/policy.
Cross-ownership claims are rejected in both directions without erasing either
historical record; a malformed worker claim denies execution and reports a
diagnostic instead of being dropped from the security lookup.

Terminal mutation allowlist is narrow: settle existing pending/running/
cancelling runs, append their result/late evidence, advance existing delivery
acks, record cancel/idle/queue-flush/archive confirmations and diagnostics.
Never add a worker or run, increase follow-up counts, reopen state, alter
requester/root identity, or rewrite conclusion/summaryId.

**Non-empty workers data implies a worker-aware rollback target**, even if
every run is terminal. Absent/empty maps do not trigger that gate. Lowered
limits, gate-off and deleted Bots keep historical records valid and readable.

## UI, usage and memory

The task header lists worker title/mode, current run state, elapsed time,
result/cleanup state and native Session link. Reuse DSH's own Session UI, like
the DSH Agent view, without adopting the worker into `state.agents`. Show no
worker row on trunks, Bot parts, participant lists or groups. DSH's native
root-Session list may expose it to its user.

Keep English UI source labels with localization in `i18n.js` and the existing
UI standard. No worker approval UI is added.

Usage is tokens only through the existing usage ledger: map worker Session
calls to `task:<taskId>`/worker kind and retain per-run/raw-log attribution.
Count failed/cancelled work too; incomplete provider usage is unknown, not
zero. Aggregate task-owned Session calls without double counting inherited
fork history or shared trunks. Do not invent monetary cost.

`worker-result` stays in the coordinator's history through `parts.js`
`historyEntry`/`partLines` and in `memory.js` `chatBatch`/review provenance as
worker/task evidence, never a user decision. Preserve its task, worker, run
and result ids and exact Session anchor through compaction/review. Worker
transcripts themselves never enter Bot memory review or Bot identity indexes.
`capabilities.js` must not mount a Bot's MCP/skills into a worker or call
`ensureCapabilities` for it; the coordinator supplies self-contained inputs.
MCP definitions inherited from a default profile remain denied by execution
policy as well; workers start no MCP capability mounts of their own.

Diagnostics record ids, lifecycle/finish evidence, policy/sandbox failures,
model setup, outside-input flag, delivery retry state and unknown outcomes.
Use existing redaction; do not publish prompts, private transcripts or
credentials. Minimal diagnostics suffice in W1; richer UI can wait.

## Invariants

1. One worker has one task, one requesting task-owned Session and one native
   root Session; ownership is checked bidirectionally.
2. New runs require current task capability; historical validation does not.
3. Workers have no Bot identity, memory review or Bot MCP capabilities.
4. Approval is always never; sandbox is at most workspace-write and no wider
   than the effective requester. Verify is read-only through the native API.
5. Worker header cwd equals requester header cwd; realpath cd stays inside it.
6. Execution policy denies team/worker/delegation/goal/schedule/plugin tools,
   including scoped/dynamic/aliased/PTC cases; presentation is not authority.
7. Persisted ownership and awaited gates apply before creation/resume work,
   across HMR and before every dispatch. Lookup failure denies.
8. Each admission has durable identity before prompt; each run has at most one
   in-flight prompt. A stale accepted prompt is cancelled/drained, not rerun.
9. Inbox identity/claim binds the exact turn, including pre-user-message errors.
10. Only completed is success. Cancellation ack is not cancelled; a live HMR
    turn is not unknown. Every matched interrupted end is unknown with its
    exact reason and partial-execution warning, never an automatic rerun.
11. Worker log flush precedes result settlement; task delivery uses raw-log
    dedupe, fixed target, flush-before-ack and bounded recovery.
12. A result only reaches its requesting task Session and preserves provenance.
13. Terminal task+conclusion commit precedes cancellation settlement at every
    entry point. Late results never revive or create another conclusion.
14. Done refuses unsettled runs/results; open-task idle workers stay available
    for explicit follow-up.
15. Gate-off with no worker data has zero existing-feature behavior changes.
16. Non-empty worker history requires worker-aware code on rollback.
17. Model/effort enter only through creation agentOptions; DSH owns durable
    route replay. Headerless restart closes worker admissions permanently.

## File and function change map

This table describes implementation work, not code shipped by this docs PR.

| File / functions | Change |
|---|---|
| `ds-bot/src/host/workers.js` (new): admission, `runWorker`, `followupWorker`, `cancelWorker`, recovery | Minimal worker policy/setup, durable runs, claim correlation, admission compensation and bounded cancellation; reuse task lanes and delivery |
| `ds-bot/src/host/tasks.js`: `validateTask`, `commitTask` | Optional workers map, structural/history validation, narrow terminal settlement allowlist; current limits only on admissions |
| `ds-bot/src/host/store.js`: `indexSessions`, `validateTaskSessions` | Derived worker ownership and permission indexes; bidirectional conflicts; never add workers to `selfOf`/`isBotSession` |
| `ds-bot/src/host/task-routing.js`: `withTask`, creation failure/recovery paths | Short reservation/commit phases; all terminal failures invoke common post-commit settlement |
| `ds-bot/src/host/task-lifecycle.js`: `dependencies`, `closeTask`, `settleTerminal`, `removeTaskBot`, `recover` | Done dependency gate; terminal-first close from every entry point; shared worker cancel/late/archive settlement |
| Same file: `prepare`, `destination`, `matches`, `observe`, `alreadyPresent`, `atBoundary`, `acknowledge`, `runDelivery`, `attemptConclusion` | Extend existing machinery for worker-result source/id and fixed task Session, same deadlines/backoff; no separate outbox |
| `ds-bot/src/host/models.js`: model/effort resolution | Route precedence including configured effort; pass only initial agentOptions, no worker model helper/default writes; DSH owns header replay |
| `ds-bot/src/host/permissions.js`: `setPermission`, worker permission propagation | Read effective Session policy, forced never, direct sandbox setter/readback, mid-run tightening/cancel |
| `ds-bot/src/host/folders.js`: `sessionFolder`, `folderAt`, guarded-root helpers; `tools.js`: cd path | Preserve immutable sandbox root; initial/live realpath containment and worker cd validation before Bot-only return; no folder approval |
| `ds-bot/src/host/tools.js`: `registerTaskTools`, execution policy, `list_tasks` | Task-only worker tools; final deny using S1b hooks for worker Sessions; dynamic/scoped/PTC policy |
| `ds-bot/src/host/constants.js`: `TEAM_TOOLS` and worker deny names | Cover team/worker/delegation/goal/schedule/plugin/MCP names/aliases; name-based execution deny is authoritative, independent of registered definition |
| `ds-bot/src/host/agents.js`: `adoptAgentSession`; `roster.js`/task endpoint claims | Refuse worker/provenance ownership conflicts only. DSH Agent gate retrofit is Issue #43, a separate implementation PR |
| `ds-bot/src/host/turns.js`, `resume.js`, `delivery-id.js` | Recognize worker-result, preserve exact ids and task trigger; no `answerSender` or auto worker retry |
| `ds-bot/src/host/parts.js`, `memory.js`, `capabilities.js` | Retain coordinator result provenance; exclude raw worker review and Bot capability mounts |
| `ds-bot/src/host/usage.js`, `channel.js` | Token attribution, worker/task state and minimal diagnostics |
| `ds-bot/src/client/branch-dock.js`: `TaskHeader`; `sources.js`, `cells.js`, `i18n.js`, native-surface routing | Task-only rows, native worker Session link, outside-input/result presentation |
| `ds-bot/index.js`: module installation | Install worker hooks only when enabled or non-empty data needs recovery; establish policy before resume; zero empty flag-off effects |
| `ds-bot/test/workers*.test.js` (new) and existing task/lifecycle/model/permission/memory/usage/UI tests | Matrix below and regressions of reused functions; rebuild generated `client.js` only for client implementation |

## Slices and acceptance matrix

Keep `nativeWorkers: false` by default in every slice. No enabling in a user
profile until W1-W3 and their target-runtime safety criteria pass. Docs review,
implementation, automated checks, isolated acceptance and release are distinct.

### W1: flag-off core and first-result safety

Implement model/config/admission, data, policy, setup, correlation and durable
result delivery, with the worker-count limit. Internal cancellation/drain,
terminal settlement and cold/HMR recovery are part of this core safety chain;
they cannot wait for the control-tool UI slice. Use the smallest worker-only
helper, without an unused allow branch or generic native-session framework.

Real DSH checks of cold-resume policy, early-failure correlation, cancellation
and admission fencing are **W1 exit criteria**. Run matrix A1-A10 below with
the mock model on a fixed real DSH in an isolated profile, plus applicable
unit regressions. A unit fake that repeats the design's assumptions is not
evidence for those API boundaries.

When disabled with no worker data, compare tools/schemas, task creation/
closure, DSH Agent create/adopt/resolve and Bot model/permission behavior
against the base. There must be no behavior or data-shape change. Existing
worker data still installs its recovery/deny policy when the flag is off.

The DSH Agent gate fix is outside W1: Issue #43 gets its own implementation
PR and independent real-DSH create/adopt/cold-resume/HMR/PTC acceptance. It may
later reuse a small compatible helper; no shared-framework dependency is
required by workers.

### W2: explicit follow-up and cancellation controls

Expose `worker_followup`/`cancel_worker`, apply the follow-up limit at call
time, and finish control/list formatting. Reuse W1's settlement/drain path.
Exit requires A1-A10 rerun for follow-up and every control/close race, with
completed/failed/unknown plus actual idle checked; cancelled remains closed.
Both lowered limits and flag/capability removal preserve readable history.

### W3: task-header UI and provenance

Implement worker rows/state/elapsed/Session links and worker-result messages.
Add task token display and retain worker provenance in history/memory review.
Exit requires A11-A12, native Session navigation, desktop/mobile checks,
and all affected lifecycle regressions. Build `client.js` from `src/client/`
and commit both; never edit the generated bundle directly.

### W4: isolated release and rollback

Repeat the full matrix on the exact release runtime with synthetic data and
the mock model. This is a regression/release rehearsal, not the first proof of
W1 APIs. Use the
[out-of-band procedure](2026-10-30-release-procedure.md), record loaded
DS Bot/DSH versions, commit and compatible rollback target, and stop every
bench/process started for acceptance. No live Desktop or private user data.

### Required matrix

These are required outcomes to prove, not a report of tests already passed.
All safety rows use the pinned real DSH plus mock and isolated data.

| ID / review | Scenario and exit evidence | Slice exit |
|---|---|---|
| A1 / R6 | Pre-step rejects; assemble/prepare fails before rpcId user-message; prompt remains in inbox; claim precedes user-message; completed with no text. Exact splice/message/claim/turn yields one correct result, never permanent running | W1; W2 follow-up variants |
| A2 / R7 | Pause every create/setup/prompt-admission/save/flush await; race run, follow-up, cancel, close, Bot deletion and HMR. Durable intents fence and drain late admission; no unaccounted enqueue, ghost worker, duplicate run or lane deadlock. There is no approval await | W1 internal controls; W2 tool controls |
| A3 / R7 | Plugin-only HMR with still-running native Agent, ended-but-missed event, and cancel not yet idle: reattach, never infer unknown from live work. Host crash without terminal evidence yields unknown once. Also native UI resumes the Session before worker recovery scans: matched synthetic interrupted closer, with/without original user/message, always yields unknown, exact interrupted reason and `may have partially run; not re-run`; never auto-rerun | W1; W2 |
| A4 / R3 | Native UI/API cold resume has policy before tool dispatch; default/overridden preset includes scoped forbidden tools. Gate errors reject/deny with bounded diagnostic and no app-boot fatal; HMR takeover has no unguarded window | W1; W2 |
| A5 / R2-R3 | Denied team/worker/subagent/goal/schedule/plugin-manager names and aliases stay denied through scoped registration, HMR/re-registration and mid-await definition replacement, in ordinary and PTC calls; no replacement body executes under a denied name. Unknown names fail closed. Allowed-name replacement inside the tools/execute await by an installed host plugin, and shell-launched CLIs, are outside the guarantee; do not claim definition binding | W1; W2 |
| A6 / R1,R4,R5,R13 | Requester ask/never and read-only/workspace-write/full-access combinations; no named read-only preset; forced never with no answerers/UI or with UI disconnected; explicit full access rejected; implicit execute capped at workspace-write; verify uses direct read-only API or refuses. Tighten running Bot/task permission. Different cd/header.cwd, cross-root/symlink/guarded roots and worker cd are checked; follow-up retains current cd | W1; W2 |
| A7 / R9 | Crash after accepted/turn-end before worker flush, and before/after each result intent/enqueue/receiver-flush/ack. Raw-log compaction/dedupe; transient inspect/save/flush failure retries; deleted/archived/unexpected endpoint stays pending. One resultId, no duplicate delivery or trunk fallback | W1; W2 |
| A8 / R7-R8 | Terminal commit followed by half-completed cancellation failure/crash; every terminal entry point; already-queued unconsumed result; late success/error. Resume narrow cleanup, settle cancelled results, never revive; conclusion and summaryId unchanged with no second admission | W1; W2 |
| A9 / R10 | Two workers with explicit/configured/Bot/default efforts and interleaved UI default changes: initial route enters only through creation agentOptions, with no second helper. Cold resume with header present: assert actual subsequent request/header provider/model/effort follows DSH's durable record. Restart after creation before first header: unknown, no model request, native UI/API/follow-up refused permanently; PM must use new run_worker. Assert zero worker-caused profile-default writes and no other Bot/task route changes. Existing S2 restore behavior is not claimed fixed | W1; W2 |
| A10 / R11-R13 | Empty flag-off schemas/tasks/DSH Agent paths match base; on-to-off recovery; lower both limits; delete requester Bot; old/absent/empty/non-empty workers round-trip. Historical validation remains valid, no unnecessary empty map, non-empty data blocks unaware rollback. Bidirectional worker/Bot/Agent/task/fork adoption fails | W1; W2; W4 rollback |
| A11 / R6,R13 | Human outside input/steer allowed and flagged in result; exact worker Session UI link; no trunk/participant worker rows; follow-up denied while outside activity keeps Agent busy; cancelled state waits for idle | W3 |
| A12 / R9,R13 | Worker-result survives parts/compaction and memory classification as worker/task evidence with ids/anchor; no raw worker memory review or Bot MCP mount; usage counts tokens only, handles missing usage and inherited history without double count | W3 |

Repository implementation checks in `ds-bot/` remain:

```sh
npm test
node scripts/build-client.mjs --check
npm run lint
```

Host implementation also runs the documented smoke command with a free port,
isolated `.dsh-test-worker-*` data and the mock model. UI implementation adds
real demonstration evidence under the repository workflow. This docs-only PR
claims source/contract inspection and document checks, not these runtime exits.

## Rollback and known limits

Disable new admissions with `nativeWorkers: false` and keep a worker-aware
build while existing work/result/cleanup settles. Use terminal-first task
closure and the same cleanup path; do not delete records to pass preflight.
Before a stopped-profile switch, require no pending/running/cancelling run,
in-flight admission, unsettled delivery or archive cleanup.

Non-empty `task.workers` requires a worker-aware rollback target. Absent/empty
worker maps alone do not. Gate-off, lowering limits and deleting Bots do not
erase that compatibility requirement. Preserve current data on code rollback;
restore snapshots only through the separate operator recovery decision.

Known limits:

- Same-host Sessions do not survive host exit. Unknown outcome is not proof
  of no external side effect, and delivery dedupe is not exactly-once execution.
- DSH tool policy cannot stop an allowed shell from launching another CLI,
  background process or service call. It is not a process/container sandbox.
- A preset is trusted host code, not a security boundary. Arbitrary malicious
  plugin code or a host without the worker policy is outside the guarantee.
- The guard denies by name, not definition identity. A trusted installed host
  plugin can re-register an allowed name during the tools/execute await and
  DSH may execute the replacement. This allowed-name TOCTOU is outside the
  guarantee; denied names remain denied regardless of implementation.
- Permission tightening controls subsequent operations and requests cancel;
  it cannot undo already-started writes or terminate all external descendants.
- Direct user input is allowed and disclosed; a user can change what the
  worker does. It does not become authority for another coordinator.
- Existing S2 `selectSessionModel` still has profile-default write/restore
  races. Workers use initial agentOptions and DSH's own durable header replay,
  without a second model helper. A headerless restarted worker cannot be
  continued; the PM must create another worker within the admission limits.
- Verification has fresh-Session independence only unless an explicit
  verifier model is configured. Usage is tokens only; no money estimate.
- Target-runtime incompatibility or unprovable execution/correlation gates
  refuses worker admission; there is no DSH patch or private API workaround.
