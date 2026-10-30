import { isDeepStrictEqual } from 'node:util'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
export const unsettled = run => ['pending', 'running', 'cancelling'].includes(run.state)
export const hasWorkers = state => Object.values(state.tasks ?? {}).some(task => task?.workers
  && (typeof task.workers !== 'object' || Object.keys(task.workers).length > 0))

// Include malformed reservations: failing validation must never remove a security claim.
export function workerClaims(state) {
  const claims = new Map()
  for (const [taskId, task] of Object.entries(state.tasks ?? {})) {
    for (const [workerId, worker] of Object.entries(task?.workers ?? {})) {
      if (!text(worker?.sessionId)) continue
      const rows = claims.get(worker.sessionId) ?? []
      rows.push({ taskId, workerId, worker })
      claims.set(worker.sessionId, rows)
    }
  }
  return claims
}

export function validateWorkers(task) {
  if (task.workers === undefined) return
  const require = (valid, message) => { if (!valid) throw new Error(`Invalid task ${task.id} workers: ${message}`) }
  require(record(task.workers), 'expected a map')
  const sessions = new Set()
  const admissions = new Set()
  for (const [id, worker] of Object.entries(task.workers)) {
    require(record(worker) && text(id) && worker.id === id && worker.kind === 'native-worker'
      && worker.taskId === task.id && worker.marker === `worker:${task.id}:${id}`, 'invalid identity')
    require(text(worker.sessionId) && !sessions.has(worker.sessionId)
      && !Object.values(task.sessions).includes(worker.sessionId), 'conflicting Session')
    sessions.add(worker.sessionId)
    require(text(worker.requestedBy) && task.participants[worker.requestedBy]?.kind !== 'trunk'
      && task.sessions[worker.requestedBy] === worker.requesterSessionId, 'invalid requester endpoint')
    require(text(worker.title) && ['execute', 'verify'].includes(worker.mode), 'invalid title or mode')
    require(text(worker.sandboxRoot) && text(worker.canonicalRoot) && text(worker.initialWorkdir)
      && ['read-only', 'workspace-write'].includes(worker.sandbox)
      && (worker.mode !== 'verify' || worker.sandbox === 'read-only') && worker.approval === 'never', 'invalid permission')
    require(text(worker.initialModel?.provider) && text(worker.initialModel?.model), 'invalid initial route')
    require(Number.isSafeInteger(worker.followupCount) && worker.followupCount >= 0
      && typeof worker.admissionsClosed === 'boolean' && record(worker.runs)
      && Object.hasOwn(worker.runs, worker.currentRunId), 'invalid runs')
    require(Object.keys(worker.runs).length === worker.followupCount + 1, 'invalid lifetime count')
    require(record(worker.cleanup) && ['none', 'cancelling', 'settled'].includes(worker.cleanup.state), 'invalid cleanup state')
    for (const [runId, run] of Object.entries(worker.runs)) {
      require(record(run) && run.id === runId && Number.isSafeInteger(run.ordinal) && run.ordinal >= 0
        && runId === (run.ordinal === 0 ? id : `${id}:followup:${run.ordinal}`)
        && run.promptRequestId === runId && text(run.admissionKey) && text(run.promptDigest)
        && !admissions.has(run.admissionKey), 'invalid admission identity')
      admissions.add(run.admissionKey)
      require(['pending', 'running', 'completed', 'failed', 'unknown', 'cancelling', 'cancelled'].includes(run.state)
        && record(run.admission) && ['reserved', 'intent', 'settled'].includes(run.admission.state), 'invalid run state')
      require(!run.result || (run.result.id === `${runId}:result` && text(run.result.text)
        && Array.from(run.result.text).length <= 4000 && !unsettled(run)), 'invalid result')
      require(unsettled(run) || (record(run.finish) && text(run.finish.kind) && run.result), 'settled run needs evidence and result')
      require(run.finish?.kind !== 'interrupted' || run.state === 'unknown', 'interrupted is always unknown')
      require(run.state !== 'completed' || run.finish?.kind === 'completed', 'only completed is success')
      require(run.state !== 'unknown' || ['unknown', 'interrupted'].includes(run.finish?.kind), 'unknown needs its exact reason')
      require(run.state !== 'cancelled' || (run.finish?.kind === 'cancelled'
        && Number.isFinite(worker.cleanup.confirmedIdleAt)), 'cancelled requires confirmed quiescence')
      for (const key of ['turn', 'claimSeq', 'insertedSeq', 'requestHeaderSeq', 'endSeq']) {
        require(run[key] === undefined || (Number.isSafeInteger(run[key]) && run[key] >= 0), 'invalid evidence seq')
      }
    }
  }
}

export function validateWorkerUpdate(before = {}, after = {}, terminal = false) {
  const require = (valid, message) => { if (!valid) throw new Error(`Invalid worker update: ${message}`) }
  require(!terminal || isDeepStrictEqual(Object.keys(before), Object.keys(after)), 'terminal task cannot add workers')
  for (const [id, old] of Object.entries(before)) {
    const next = after[id]
    require(next, 'ownership tombstones cannot be removed')
    const immutable = ['id', 'kind', 'taskId', 'requestedBy', 'requesterSessionId', 'sessionId', 'marker',
      'title', 'mode', 'sandboxRoot', 'canonicalRoot', 'initialWorkdir', 'initialModel']
    require(immutable.every(key => isDeepStrictEqual(old[key], next[key])), 'immutable worker identity changed')
    require(!old.admissionsClosed || next.admissionsClosed, 'closed admissions cannot reopen')
    require(old.sandbox !== 'read-only' || next.sandbox === 'read-only', 'permission cannot increase')
    require(!terminal || (next.followupCount === old.followupCount
      && isDeepStrictEqual(Object.keys(old.runs), Object.keys(next.runs))), 'terminal task cannot add runs')
    for (const [runId, run] of Object.entries(old.runs)) {
      const changed = next.runs[runId]
      require(changed && ['id', 'ordinal', 'admissionKey', 'promptRequestId', 'promptDigest'].every(key =>
        isDeepStrictEqual(run[key], changed[key])), 'run admission identity changed')
      require(unsettled(run) || isDeepStrictEqual(run, changed), 'settled outcome is immutable')
      if (run.state === 'running') require(changed.state !== 'pending', 'running cannot return to pending')
      if (run.state === 'cancelling') require(!['pending', 'running'].includes(changed.state), 'cancellation cannot reopen a run')
      require(!run.result || isDeepStrictEqual(run.result, changed.result), 'result identity changed')
    }
    if (terminal) {
      const mutable = new Set(['runs', 'sandbox', 'admissionsClosed', 'admissionBlockReason', 'cleanup', 'archivedAt', 'diagnostic'])
      require(Object.keys(next).every(key => mutable.has(key) || isDeepStrictEqual(old[key], next[key])), 'terminal mutation outside cleanup')
    }
  }
}
