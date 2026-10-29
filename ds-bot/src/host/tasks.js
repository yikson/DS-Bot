import { asyncScope } from './async.js'
import { isDeepStrictEqual } from 'node:util'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const states = ['open', 'blocked', 'done', 'cancelled', 'failed']

function validateDeliveryUpdate(before, after) {
  if (isDeepStrictEqual(before, after)) return
  const require = (valid, message) => { if (!valid) throw new Error(`Invalid terminal task delivery: ${message}`) }
  const stages = ['pending', 'enqueued', 'delivered']
  const fields = ['summaryId', 'targetSessionId', 'targets', 'state', 'enqueuedAt', 'deliveredAt']
  require(record(after) && Object.keys(after).every(key => fields.includes(key)), 'only conclusion delivery bookkeeping is allowed')
  require(text(after.summaryId) && (before?.summaryId === undefined || after.summaryId === before.summaryId), 'summaryId is immutable once recorded')
  require(stages.includes(after.state) && Array.isArray(after.targets), 'invalid state or target history')
  require(after.targets.every(target => record(target) && Object.keys(target).every(key => ['sessionId', 'state'].includes(key))
    && text(target.sessionId) && stages.includes(target.state)), 'invalid target record')
  require(new Set(after.targets.map(target => target.sessionId)).size === after.targets.length, 'target Sessions must be unique')
  if (after.targetSessionId === undefined) {
    require(after.targets.length === 0 && after.state === 'pending'
      && after.enqueuedAt === undefined && after.deliveredAt === undefined, 'delivery needs a recorded target')
  } else {
    require(text(after.targetSessionId) && after.targets.some(target => target.sessionId === after.targetSessionId),
      'current target must be in the target history')
  }
  const oldTargets = before?.targets ?? []
  require(Array.isArray(oldTargets) && after.targets.length >= oldTargets.length, 'target history cannot be removed')
  for (const [index, target] of oldTargets.entries()) {
    require(after.targets[index].sessionId === target.sessionId
      && stages.indexOf(after.targets[index].state) >= stages.indexOf(target.state), 'saved targets cannot be replaced or lose confirmations')
  }
  for (const key of ['enqueuedAt', 'deliveredAt']) {
    require((after[key] === undefined || Number.isFinite(after[key]))
      && (before?.[key] === undefined || after[key] !== undefined), 'confirmation times must be finite and retained')
  }
}

// Validate persisted data without repairing it: unknown creation outcomes must survive reload.
export function validateTask(task, id) {
  const require = (valid, message) => { if (!valid) throw new Error(`Invalid task ${id}: ${message}`) }
  require(record(task) && text(id) && task.id === id && task.mode === 'v2', 'expected a v2 record with its own id')
  require(text(task.title) && text(task.brief), 'title and brief are required')
  require(text(task.requester) && text(task.assignee) && task.requester !== task.assignee, 'distinct requester and assignee are required')
  require(states.includes(task.state) && ['creating', 'ready', 'closing'].includes(task.phase), 'invalid state or phase')
  require(task.capabilityAtCreation?.requester === true && task.capabilityAtCreation?.initialAssignee === true, 'creation requires both capabilities')
  require(record(task.sessions) && record(task.participants), 'sessions and participants must be maps')
  require(task.participants[task.requester]?.role === 'requester' && task.participants[task.assignee]?.role === 'assignee', 'root roles are required')
  for (const [botId, participant] of Object.entries(task.participants)) {
    require(text(botId) && record(participant), 'invalid participant')
    require(participant.role === (botId === task.requester ? 'requester' : botId === task.assignee ? 'assignee' : 'participant'), 'invalid participant role')
    require(['fork', 'fresh', 'trunk'].includes(participant.kind), 'invalid endpoint kind')
    require(botId !== task.requester || participant.kind !== 'trunk', 'requester must own a Session')
    require(participant.kind !== 'fork' || botId === task.requester, 'only the requester can fork')
    require(botId !== task.assignee || participant.kind === 'fresh', 'initial assignee must start fresh')
    if (task.phase === 'ready') {
      require(text(task.sessions[botId]), 'ready participants need an endpoint')
      if (participant.kind === 'fork') require(Number.isInteger(participant.inheritedThrough) && participant.inheritedThrough >= 0, 'fork boundary is required')
    }
    require(participant.initialWorkdir === undefined || text(participant.initialWorkdir), 'invalid initial workdir')
    if (participant.kind === 'fresh') require(participant.inheritedThrough === undefined || participant.inheritedThrough === null || participant.inheritedThrough === 0, 'fresh Sessions have no inherited history')
  }
  for (const [botId, sessionId] of Object.entries(task.sessions)) {
    require(Object.hasOwn(task.participants, botId) && text(sessionId), 'endpoint has no participant or Session')
  }
  require(new Set(Object.values(task.sessions)).size === Object.keys(task.sessions).length, 'participants cannot share an endpoint')
  require(task.workdir === undefined || text(task.workdir), 'invalid workdir')
  require(Number.isFinite(task.openedAt) && Number.isFinite(task.updatedAt), 'timestamps are required')
  require(task.closedAt === null || Number.isFinite(task.closedAt), 'invalid closedAt')
  require(task.conclusion === null || record(task.conclusion), 'invalid conclusion')
  require(record(task.creationIntents) && record(task.pendingSends), 'creationIntents and pendingSends must be maps')
  for (const [requestId, intent] of Object.entries(task.creationIntents)) {
    require(record(intent) && text(requestId) && intent.requestId === requestId && intent.taskId === id, 'invalid creation request identity')
    require(text(intent.botId) && Object.hasOwn(task.participants, intent.botId)
      && task.participants[intent.botId].kind !== 'trunk' && ['fork', 'fresh'].includes(intent.operation), 'invalid creation participant or operation')
    require(intent.operation === 'fresh' || (intent.botId === task.requester && text(intent.sourceSessionId)), 'fork needs its requester source Session')
    require(text(intent.marker) && ['creating', 'created', 'unknown', 'failed'].includes(intent.state), 'invalid creation marker or state')
    require(intent.state !== 'created' || text(intent.sessionId), 'created intent needs its Session id')
    require(intent.sessionId === undefined || (text(intent.sessionId) && intent.sessionId === task.sessions[intent.botId]), 'created Session must match its saved endpoint')
  }
  require(new Set(Object.values(task.creationIntents).map(intent => intent.marker)).size === Object.keys(task.creationIntents).length, 'creation markers must be unique')
  const unresolved = Object.values(task.creationIntents).filter(intent => ['creating', 'unknown'].includes(intent.state))
  require(new Set(unresolved.map(intent => intent.botId)).size === unresolved.length, 'an unresolved creation cannot be attempted again')
  require(record(task.lateReplies) && Array.isArray(task.lateReplies.ids)
    && task.lateReplies.ids.every(text) && new Set(task.lateReplies.ids).size === task.lateReplies.ids.length
    && task.lateReplies.count === task.lateReplies.ids.length, 'late reply count must match unique source ids')
  return task
}

export function install(rt) {
  const safe = asyncScope(rt)
  const warned = new Set()
  const warnOnce = (key, message, value) => {
    if (warned.has(key)) return
    warned.add(key)
    rt.warn(message, value)
  }
  // Resolve exact, unique names on each query, just like legacy work-branch pairs.
  const taskCapabilities = () => {
    const ids = new Set()
    const matches = name => text(name) ? Object.values(rt.state.bots).filter(bot => bot.name === name) : []
    const names = rt.config.taskSessions ?? []
    if (!Array.isArray(names)) warnOnce('names', 'ds-bot: invalid taskSessions list %s', JSON.stringify(names))
    for (const name of Array.isArray(names) ? names : []) {
      const bots = matches(name)
      if (bots.length === 1) ids.add(bots[0].id)
      else warnOnce(`name:${JSON.stringify(name)}`, 'ds-bot: invalid or ambiguous taskSessions name %s', JSON.stringify(name))
    }
    const pairs = rt.config.workBranches ?? []
    if (!Array.isArray(pairs)) warnOnce('pairs', 'ds-bot: invalid workBranches list %s', JSON.stringify(pairs))
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      const bots = Array.isArray(pair) && pair.length === 2 ? pair.map(matches) : []
      const key = JSON.stringify(pair)
      if (bots.length !== 2 || bots.some(found => found.length !== 1) || bots[0][0] === bots[1][0]) {
        warnOnce(`pair:${key}`, 'ds-bot: invalid work branch pair %s', key)
        continue
      }
      warnOnce(`alias:${key}`, 'ds-bot: workBranches pair %s is deprecated; use taskSessions for v2 capability (the rollout gate stays separate)', key)
      for (const [bot] of bots) ids.add(bot.id)
    }
    return ids
  }
  const taskCapabilitySnapshot = (requester, assignee) => {
    const ids = taskCapabilities()
    return { requester: ids.has(requester), initialAssignee: ids.has(assignee) }
  }
  const canStartTask = (requester, assignee) => {
    const snapshot = taskCapabilitySnapshot(requester, assignee)
    return rt.config.taskSessionsEnabled === true && requester !== assignee && snapshot.requester && snapshot.initialAssignee
  }

  const commits = new Map()
  // Store-only, synchronous updater. Session side effects belong to the later lifecycle lane.
  const commitTask = (id, update) => {
    const job = (commits.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await rt.load()
      if (safe.stopped) throw new Error('Cannot commit a task after this host stopped')
      if (rt.readOnly()) throw new Error(rt.readOnly())
      if (!record(rt.state.tasks)) throw new Error('Invalid task table; expected a map')
      const previous = rt.own(rt.state.tasks, id)
      if (previous !== undefined) validateTask(previous, id)
      const next = update(previous === undefined ? undefined : structuredClone(previous))
      if (next && typeof next.then === 'function') {
        Promise.resolve(next).catch(() => {})
        throw new Error('Task updater must be synchronous')
      }
      validateTask(next, id)
      if (previous) {
        if (previous.mode !== next.mode || previous.requester !== next.requester || previous.assignee !== next.assignee
          || JSON.stringify(previous.capabilityAtCreation) !== JSON.stringify(next.capabilityAtCreation)) throw new Error('Task creation identity is immutable')
        if (previous.state !== 'open') {
          const { lateReplies: before, delivery: oldDelivery, sends: oldSends, ...closed } = previous
          const { lateReplies: after, delivery, sends, ...changed } = next
          const { ids: oldIds, count: _oldCount, results: oldResults = [], ...oldExtra } = before
          const { ids, count: _count, results = [], ...extra } = after
          const added = ids.length - oldIds.length
          if (!isDeepStrictEqual(closed, changed) || !isDeepStrictEqual(oldExtra, extra)
            || added < 0 || !isDeepStrictEqual(ids.slice(0, oldIds.length), oldIds)
            || !Array.isArray(results) || results.length !== oldResults.length + added
            || !isDeepStrictEqual(results.slice(0, oldResults.length), oldResults)
            || results.slice(oldResults.length).some((result, index) => !record(result)
              || result.resultId !== ids[oldIds.length + index] || !text(result.exchangeId)
              || !text(result.sessionId) || !Number.isFinite(result.at))) {
            throw new Error('A terminal task may only append late replies or update conclusion delivery')
          }
          validateDeliveryUpdate(oldDelivery, delivery)
          if (!isDeepStrictEqual(oldSends, sends)) {
            if (!record(sends) || !isDeepStrictEqual(Object.keys(oldSends ?? {}), Object.keys(sends))) throw new Error('A terminal task cannot add sends')
            for (const [id, saved] of Object.entries(oldSends)) {
              if (!isDeepStrictEqual(saved.args, sends[id].args)
                || Object.keys(sends[id]).some(key => !['args', 'delivery'].includes(key))) throw new Error('A terminal task cannot change send identity')
              validateDeliveryUpdate(saved.delivery, sends[id].delivery)
            }
          }
        }
        for (const [botId, participant] of Object.entries(previous.participants)) {
          if (!Object.hasOwn(next.participants, botId)) throw new Error('Task participants cannot be removed')
          if (previous.sessions[botId] && (next.participants[botId].kind !== participant.kind
            || (participant.kind !== 'trunk' && next.sessions[botId] !== previous.sessions[botId]))) throw new Error('Task-owned endpoints are immutable')
        }
        for (const [requestId, intent] of Object.entries(previous.creationIntents)) {
          const changed = next.creationIntents[requestId]
          if (!changed || ['requestId', 'taskId', 'botId', 'operation', 'sourceSessionId', 'marker'].some(key => changed[key] !== intent[key])) throw new Error('Creation intent identity is immutable')
          if (intent.state !== 'creating' && changed.state === 'creating') throw new Error('Creation outcome requires reconciliation; do not blindly retry')
        }
      }
      rt.indexSessions()
      rt.validateTaskSessions(next)
      Object.defineProperty(rt.state.tasks, id, { value: structuredClone(next), enumerable: true, writable: true, configurable: true })
      // Like the rest of the store, failed writes retain dirty state for a later save.
      // Rolling back here could erase a task already captured by another queued save.
      await rt.save({ required: true })
      if (safe.stopped) throw new Error('Cannot finish a task commit after this host stopped')
      return structuredClone(next)
    })
    commits.set(id, job)
    return job.finally(() => { if (commits.get(id) === job) commits.delete(id) })
  }
  Object.assign(rt, { taskCapabilities, taskCapabilitySnapshot, canStartTask, commitTask })
}
