# Native workers W2 checks

Date: 2026-11-01. Issue #49.
Contract: [native workers](../plans/2026-10-31-native-workers.md).
Integration baseline: `c9620bb80de39ba8d605a0699f4b6b87bd951177`.
First W2 commit: `2cdc5e1ddc9c630db797dab9bc6c60d94402caba`, merging
`origin/main` at `a6c13ede43bf1a779096614a90b799a1a4553abc`.

The feature remains `nativeWorkers: false` by default. This work adds controls
and isolated acceptance; it does not enable a user profile, merge a PR or ship
the W3 interface/usage slice.

## Implementation

- `worker_followup` requires the exact requesting task Session, current
  capability/flag, a settled delivered result and an actually idle Session.
  It retains the native route, current directory and monotonic sandbox ceiling.
  Unknown outcomes need a durable header; cancelled/closed admissions cannot
  continue. A new run has its own request id, digest, claim, finish and result.
- `cancel_worker` persists the admission fence before stop. Native cancellation
  acknowledgement alone is insufficient: confirmed quiescence settles the run.
  A bounded timeout reports cancelling and schedules finite backoff retries.
  Repeating a request shares its in-flight stop; earlier settled results remain
  immutable.
- The default lifetime limits are two workers per task and two follow-ups per
  worker. Invalid/new admissions fail as tool errors. Replay does not consume
  another admission, and lowered limits do not invalidate history. Flag and
  capability removal leave existing cancellation available.
- Every terminal task commit schedules the same narrow worker settlement path.
  Late results preserve one result id without delivery or another conclusion.
  Cleanup does not activate an inactive requester merely to withdraw a result.
  Definitively absent native Sessions have explicit absence evidence; arbitrary
  read failures are not treated as absence.
- The main DSH Agent guard and worker guard remain separate. Worker controls
  are included in the team-name inventory. Name-based execution guards cover
  scoped/replaced/PTC calls; cosmetic schemas do not grant authority.

## Cold resume and HMR boundaries

Fresh creation still passes model/effort only through native factory
`agentOptions`. There is no worker model-selection middleware or profile-default
select/restore wrapper.

Controller cold resume with a header is the supported continuation path.
Before releasing its loop, the worker gate removes old kernel-owned inbox RPCs
so a queued prior follow-up cannot replay. Pending human input refuses a
coordinator continuation. A renamed Session keeps its current title and its
original immutable marker. Headerless activation remains closed.

For a controller-owned Agent that survives plugin replacement, its transition
barrier and native in-flight admission Promise stay on the Agent scope. The
replacement can wait for the exact late receipt and drain it before confirming
cancellation. Fresh plugin-owned Agents retain the accepted W1
unknown/plugin-reload behavior, including the partial-execution warning and no
re-prompt. Cold native activation cannot race ahead of the recovery scan.

The ownership investigation is recorded in the plan. The experimental
`Context.root` view was observed to expose the same services, but is not used as
an undocumented global lifetime escape. No synthetic warm-up request or
competing model authority was introduced.

## Repository checks

- `npm ci`, `npm run harness`, `npm run build`: passed in the W2 worktree.
- `npm test`: **1646 total, 1645 passed, one existing Windows skip, zero failed**;
  natural exit.
- `node scripts/build-client.mjs --check`: passed.
- `npm run lint`: exit 0, 14 existing warnings.
- Fixed-checkout worker and DSH Agent gate suites: **105/105**.
- Repository tree scan including this evidence document: **zero must-fix
  findings**.

The component harness uses real AgentRegistry, AgentLoop, inbox projection,
tool runtime, sandbox and approval. Its controller/directory/persistence
fixtures remain distinct from the real host acceptance below.

## Real isolated host

Windows and the tracked `dev/bench.ps1` from main; isolated Windows `link:`
profile, mock only, ports 6696/12696. DSH `0.2.1-rc.2`, checkout
`687f282e8625c6b8d11ff58211a90524be2e4317`. No DSH implementation, live
Desktop, release checkout or user profile was changed.

The acceptance fixture injects `rt.testPause(point, ids)`; it is absent from
production configuration and creates no extra asynchronous boundary there.
Only ids/states cross this hook. All ownership, generation, terminal and
attempt checks still run after injected waits.

### A2 checkpoint/control matrix

The completed real-host matrix contains **160 cases**:

| Stage | Points | Racing operations | Cases |
|---|---|---|---|
| Preflight | services, directory, route, default preset | close, participant removal, independent run, HMR | 16 |
| Initial creation/admission | reserved record, creation tombstone, create, preset setup, setup directory, permission flush, publication, configure, initial flush, intent, admitting, accepted | cancel, close, participant removal, independent run, follow-up, HMR | 72 |
| Follow-up admission | native resolve, configure, flush, reservation, intent, admitting, accepted | cancel, close, participant removal, independent run, another follow-up, HMR | 42 |
| Task persistence | before/after required task save | cancel, close, HMR | 6 |
| Cancellation/drain | cancel intent, native cancel request, idle evidence, drained input | repeated cancel, close, participant removal, independent run, follow-up, HMR | 24 |

The exact injected keys for those stages are:

```text
preflight:
  worker:services, worker:directory, worker:route, worker:preset
initial creation/admission:
  worker:reserved, worker:creation-record, worker:create, worker:setup,
  worker:setup-directory, worker:permission-flushed, worker:published,
  worker:configured, worker:flushed, worker:intent, worker:admitting,
  worker:accepted
follow-up admission:
  worker:resolved, worker:configured, worker:flushed, worker:reserved,
  worker:intent, worker:admitting, worker:accepted
task persistence:
  task:save:before, task:save:after
cancellation/drain:
  worker:cancel-intent, worker:cancel-requested, worker:idle, worker:drained
```

Outcomes are checked against the actual durable reservation and native log.
An operation reserved before terminal commit may settle late; none is admitted
after it. Concurrent independent jobs keep distinct worker/Session ids and the
lifetime limit. Prior results remain immutable. No ghost worker, extra prompt,
duplicate logical result or lane deadlock was observed.

The first large-history FU run exceeded the fixture RPC timeout while recovery
rewrote completed archival history. The native turn itself had ended promptly.
Recovery now skips confirmed complete history, while a failed archive-confirmation
save is retried. The complete 42-case FU phase passed after that change.

### Other verified rows

| Row | Actual evidence |
|---|---|
| A1 | Initial and follow-up default preset execution; blocked/assemble/prepare failure before the exact rpcId user-message. Each failure has its own correlated claim/turn and one requester result. |
| A3 | Plugin-owned running work settles unknown/plugin-reload once with its actual disposed cause. Native cold activation before explicit recovery is refused. A controller-owned live Agent survives replacement with its transition barrier intact. |
| A4 | Exact requesting participant only; another participant's follow-up and cancel fail as tool errors. Busy native outside work refuses follow-up and done without rewriting prior history. |
| A6 | Six requester combinations: read-only/workspace-write/full-access crossed with ask/never. Workers stay at or below workspace-write and always never; follow-up preserves the result. Actual native CD remains after follow-up, root unchanged, read-only write denied, native read succeeds. |
| A7/A8 | Archived requester leaves its result pending with zero trunk fallback; terminal closure records the result late and archives the quiescent worker. |
| A9 | Accepted FU deliberately held in the native inbox, checkpointed, then hard host kill. It becomes unknown with a header. A new explicit FU drops the old RPC, makes exactly one new model call and preserves flash/high after an unrelated UI default change; total worker calls remain two. |
| A2/A8 | A controller-owned Agent with a held native receipt crosses plugin HMR. Terminal commit comes first; cancellation remains unsettled until the receipt arrives, then records its exact message, cancelled, one late result, archive, and zero late model requests. |
| A10 | Default limits, stable replay, both limits lowered, flag/capability off, and cancellation/history preservation. |

### A7 hard-crash and transient-failure matrix

**15/15 actual process kill/restart points** passed on a fresh isolated home:

- before/after source flush, with an actual native terminal event observed;
- before/after committing the worker result;
- before delivery, before/after target persistence, and after durable intent;
- before the enqueue path, immediately before actual enqueue, and after enqueue;
- before/after receiver flush;
- before/after acknowledgement.

The exact kill points are `worker:source-flush:before`,
`worker:source-flush:after`, `worker:result:before`, `worker:result:after`,
`result:delivery:before`, `result:target:before`, `result:target:after`,
`result:intent`, `result:enqueue:before`, `result:enqueue`, `result:enqueued`,
`result:receiver-flush:before`, `result:receiver-flush:after`,
`result:ack:before` and `result:ack:after`.

Each case force-stops only the recorded bench PID trees, restarts the same
profile, and reconciles without a worker prompt. All final runs were completed
from their durable native evidence, with one requester copy, zero other/trunk
copies, one lifetime worker model request and a delivered ledger. A second
explicit recovery kept the copy count at one. This is one result-id delivery
claim, not exactly-once execution of external effects.

**3/3 transient failure cases** passed without restart: native inspection,
required result save, and receiver flush after enqueue. Bounded retry adopts the
existing raw-log copy and never resends the worker prompt.

The earlier large-home diagnostic trial was interrupted and is not counted in
these 15 cases. Its data and logs were preserved; the complete matrix was
restarted from a fresh synthetic home.

### A5 registration and PTC

**3/3 host security scenarios** passed:

- 88 scoped/re-registration dispatches all returned the worker name-policy
  denial. Replacing the definition during an awaited policy that then forces
  allow still executes zero bodies.
- A header-based controller-owned Agent remains the same object across plugin
  HMR. Its transition gap denies execution, then native read works again.
  Another 88 re-registration calls execute zero bodies.
- Actual read-only `run_code` records a denied inner call. After HMR, inner
  dispatch covers unknown, team, worker, native subagent, goal, schedule and
  plugin-manager families. All seven return the name-policy denial, with zero
  sentinel bodies. Scoped-only native tools keep their actual default-preset
  schemas; their existence is not patched by a global sentinel.

The managed DSH Agent also denies the three worker control names and
`message_bot` before four sentinel bodies, independently of the worker guard.
No definition-identity binding is claimed for replacement under an allowed
native name.

### A8 terminal entry and cancellation bounds

**6/6 host terminal scenarios** passed: blocked, failed and cancelled task
closure; bounded cancellation retry; actual assignee Bot deletion; actual
requester Bot deletion. Terminal state, conclusion and `${taskId}:closed`
precede worker stop. Each worker settles, records one late result, closes
admissions and archives without post-terminal delivery or another conclusion.
Historical requester references remain structurally valid after deletion.

The delayed cancellation returned cancelling at approximately 19.9 seconds.
Automatic retry subsequently confirmed quiescence and saved cancelled, with
one lifetime worker model request. Native acknowledgement was not treated as
quiescence.

**2/2 creation failure entry points** also passed with an already-running
worker: a later participant's unknown setup outcome, and a hard restart while
that participant's creation intent is persisted but its native create is
paused. The real task recovery path commits failed/conclusion/summary first,
then the worker settles cancelled or unknown as its native evidence requires.
Both archive and record one late result.

Across the baseline, checkpoint/control, extension, crash, security,
transient, terminal and creation-entry suites, **211 targeted real-host
checks passed**. These cover the W2 variants of A1-A10; the exact release
runtime, UI/usage slice and release/rollback rehearsal remain W3/W4 work.

## Acceptance artifacts and cleanup

Normalized results and ignored fixture drivers stay inside the dedicated W2
worktree. A large earlier synthetic home was preserved separately before the
fresh crash rehearsal. API tokens/cookies, prompts, private absolute paths and
profile contents are not part of this document or the PR.

The final ordinary-entry, flag-off smoke passed **52/52 steps** using the
Windows bench and mock. The bench stop command reported both recorded process
trees dead and both ports free. A separate `Get-NetTCPConnection` check
confirmed no listener on 6696 or 12696. Synthetic acceptance data and ignored
drivers remain in the worktree for review; no acceptance host remains running.
