# Native workers W1 checks

Date: 2026-10-31. Issue #44, PR #46.
Contract: [native workers](../plans/2026-10-31-native-workers.md).
Reviewed head: `e4c4acc152b66b89f6adc378cac0b2c534669e6c`.

**Default-off and draft.** The four reported defects have regression coverage
and targeted real-host rechecks. This is not certification of the entire
W1-W4 acceptance matrix or permission to enable a user profile.

## Review fixes

| Review | Change |
|---|---|
| W1-R4 / P1 | Storage read health is separate from lock ownership. Failed reads retain known indexes and retry without requiring a changed stamp. Before indexing or during failed lookup, the final guard denies worker-forbidden names for Sessions without positive Bot/task/group/managed-plain ownership. Worker authority is the persisted Session reservation; renaming the native title does not change it. |
| W1-R1 / P1 | Cosmetic restriction uses global schemas only. Scoped-only default-preset tools are governed by the execution guard and do not abort setup. |
| W1-R2 / P1 | A single flight remembers newer triggers and rereads before releasing its slot. Idle notifications and a one-second, single-flight periodic check reconcile unsettled runs. Failed attempts keep the existing bounded retry budget. |
| W1-R3 / P2 | Stop persists its run identity and log checkpoint before native cancellation. A matching owned abort waits for quiescence, then records cancelled with the exact native reason nested in its finish. Earlier completed/failed outcomes and interrupted-to-unknown are retained. |

Cold terminal cleanup also exposed a missing `sessionQuery` injection for the
public non-activating `SessionController.inspect()` path. Declaring that
dependency lets persisted, non-live workers settle and archive without
resuming model work.

## Automated checks

- `npm ci`, `npm run harness`, `npm run build`: passed.
- `npm test`: 1578 total, 1577 passed, one existing Windows skip, zero failed;
  the process exited naturally.
- `node scripts/build-client.mjs --check` and `npm run lint`: passed.
- Worker suite against the fixed DSH checkout: **37/37**.
- Seven selected regressions run against the reviewed head: **0/7 passed**,
  reproducing the defects; those regressions pass in the current worker suite.
- Storage regressions inject EACCES at `node:fs/promises.readFile`, replace the
  actual state file with a directory for EISDIR, or write version 2 to disk.
  They do not replace `rt.load`.
- The inspect race waits beyond one-time startup recovery so startup cannot
  rescue a missing terminal notification and make the regression pass.

The component suite still has controller/preset/directory fixtures. The
real-host evidence below separately exercises the actual default composition,
controller, permissions, PTC and persistence.

## Real isolated host

Runtime: Windows, DSH `0.2.1-rc.2`, checkout
`687f282e8625c6b8d11ff58211a90524be2e4317`. The native Windows `dev/bench.ps1`
launcher was copied untracked from `origin/main`. Profiles use a Windows
`link:` dependency into this worktree and the scripted mock, with ports
6696/12696. No DSH implementation or live profile was changed.

The initial draft's launch blocker was overcome with the Windows launcher.
The final fresh flag-off smoke is **52/52**, including the dependency
declaration. Acceptance data from the worker probes is kept separately.

The probe calls production `run_worker` through mock-generated tools in real
task turns. It pauses public services/middleware and inspects durable logs.
The real default `standard` preset retains its scoped `subagent`; no global
subagent sentinel is added to make setup succeed.

**20/20 targeted host probes**, plus **3/3 done-after-result checks**:

| Row | Rechecked evidence |
|---|---|
| A1 | Default-preset first worker completes; one result in its requester task Session, zero in the other participant/trunk. Pre-step rejection, assembly failure and request preparation failure bind claim/turn before the original user-message and produce one failed result. Empty completion produces `(no final text)`. A genuinely queued inbox message remains pending without an invented claim, then completes once released. |
| A2 | Terminal during inspect/save/flush awaits settles completed with one result and no HMR. Three stale history reads while the Agent is idle are repaired by periodic checking. Actual controller `attachments.admitPromptContent` delayed past terminal commit yields one rpcId admission, closed admissions, settled cleanup and one late result. After settlement, all three tasks can close done and archive, retaining their completed runs. |
| A4 | Trunk invocation refuses even with the actual scoped definition. A legally renamed worker cold-resumes under an actual incompatible on-disk state version; forbidden dispatches remain denied and the host stays alive. Successful reread restores its worker claim. Plugin replacement retains the same cold-resumed Agent, denies dispatch in the transition gap, then restores legal reads. Headerless resolve and prompt refuse before model work. |
| A5 | 82 ordinary scoped/re-registration calls are rejected by the worker guard; sentinel bodies execute zero times. Replacement during an awaited policy that forces allow is denied too. A read-only native PTC turn records its denied nested call, zero bodies and one result; its persisted PTC log cold-resumes successfully. Under failed ownership reads, six forbidden calls and a replacement race still execute zero bodies. |
| A8 | Done refuses an unsettled run. Blocked commits terminal/conclusion first, then drains and archives. Owned cancellation records cancelled with the actual `aborted / hook / ds-bot/worker-stop` reason, confirmed idle, one late result and no result delivery. Delayed native admission has the same outcome. Cold cleanup and three done closures preserve already completed history. |

The read-only PTC run exercises the actual nested guard. A workspace-write
PTC startup that failed with a Windows ACL error is not counted as a nested
guard success, and the sandbox was not disabled to make the probe pass.

These are the requested regression variants, not a claim that every
create/setup/follow-up/close/deletion/crash permutation in A2/A8 has been
exhausted. A3/A6/A7/A9/A10 and the remaining full-matrix variants still require
independent acceptance. W2 public controls and W3 UI/usage remain out of scope.

Every bench is stopped through its recorded PID tree. Ports 6696/12696 are
checked free after cleanup. Ignored probe scripts, synthetic logs and normalized
results remain in the worktree for independent review; they are not shipped.
