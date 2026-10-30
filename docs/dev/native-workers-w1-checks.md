# Native workers W1 checks

Date: 2026-10-31. Issue #44. Integration base: `0d1da0b5`.
Contract: [native workers](../plans/2026-10-31-native-workers.md).

**Draft, not W1 exit acceptance.** `nativeWorkers` remains default-off.
No live profile was enabled and no upstream DSH code was changed.

## Implementation

Workers are optional entries under the existing task, with a reserved native
Session id, admission digest, exact requesting endpoint and immutable history.
Creation passes route/effort only in native `agentOptions`, mounts the default
preset, forces never approval and applies the sandbox through its direct setter.
Execution denies unclassified names, including scoped team/delegation/goal/
schedule/plugin/MCP tools. Raw inbox claims bind results even before
`user/message`. Interrupted always means unknown.

Results use the existing task delivery ledger, deadline, retries and raw-log
dedupe. Terminal cleanup runs outside the task lane. Worker-result history is
classified as worker evidence. W2 public controls and W3 UI/usage are absent.
Issue #43's DSH Agent gate is unchanged apart from worker ownership conflicts.

## Automated evidence

- `npm ci`, `npm run harness`, `npm run build`: passed.
- `npm test`: 1566 tests, 1565 passed, one existing Windows skip, zero failures;
  the process exited naturally.
- `node scripts/build-client.mjs --check` and `npm run lint`: passed.
- Worker-specific suite: 25 tests. It also runs with `DSH_HARNESS` pointing to
  the DSH checkout at `687f282e8625c6b8d11ff58211a90524be2e4317`.
- An archive of integration base `0d1da0b5` was loaded beside the candidate.
  Empty flag-off registration order, all 23 global tool schemas, prompt-section
  registrations and initial state shape matched exactly.

The worker suite uses real DSH AgentRegistry, AgentLoop, SessionStore,
SessionProjections, ToolRuntime, SandboxPolicy and Approval. Its controller,
persistence, working-directory and preset facades are test fixtures. This is
component evidence, not full controller/Web or process-sandbox acceptance.

| Matrix | Evidence obtained | Remaining exit evidence |
|---|---|---|
| A1 | Native claim/pre-step rejection and assembly error; raw no-text correlation | Full controller admission, prepare failures and pending inbox cases |
| A2 | Delayed prompt fixture raced against terminal commit; no task-lane deadlock | Every create/setup/save/flush await, deletion and HMR races on full DSH |
| A3 | Interrupted raw-log replay with/without user/message stays unknown | Actual host crash, synthetic cold-resume closers and live/missed-event HMR |
| A4 | Real factory serial created gate rejects headerless activation before publication | Native UI/controller cold resume and overridden/scoped presets |
| A5 | Real ToolRuntime rejects 13 scoped forbidden/unknown names and re-registration | PTC, live HMR takeover and mid-await replacement matrix |
| A6 | Real direct read-only/never state, live tightening/cancel and no widening; cross-root refusals | Full requester matrix, junctions, native cd and answerers |
| A7 | Receiver-flush fault retries; raw splice dedupe admits one result | Full disk/crash boundaries, compaction and unavailable endpoints |
| A8 | Terminal-first blocked close drains run; one late result, unchanged conclusion | All terminal entry points, queued-result withdrawal races and archive faults |
| A9 | Actual initial native request header records provider/model/high effort | Interleaved UI defaults and header-present controller cold replay |
| A10 | Base global flag-off snapshot, limits/capability removal and ownership regressions | Full base task/DSH-Agent comparisons, forks, deleted owners and rollback rehearsal |

No complete A1-A10 row is certified by these component checks.

## Smoke blocker and cleanup

Smoke: **0/52 steps executed**, not passed. The isolated mock started, but
automatic approval review rejected the DSH Web `Start-Process` command with
`blocked by policy` and no detailed reason. A second launch restricted to an
explicit child environment was also rejected. No shell workaround was used.

Only the recorded mock PID was stopped. Ports 6696 and 12696 were confirmed
free. Full real-DSH W1 acceptance and the Windows Web smoke remain required
before this draft can be considered ready.
