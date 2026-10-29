import { randomUUID } from 'node:crypto'
import { asyncScope } from './async.js'
import { splitRef } from './text.js'
import { HISTORY_TIMEOUT_MS } from './constants.js'

export const taskBrief = task => [
  `[Task: ${task.id}]`, `Title: ${task.title}`, `Brief: ${task.brief}`,
  ...(task.context ? [`Context: ${task.context}`] : []),
].join('\n')

export function install(rt) {
  const safe = asyncScope(rt)
  const lanes = new Map()
  const deliveryLane = {}
  const creating = new Set()
  const checkGeneration = () => {
    if (safe.stopped || rt.isStopped?.()) throw new Error('Task operation stopped; its durable intent remains pending')
  }
  // Lifecycle side effects, including close in the next slice, share this lane.
  const withTask = (id, action) => {
    const job = (lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      checkGeneration()
      let active = true
      try {
        return await action((args, receipt) => {
          if (!active || args.taskId !== id) throw new Error('Task enqueue is outside its execution lane')
          checkGeneration()
          return rt.deliver(args, receipt, deliveryLane)
        })
      } finally { active = false }
    })
    lanes.set(id, job)
    return job.finally(() => { if (lanes.get(id) === job) lanes.delete(id) })
  }
  const openTask = id => {
    checkGeneration()
    const task = rt.taskOf(id)
    if (!task || task.state !== 'open') throw new Error(`Task "${id}" is unknown or not open`)
    return task
  }
  const taskContext = sessionId => {
    const info = rt.live.get(sessionId)?.info
    const work = rt.state.works?.[rt.workOf(info)]
    const ids = [rt.taskForSession(sessionId)?.id, info?.role === 'task-conclusion' ? undefined : info?.taskId, work?.taskId].filter(Boolean)
    if (new Set(ids).size > 1) throw new Error('Conflicting inherited task context')
    return ids[0]
  }
  // Pure admission runs before receipts, Session creation, or group dispatch.
  function selectTaskRoute(sender, target, sessionId, args, room) {
    const inherited = taskContext(sessionId)
    const info = rt.live.get(sessionId)?.info
    const legacy = rt.branchOf(sessionId) ?? rt.branchForWork(rt.workOf(info))
      ?? rt.branchOf(info?.replySessionId)
    const selected = args.task !== undefined ? 'task' : args.work !== undefined ? 'work' : undefined
    if (inherited) {
      const task = openTask(inherited)
      if (selected === 'work' || (selected === 'task' && args.task !== inherited)
        || args.reply_to === 'user' || room) throw new Error('Cannot leave the inherited task')
      if (!Object.hasOwn(task.participants, sender.id)) throw new Error('Caller is not a task participant')
      if (task.participants[sender.id].kind !== 'trunk' && task.sessions[sender.id] !== sessionId) {
        throw new Error('Caller is not in its task-owned Session')
      }
      return { kind: 'task', id: inherited, inherited: true }
    }
    if (legacy) {
      if (selected === 'task' || (selected === 'work' && args.work !== legacy.id)) throw new Error('Cannot leave the inherited legacy work branch')
      return { kind: 'legacy', work: legacy.id, inherited: true }
    }
    if (selected === 'task') {
      if (room || args.reply_to === 'user') throw new Error('Task routing requires a private Bot request outside a group')
      if (args.task !== 'new') {
        const task = openTask(args.task)
        if (!Object.hasOwn(task.participants, sender.id) || !Object.hasOwn(task.participants, target.id)) {
          throw new Error('An explicit task requires both Bots to be participants')
        }
        return { kind: 'task', id: task.id }
      }
    } else if (selected === 'work') return { kind: 'legacy', work: args.work }
    const root = sessionId === rt.chatOf(sender.id) && !room && args.reply_to !== 'user'
    if (root && rt.canStartTask(sender.id, target.id)) return { kind: 'new' }
    if (selected === 'task') throw new Error('New tasks require an eligible root trunk and two task-enabled Bots')
    return { kind: 'trunk' }
  }

  const commit = async (id, update) => {
    checkGeneration()
    const result = await rt.commitTask(id, task => {
      const next = update(task)
      next.updatedAt = Date.now()
      return next
    })
    checkGeneration()
    return result
  }
  const failedCreation = (task, diagnostic) => {
    task.state = 'failed'
    task.closedAt = Date.now()
    task.diagnostic = diagnostic
    // S2c drains this normal conclusion outbox; terminal identity is saved here.
    task.conclusion = { status: 'blocked', text: diagnostic }
    task.delivery = { summaryId: `${task.id}:closed`, targets: [], state: 'pending' }
    return task
  }
  async function failCreation(id, requestId, error, confirmed = false) {
    checkGeneration()
    await commit(id, task => {
      const intent = task.creationIntents[requestId]
      intent.state = confirmed ? 'failed' : 'unknown'
      intent.diagnostic = String(error.message ?? error).slice(0, 500)
      if (!confirmed) {
        failedCreation(task, 'Session creation or setup could not be established; inspect the saved intent before retrying. No automatic recreation.')
      }
      return task
    })
  }
  async function createEndpoint(id, botId, operation) {
    let task = openTask(id)
    const bot = rt.botOf(botId)
    if (!bot) throw new Error('Task participant no longer exists')
    const initialWorkdir = await rt.cleanWorkDir(task.workdir ?? rt.workDirOf({ botId }) ?? '')
    checkGeneration()
    const requestId = randomUUID()
    const marker = `task:${id}:${botId}:${requestId}`
    const sourceSessionId = operation === 'fork' ? task.participants[botId].sourceSessionId : undefined
    const atSeq = operation === 'fork' ? task.participants[botId].forkAtSeq : undefined
    task = await commit(id, task => {
      task.phase = 'creating'
      if (initialWorkdir) task.participants[botId].initialWorkdir = initialWorkdir
      task.creationIntents[requestId] = {
        taskId: id, requestId, botId, operation, marker, state: 'creating',
        ...(sourceSessionId ? { sourceSessionId } : {}),
        ...(Number.isSafeInteger(atSeq) ? { atSeq } : {}),
      }
      return task
    })
    const saved = async sessionId => {
      checkGeneration()
      if (!sessionId) throw new Error('Creation did not return a Session id')
      await commit(id, task => {
        task.sessions[botId] = sessionId
        Object.assign(task.creationIntents[requestId], { sessionId, state: 'created' })
        return task
      })
    }
    let sessionId
    try {
      if (operation === 'fork') {
        checkGeneration()
        // A readable admission snapshot with no turn/end proves there is no
        // completed prefix. Never let a later trunk turn choose a new boundary.
        if (atSeq === null) throw Object.assign(new Error(`session "${sourceSessionId}" has no completed turn to fork from`), { code: 'session/fork-unavailable' })
        const result = await rt.ctx.sessionController.fork({ sessionId: sourceSessionId, atSeq, allowMigration: false })
        checkGeneration()
        if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        sessionId = result.sessionId
        await saved(sessionId)
      } else {
        // The standard roster path saves the id before title/model/capability setup.
        sessionId = await rt.createSession(marker, {
          dir: initialWorkdir, onCreated: saved,
        })
        checkGeneration()
      }
    } catch (error) {
      checkGeneration()
      const noTurn = operation === 'fork' && error.code === 'session/fork-unavailable'
        && /^session ".+" has no completed turn to fork from$/.test(error.message)
      await failCreation(id, requestId, error, noTurn)
      if (!noTurn) throw error
      await commit(id, task => {
        task.participants[botId].kind = 'fresh'
        task.participants[botId].inheritedThrough = null
        return task
      })
      return createEndpoint(id, botId, 'fresh')
    }
    try {
      const agent = await rt.resolveAgent(sessionId)
      checkGeneration()
      const boundary = operation === 'fork' ? agent.session.inheritedEventCount - 1 : null
      if (operation === 'fork') {
        if (!Number.isSafeInteger(boundary) || boundary !== atSeq) throw new Error('Fork did not preserve its admitted inherited boundary')
        if (agent.status !== 'idle') throw new Error('Fork started before its inherited input was isolated')
        // An enqueue can precede turn/end while its consumption follows it.
        // Only the explicit task brief may introduce work into this Session.
        agent.inbox.clear()
        await rt.ctx.sessions.flush(agent.session)
        checkGeneration()
        if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) throw new Error('Fork still has inherited pending input')
      }
      await rt.ctx.sessionTitle.rename(agent.session, marker)
      checkGeneration()
      await rt.applyPermission(bot, sessionId)
      checkGeneration()
      await rt.approveFolder({ agent, name: 'message_bot', signal: safe.signal }, {
        path: initialWorkdir ?? rt.sessionFolder(agent.session), sessions: [sessionId], who: { en: bot.name, zh: bot.name },
      })
      checkGeneration()
      if (operation === 'fork' && task.workdir) {
        await rt.ctx.workingDirectory.set(agent, initialWorkdir)
        checkGeneration()
      }
      const ref = await rt.desiredModel(bot)
      checkGeneration()
      const selection = ref ? { ...splitRef(ref), reasoningEffort: await rt.desiredEffort(bot, ref) }
        : (await rt.resolveAgent(rt.chatOf(botId))).session.requestHeader()?.config
      checkGeneration()
      if (!selection?.provider || !selection?.model) throw new Error('Cannot determine the Bot model for the task')
      const selected = await rt.selectSessionModel(sessionId, selection)
      checkGeneration()
      if (selected?.error) throw new Error(selected.error.message ?? 'Cannot select task model')
      await rt.ensureCapabilities(sessionId, { required: true })
      checkGeneration()
      await rt.ctx.sessions.flush(agent.session)
      checkGeneration()
      await commit(id, task => {
        task.participants[botId].inheritedThrough = boundary
        return task
      })
      return sessionId
    } catch (error) {
      await failCreation(id, requestId, error)
      throw error
    }
  }
  async function participant(id, botId) {
    const task = openTask(id)
    if (task.sessions[botId]) return
    if (!Object.hasOwn(task.participants, botId)) {
      const kind = rt.taskCapabilities().has(botId) ? 'fresh' : 'trunk'
      await commit(id, task => {
        task.phase = 'creating'
        task.participants[botId] = { role: 'participant', kind }
        if (kind === 'trunk') task.sessions[botId] = rt.chatOf(botId)
        return task
      })
      if (kind === 'trunk') return
    }
    await createEndpoint(id, botId, openTask(id).participants[botId].kind)
  }
  async function routeTask(choice, sender, target, sessionId, text, args) {
    if (choice.kind !== 'new' && choice.kind !== 'task') return {}
    const id = choice.id ?? randomUUID()
    return withTask(id, async () => {
      if (choice.kind === 'new') {
        creating.add(id)
        try {
          const observed = await rt.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
          checkGeneration()
          if (!Array.isArray(observed?.events)) throw new Error('Cannot inspect the requester fork boundary')
          const end = observed.events.findLast(event => event.type === 'turn/end')
          if (end && (!Number.isSafeInteger(end.seq) || end.seq < 0)) throw new Error('Invalid requester fork boundary')
          await commit(id, () => {
            if (selectTaskRoute(sender, target, sessionId, args).kind !== 'new') throw new Error('Task admission changed')
            return {
              id, mode: 'v2', title: Array.from(text.trim().split('\n')[0]).slice(0, 80).join(''), brief: text,
              requester: sender.id, assignee: target.id, state: 'open', phase: 'creating',
              capabilityAtCreation: rt.taskCapabilitySnapshot(sender.id, target.id),
              participants: {
                [sender.id]: { role: 'requester', kind: 'fork', sourceSessionId: sessionId, forkAtSeq: end?.seq ?? null },
                [target.id]: { role: 'assignee', kind: 'fresh' },
              },
              sessions: {}, creationIntents: {}, pendingSends: {}, lateReplies: { count: 0, ids: [] },
              openedAt: Date.now(), updatedAt: Date.now(), closedAt: null, conclusion: null,
            }
          })
          await createEndpoint(id, sender.id, 'fork')
          await createEndpoint(id, target.id, 'fresh')
          await commit(id, task => { task.phase = 'ready'; return task })
        } finally { creating.delete(id) }
      } else {
        const task = openTask(id)
        if (task.phase !== 'ready') throw new Error('Task Session setup is incomplete; do not repeat creation')
        if (!Object.hasOwn(task.participants, sender.id)) throw new Error('Caller is not a task participant')
        if (!Object.hasOwn(task.participants, target.id) && !choice.inherited) throw new Error('Target is not a task participant')
        if (!task.sessions[target.id]) {
          creating.add(id)
          try {
            await participant(id, target.id)
            await commit(id, task => { task.phase = 'ready'; return task })
          } finally { creating.delete(id) }
        }
      }
      for (const botId of [sender.id, target.id]) {
        const task = openTask(id)
        if (task.participants[botId].kind === 'trunk' && task.sessions[botId] !== rt.chatOf(botId)) {
          await commit(id, task => { task.sessions[botId] = rt.chatOf(botId); return task })
        }
      }
      const task = openTask(id)
      return { task, sessionId: task.sessions[target.id], replySessionId: task.sessions[sender.id] }
    })
  }
  function checkTaskDelivery(args) {
    const task = openTask(args.taskId)
    if (task.phase !== 'ready') throw new Error('Task Session setup is incomplete')
    const target = task.sessions[args.toId]
    if (!target || target !== args.sessionId) throw new Error('Task delivery endpoint changed')
    return task
  }
  async function prepareTaskDelivery(args) {
    const task = openTask(args.taskId)
    if (task.participants[args.toId]?.kind !== 'trunk') return
    const current = rt.chatOf(args.toId)
    if (task.sessions[args.toId] !== current) {
      await commit(task.id, task => {
        task.sessions[args.toId] = current
        const pending = task.pendingSends[args.exchangeId]
        if (pending) pending.sessionId = current
        return task
      })
    }
    args.sessionId = current
  }
  async function dispatchTask(id, args, receipt, inspect, enqueue) {
    if (args.taskId !== id || typeof args.exchangeId !== 'string' || !args.exchangeId
      || !Object.hasOwn(openTask(id).participants, args.fromId)) throw new Error('Task send identity does not match its execution lane')
    const deliveryId = args.exchangeId
    await prepareTaskDelivery(args)
    checkTaskDelivery(args)
    await commit(id, task => {
      task.pendingSends[args.exchangeId] = { ...args, state: 'pending' }
      return task
    })
    checkTaskDelivery(args)
    const seen = inspect && await rt.branchDelivered(args.sessionId, args.exchangeId, undefined, args.failureResumes)
    checkGeneration()
    if (inspect && args.merge && !seen) {
      await commit(id, task => {
        task.pendingSends[deliveryId].diagnostic = 'Merged delivery outcome is unknown; inspect before retrying'
        return task
      })
      return false
    }
    if (seen) {
      const agent = await rt.resolveAgent(args.sessionId)
      checkGeneration()
      await rt.ctx.sessions.flush(agent.session)
    } else await enqueue(args, receipt)
    checkGeneration()
    if (receipt.skipped) return false
    await commit(id, task => { delete task.pendingSends[deliveryId]; return task })
    return true
  }
  const sendTask = (id, args, receipt = {}) => withTask(id, enqueue => dispatchTask(id, args, receipt, false, enqueue))
  const resumeTaskAnswer = workId => {
    const work = rt.state.works?.[workId]
    const pending = work?.pendingAnswer
    if (!pending?.args.taskId) return
    return withTask(pending.args.taskId, async enqueue => {
      if (!await dispatchTask(pending.args.taskId, pending.args, {}, true, enqueue)) return
      checkGeneration()
      rt.closeWork(workId, pending.name, pending.text)
      await rt.save({ required: true })
      checkGeneration()
    })
  }
  async function sendTaskAnswer(sessionId, source, text, long) {
    const work = rt.state.works?.[source.exchangeId]
    const taskId = source.taskId ?? work?.taskId
    return withTask(taskId, async enqueue => {
      const task = rt.taskOf(taskId)
      if (!task) throw new Error(`Unknown task "${taskId}"`)
      if (task.state !== 'open') return rt.recordTaskLateReply(taskId, sessionId, source.exchangeId, text)
      const fromId = rt.selfOf(sessionId)
      if (!Object.hasOwn(task.participants, fromId)
        || (task.participants[fromId].kind !== 'trunk' && task.sessions[fromId] !== sessionId)) throw new Error('Reply is not from the task endpoint')
      const name = rt.botOf(fromId)?.name ?? 'The other Bot'
      const args = work?.pendingAnswer?.args ?? {
        fromId, toId: source.senderSessionId, sessionId: source.replySessionId,
        replySessionId: sessionId, taskId, role: 'reply',
        exchangeId: `${source.exchangeId}:reply`, replyTo: source.exchangeId,
        text: long?.text ?? text, ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
        ...(work?.parent ? { work: work.parent } : {}),
      }
      if (!args.sessionId) throw new Error('Task exchange has no saved caller Session')
      if (work) {
        work.pendingAnswer ??= { args, name, text }
        await rt.save({ required: true })
        checkGeneration()
      }
      if (!await dispatchTask(taskId, args, {}, true, enqueue)) return
      rt.closeWork(source.exchangeId, name, text)
      await rt.save({ required: true })
      checkGeneration()
    })
  }
  async function recoverTaskCreations() {
    for (const task of Array.from(rt.taskById.values())) {
      if (creating.has(task.id) || task.state !== 'open' || task.phase !== 'creating') continue
      await withTask(task.id, () => commit(task.id, task => {
        // DSH cannot atomically apply a marker in fork/create. A missing id is
        // not proof of non-creation, and an unmarked orphan cannot be excluded.
        for (const intent of Object.values(task.creationIntents)) {
          if (intent.state === 'creating') {
            intent.state = 'unknown'
            intent.diagnostic = 'Creation interrupted; atomic marker lookup is unavailable'
          }
        }
        return failedCreation(task, 'Interrupted Session setup requires inspection; atomic marker lookup is unavailable. No automatic recreation.')
      }))
    }
  }
  async function recoverTasks() {
    await recoverTaskCreations()
    checkGeneration()
    for (const task of Array.from(rt.taskById.values())) {
      if (task.state !== 'open' || task.phase !== 'ready') continue
      for (const saved of Object.values(task.pendingSends)) {
        const args = { ...saved }
        delete args.state
        await withTask(task.id, enqueue => dispatchTask(task.id, args, {}, true, enqueue))
      }
    }
    await rt.recoverTaskLifecycle?.()
  }
  Object.assign(rt, { taskContext, selectTaskRoute, routeTask, withTask, sendTask, sendTaskAnswer,
    resumeTaskAnswer, checkTaskDelivery, prepareTaskDelivery, recoverTaskCreations, recoverTasks })
  const deliver = rt.deliver
  rt.deliver = (args, receipt = {}, lane) => {
    const send = () => args.taskId && rt.runTaskDelivery
      ? rt.runTaskDelivery(args, receipt, () => deliver(args, receipt)) : deliver(args, receipt)
    return args.taskId && lane !== deliveryLane ? withTask(args.taskId, send) : send()
  }
}
