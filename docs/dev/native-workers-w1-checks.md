# Native workers W1 checks

Date: 2026-10-31. Issue #44, PR #46.
Contract: [native workers](../plans/2026-10-31-native-workers.md).
Original reviewed head: `e4c4acc152b66b89f6adc378cac0b2c534669e6c`.
External acceptance: `b58e798800d37d863867670c861cd480a0026824`,
[report](https://github.com/yikson/DS-Bot/pull/46#issuecomment-6543796856).
Post-acceptance implementation checked: `688b17a`.

**Default-off; ready for review after the accepted follow-up.** The original
four defects and the remaining identity/HMR findings have regression coverage
and targeted real-host rechecks. This does not certify the entire W1-W4 matrix
or enable a user profile. No merge or release is part of these checks.

## Review fixes

| Review | Change |
|---|---|
| W1-R4 / P1, remaining P2 | Storage read health is separate from lock ownership. Failed reads retain trusted indexes. An immutable historical Session marker and append-only creation tombstone survive index failure and rename; known workers refuse all tools and cold activation during an outage. Plain user Sessions remain usable. |
| W1-R1 / P1 | Cosmetic restriction uses global schemas only. Scoped-only default-preset tools are governed by the execution guard and do not abort setup. |
| W1-R2 / P1 | A single flight remembers newer triggers and rereads before releasing its slot. Idle notifications and a one-second, single-flight periodic check reconcile unsettled runs. Failed attempts keep the existing bounded retry budget. |
| W1-R3 / P2 | Stop persists its run identity and log checkpoint before native cancellation. A matching owned abort waits for quiescence, then records cancelled with the exact native reason nested in its finish. Earlier completed/failed outcomes and interrupted-to-unknown are retained. |

Cold terminal cleanup also exposed a missing `sessionQuery` injection for the
public non-activating `SessionController.inspect()` path. Declaring that
dependency lets persisted, non-live workers settle and archive without
resuming model work.

## Automated checks

- `npm ci`, `npm run harness`, `npm run build`: passed.
- `npm test`: 1583 total, 1582 passed, one existing Windows skip, zero failed;
  the process exited naturally.
- `node scripts/build-client.mjs --check` and `npm run lint`: passed.
- Worker suite against the fixed DSH checkout: **42/42**.
- Five additional identity/HMR regressions cover marker flush before first
  prompt, strict native format restoration, renamed cold prompt refusal under
  version 2 with marker/creation-ledger failure variants, and real Agent
  disposal on plugin reload. The three existing storage-error tests also
  deny both `send_message` and `pwsh` and keep a plain Session usable.
- Seven selected regressions run against the reviewed head: **0/7 passed**,
  reproducing the defects; those regressions pass in the current worker suite.
- Storage regressions inject EACCES at `node:fs/promises.readFile`, replace the
  actual state file with a directory for EISDIR, or write version 2 to disk.
  They do not replace `rt.load`.
- The inspect race waits beyond one-time startup recovery so startup cannot
  rescue a missing terminal notification and make the regression pass.

The format check uses the public persistence dependency's strict current-format
catalog; an invalid provider-title shape was found and corrected during the
first host trial. Final markers use the documented explicit-title shape
(`source.kind=user`, empty `messageSeqs`), which passes strict restore and
actual cold controller resume. Marker authority reads the historical event,
not the mutable current title.

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

The prior `b58e798` recheck had **20/20 targeted host probes**, plus **3/3
done-after-result checks**:

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

The external report independently accepted the W1 behavior with one P2 identity
fix and an HMR decision, now addressed below. Its BLOCKED A2 pause-point
matrix, A7 exhaustive crash points and A5 re-registration variants are explicit
W2/W4 exits requiring injectable pause points in the design. Neither the prior
probes nor this follow-up claims exhaustive certification. W2 controls,
host-owned creation research and W3 UI/usage remain out of scope.

## Post-acceptance identity and HMR checks

**7/7 final real-host probes**, on the same pinned DSH and Windows bench:

| Row rerun | Actual evidence |
|---|---|
| A1/A4 | Real default `standard` preset with scoped-only `subagent`: completed. Immutable marker at seq 0 precedes first request header at seq 13. One requester result; other participant and trunk have zero copies. |
| A4/A5 | Legally rename the worker, write root state version 2 to the actual isolated file, and force a storage refresh. Both `send_message` and `pwsh` sentinels are denied, bodies 0; the actual native `pwsh` tool is denied by worker ownership policy before sandbox/body execution. Live prompt creates a blocked turn with zero additional worker model requests. |
| A4 | Reload the plugin while that version-2 file remains unreadable. Cold native controller `prompt()` refuses with `Worker ownership is unavailable`; no live Agent is published, one historical marker remains and worker model requests increase by 0. |
| A4 | During the same outage, a user-created plain DSH Session executes its shell sentinel once and accepts a normal prompt (3 ordinary model requests). |
| A4 | Restore the valid file and refresh/recover: same worker claim returns, a forbidden tool is still denied, actual read-only `read` works, original result remains one copy. |
| A3 | Start a worker with a 30-second mock response, wait for its actual request/header, then unload/reload the plugin core on the same host PID. DSH emits exact `aborted / disposed`. Run becomes `unknown`, reason `plugin-reload`, native cause preserved, warning `may have partially run; not re-run`, admissions permanently closed. One requester result, zero foreign copies; worker requests stay 1. |
| A3 | Native re-prompt refuses with `Worker plugin-reload: native activation is permanently closed`. Explicit recovery plus a second plugin reload leaves the run/result byte-for-byte unchanged, one result copy and one lifetime worker model request. |

The controller exposes no public admission hook for an already-live Agent:
its RPC may acknowledge enqueue. The worker pre-step barrier rejects that
turn before model execution; this is reported separately from cold activation,
whose RPC rejects at awaited `agent/created`. No private host patch or model
helper was added. No worker prompt was replayed.

The default-off smoke was rerun on a fresh isolated bench through the ordinary
plugin entry, with no acceptance probe patch: **52/52**.

Every bench is stopped through its recorded PID tree. Ports 6696/12696 are
checked free after cleanup. Ignored probe scripts, synthetic logs and normalized
results remain in the worktree for independent review; they are not shipped.
