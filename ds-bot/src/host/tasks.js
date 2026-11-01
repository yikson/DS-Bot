// Task sessions: a long-lived Bot hands work to another in Sessions of their own, so
// its main chat (the trunk) keeps only the user's conversation and one conclusion per
// task. The requester's task Session forks its trunk; the assignee starts fresh.
import { randomUUID } from 'node:crypto'
import { asyncScope } from './async.js'
import { HISTORY_TIMEOUT_MS } from './constants.js'
import { splitRef } from './text.js'

export const taskBrief = task => [
  `[Task: ${task.id}]`, `Title: ${task.title}`, `Brief: ${task.brief}`,
].join('\n')

export const conclusionText = task => [
  '[Task closed]', task.title, `Task: ${task.id}`, `Status: ${task.conclusion.status}`,
  `Conclusion: ${task.conclusion.text}`,
  ...(task.conclusion.evidence ? [`Evidence: ${task.conclusion.evidence}`] : []),
  ...(task.conclusion.link ? [`Link: ${task.conclusion.link}`] : []),
].join('\n')

const CONCLUSION_MAX = 1000
const LINK = /^(?:https?:\/\/\S+|[A-Za-z]:[\\/].+|\\\\.+|(?:dsh|session):\S+)$/
const STATUSES = ['done', 'blocked', 'cancelled', 'failed']
const text = value => typeof value === 'string' && value.trim().length > 0

export function install(rt) {
  const safe = asyncScope(rt)
  const warned = new Set()

  const taskCapabilities = () => {
    const ids = new Set()
    const names = Array.isArray(rt.config.taskSessions) ? rt.config.taskSessions : []
    for (const name of names) {
      const bots = text(name) ? Object.values(rt.state.bots).filter(bot => bot.name === name) : []
      if (bots.length === 1) ids.add(bots[0].id)
      else if (!warned.has(name)) {
        warned.add(name)
        rt.warn('ds-bot: invalid or ambiguous taskSessions name %s', JSON.stringify(name))
      }
    }
    return ids
  }
  const canStartTask = (requester, assignee) => {
    const ids = taskCapabilities()
    return rt.config.taskSessionsEnabled === true && requester !== assignee && ids.has(requester) && ids.has(assignee)
  }

  // Creation and closing of one task run one at a time.
  const lanes = new Map()
  const serial = (id, action) => {
    const job = (lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    lanes.set(id, job)
    return job.finally(() => { if (lanes.get(id) === job) lanes.delete(id) })
  }
  const save = async (task) => {
    task.updatedAt = Date.now()
    rt.state.tasks[task.id] = task
    rt.indexSessions()
    await rt.save({ required: true })
    return task
  }
  const openTask = (id) => {
    const task = rt.taskOf(id)
    if (task?.state !== 'open') throw new Error(`Task "${id}" is unknown or not open`)
    return task
  }

  const taskContext = (sessionId) => {
    const info = rt.live.get(sessionId)?.info
    return rt.taskForSession(sessionId)?.id
      ?? (info?.role === 'task-conclusion' ? undefined : info?.taskId)
      ?? rt.state.works?.[rt.workOf(info)]?.taskId
  }
  const taskOfTurn = (sessionId, entry = rt.live.get(sessionId)) => entry?.info?.role === 'task-conclusion'
    ? undefined : entry?.info?.taskId ?? rt.state.works?.[rt.workOf(entry?.info)]?.taskId

  // Which route a message_bot call takes; checked before anything is created or sent.
  function selectTaskRoute(sender, target, sessionId, args, room) {
    const inherited = taskContext(sessionId)
    if (inherited) {
      const task = openTask(inherited)
      if ((args.task !== undefined && args.task !== inherited) || args.reply_to === 'user' || room) throw new Error('Cannot leave the inherited task')
      if (task.sessions[sender.id] !== sessionId) throw new Error('Caller is not in its task Session')
      if (!Object.hasOwn(task.participants, target.id)) throw new Error('Target is not a task participant')
      return { kind: 'task', id: inherited }
    }
    if (args.task !== undefined) {
      if (room || args.reply_to === 'user') throw new Error('Task routing requires a private Bot request outside a group')
      if (args.task !== 'new') {
        const task = openTask(args.task)
        if (!Object.hasOwn(task.participants, sender.id) || !Object.hasOwn(task.participants, target.id)) {
          throw new Error('An explicit task requires both Bots to be participants')
        }
        return { kind: 'task', id: task.id }
      }
    }
    const root = sessionId === rt.chatOf(sender.id) && !room && args.reply_to !== 'user'
    if (root && canStartTask(sender.id, target.id)) return { kind: 'new' }
    if (args.task !== undefined) throw new Error('New tasks require an eligible root trunk and two task-enabled Bots')
    return { kind: 'trunk' }
  }

  // One task Session, set up like the Bot's own chat: title, permission, folder,
  // model and capabilities.
  async function createEndpoint(task, botId) {
    const bot = rt.botOf(botId)
    if (!bot) throw new Error('Task participant no longer exists')
    const participant = task.participants[botId]
    const dir = await rt.cleanWorkDir(task.workdir ?? rt.workDirOf({ botId }) ?? '')
      ?? (task.workdir === undefined ? undefined : await rt.real(task.workdir))
    if (dir) participant.initialWorkdir = dir
    const title = `task:${task.id}:${botId}`
    let sessionId
    if (participant.kind === 'fork') {
      const result = participant.forkAtSeq === null ? { error: { code: 'session/fork-unavailable' } }
        : await rt.ctx.sessionController.fork({ sessionId: participant.sourceSessionId, atSeq: participant.forkAtSeq, allowMigration: false })
      if (result.error?.code === 'session/fork-unavailable') {
        // A trunk with no finished turn has nothing to inherit.
        Object.assign(participant, { kind: 'fresh', inheritedThrough: null })
        return createEndpoint(task, botId)
      }
      if (result.error) throw new Error(result.error.message ?? 'Fork failed')
      sessionId = result.sessionId
    } else {
      sessionId = await rt.createSession(title, { dir })
    }
    task.sessions[botId] = sessionId
    await save(task)
    const agent = await rt.resolveAgent(sessionId)
    if (participant.kind === 'fork') {
      participant.inheritedThrough = agent.session.inheritedEventCount - 1
      // Only the task brief may start work here, not input the trunk had queued.
      agent.inbox.clear()
      await rt.ctx.sessions.flush(agent.session)
    } else participant.inheritedThrough = null
    await rt.ctx.sessionTitle.rename(agent.session, title)
    await rt.applyPermission(bot, sessionId)
    const exec = { agent, name: 'message_bot', signal: safe.signal }
    if (task.workdir !== undefined) await rt.applyTaskWorkdir(sessionId, exec)
    else await rt.approveFolder(exec, { path: dir ?? rt.sessionFolder(agent.session), sessions: [sessionId], who: { en: bot.name, zh: bot.name } })
    const ref = await rt.desiredModel(bot)
    const selection = ref ? { ...splitRef(ref), reasoningEffort: await rt.desiredEffort(bot, ref) }
      : (await rt.resolveAgent(rt.chatOf(botId))).session.requestHeader()?.config
    if (!selection?.provider || !selection?.model) throw new Error('Cannot determine the Bot model for the task')
    const selected = await rt.selectSessionModel(sessionId, selection)
    if (selected?.error) throw new Error(selected.error.message ?? 'Cannot select task model')
    await rt.ensureCapabilities(sessionId, { required: true })
    await rt.ctx.sessions.flush(agent.session)
  }

  async function openNewTask(sender, target, sessionId, brief, workdir) {
    const id = randomUUID()
    return serial(id, async () => {
      const seen = await rt.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
      if (!Array.isArray(seen?.events)) throw new Error('Cannot read the requester chat to fork it')
      const end = seen.events.findLast(event => event.type === 'turn/end')
      const task = {
        id, mode: 'v2', title: Array.from(brief.trim().split('\n')[0]).slice(0, 80).join(''), brief,
        ...(workdir === undefined ? {} : { workdir }),
        requester: sender.id, assignee: target.id, state: 'open', phase: 'creating',
        capabilityAtCreation: { requester: true, initialAssignee: true },
        participants: {
          [sender.id]: { role: 'requester', kind: 'fork', sourceSessionId: sessionId, forkAtSeq: end?.seq ?? null },
          [target.id]: { role: 'assignee', kind: 'fresh' },
        },
        sessions: {}, creationIntents: {}, pendingSends: {}, lateReplies: { count: 0, ids: [] },
        openedAt: Date.now(), updatedAt: Date.now(), closedAt: null, conclusion: null,
      }
      await save(task)
      try {
        await createEndpoint(task, sender.id)
        await createEndpoint(task, target.id)
        task.phase = 'ready'
        await save(task)
      } catch (error) {
        await terminate(task, 'failed', `Task Session setup failed: ${String(error?.message ?? error).slice(0, 300)}`)
        throw error
      }
      return task
    })
  }

  async function routeTask(choice, sender, target, sessionId, brief, args) {
    if (choice.kind === 'new') {
      const workdir = args.workdir === undefined ? undefined : await rt.cleanWorkDir(args.workdir) ?? await rt.real(rt.teamFolder())
      const task = await openNewTask(sender, target, sessionId, brief, workdir)
      return { task, sessionId: task.sessions[target.id], replySessionId: task.sessions[sender.id] }
    }
    if (choice.kind !== 'task') return {}
    const task = openTask(choice.id)
    if (task.phase !== 'ready' || !task.sessions[target.id]) throw new Error('Task Session setup is incomplete')
    return { task, sessionId: task.sessions[target.id], replySessionId: task.sessions[sender.id] }
  }

  async function sendTask(id, args, receipt = {}) {
    if (openTask(id).phase !== 'ready') throw new Error('Task Session setup is incomplete')
    return rt.deliver(args, receipt)
  }

  // The answer to a task message goes back to the task Session that sent it.
  async function sendTaskAnswer(sessionId, source, answer, long) {
    const taskId = source.taskId ?? rt.state.works?.[source.exchangeId]?.taskId
    const task = rt.taskOf(taskId)
    const name = rt.botOf(rt.selfOf(sessionId))?.name ?? 'The other Bot'
    if (task?.state !== 'open') {
      rt.warn('ds-bot: a reply for closed task %s was not delivered', taskId)
      rt.dropWork(source.exchangeId)
      await rt.save()
      return
    }
    const fromId = rt.selfOf(sessionId)
    if (task.sessions[fromId] !== sessionId) throw new Error('Reply is not from the task Session')
    if (!source.replySessionId) throw new Error('Task message has no saved caller Session')
    const work = rt.state.works?.[source.exchangeId]
    rt.closeWork(source.exchangeId, name, answer)
    await rt.deliver({
      fromId, toId: source.senderSessionId, sessionId: source.replySessionId, replySessionId: sessionId,
      taskId, role: 'reply', exchangeId: `${source.exchangeId}:reply`, replyTo: source.exchangeId,
      text: long?.text ?? answer, ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
      ...(work?.parent ? { work: work.parent } : {}),
    })
  }

  // The conclusion goes to the requester's current trunk once; a restart checks the
  // trunk before sending it again.
  async function deliverConclusion(task) {
    if (task.delivery?.state === 'delivered' || !rt.botOf(task.requester)) return
    const trunk = rt.chatOf(task.requester)
    const exchangeId = task.delivery.summaryId
    await rt.deliver({
      taskId: task.id, exchangeId, fromId: task.requester, toId: task.requester, sessionId: trunk,
      role: 'task-conclusion', text: conclusionText(task), replySessionId: task.sessions[task.requester], steer: false,
    })
    task.delivery = { summaryId: exchangeId, targets: [{ sessionId: trunk, state: 'delivered' }], targetSessionId: trunk,
      state: 'delivered', enqueuedAt: Date.now(), deliveredAt: Date.now() }
    await save(task)
  }
  async function conclusionIn(sessionId, exchangeId) {
    const agent = await rt.resolveAgent(sessionId)
    if ([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].some(message => message.source?.exchangeId === exchangeId)) return true
    const seen = await rt.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    return (seen?.events ?? []).some(event => (event.type === 'user/message' && event.data?.source?.exchangeId === exchangeId)
      || (event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(message => message.source?.exchangeId === exchangeId)))
  }

  // Ends a task: stops its other running turns and work, then sends the conclusion.
  async function terminate(task, status, conclusion, extra = {}, caller) {
    Object.assign(task, { state: status, closedAt: Date.now(), conclusion: { status, text: conclusion, ...extra },
      delivery: { summaryId: `${task.id}:closed`, targets: [], state: 'pending' } })
    if (caller) task.closedBy = { sessionId: caller }
    await save(task)
    rt.cancelTaskFailureResumes?.(task.id)
    for (const [workId, work] of Object.entries(rt.state.works ?? {})) if (work.taskId === task.id) rt.dropWork(workId)
    await rt.save()
    for (const sessionId of Object.values(task.sessions)) {
      if (sessionId === caller || rt.live.get(sessionId)?.turn === undefined) continue
      ;(await rt.resolveAgent(sessionId)).cancel({ kind: 'hook', reason: 'ds-bot/task-closed' })
    }
    await deliverConclusion(task).catch(error => rt.warn('ds-bot: task %s conclusion not delivered yet: %s', task.id, error))
  }

  async function closeTask(sessionId, args) {
    await rt.load()
    const id = args.task ?? rt.taskForSession(sessionId)?.id
    const task = rt.taskOf(id)
    if (!task) throw new Error(`Unknown task "${id}"`)
    if (task.sessions[task.requester] !== sessionId) throw new Error('Only the requester task Session can close this task')
    const { status, conclusion, evidence, link } = args
    if (!STATUSES.includes(status) || !text(conclusion)) throw new Error('Give a status and concise conclusion')
    if (status === 'done' && !text(evidence)) throw new Error('Done requires non-empty evidence')
    if (link !== undefined && (typeof link !== 'string' || /[\r\n]/.test(link) || !LINK.test(link))) throw new Error('Link must be one URL, absolute path or Session link')
    const extra = { ...(text(evidence) ? { evidence: evidence.trim() } : {}), ...(link ? { link } : {}) }
    if (Array.from(conclusionText({ ...task, conclusion: { status, text: conclusion.trim(), ...extra } })).length > CONCLUSION_MAX) {
      throw new Error(`The complete task conclusion must be at most ${CONCLUSION_MAX} characters`)
    }
    return serial(id, async () => {
      if (task.state !== 'open') throw new Error('This task is already closed')
      const current = rt.workOf(rt.live.get(sessionId)?.info)
      const busy = Object.entries(rt.state.works ?? {}).some(([workId, work]) => work.taskId === id && workId !== current)
        || Object.values(task.sessions).some(other => other !== sessionId && rt.live.get(other)?.turn !== undefined)
      if (status === 'done' && busy) throw new Error('Task still has open work; wait for it or close with another status')
      await terminate(task, status, conclusion.trim(), extra, sessionId)
      return `Task ${id} closed as ${status}; its conclusion is recorded for the main chat.`
    })
  }

  async function removeTaskBot(botId) {
    for (const task of [...rt.taskById.values()]) {
      if (task.state !== 'open' || !Object.hasOwn(task.participants, botId)) continue
      await serial(task.id, () => terminate(task, 'failed', `Participant ${rt.botOf(botId)?.name ?? botId} was removed.`))
    }
  }

  // After a restart: setup that was cut off fails, and a conclusion that may not have
  // arrived is checked and sent.
  async function recoverTasks() {
    for (const task of [...rt.taskById.values()]) {
      try {
        if (task.state === 'open' && task.phase === 'creating') {
          await serial(task.id, () => terminate(task, 'failed', 'Task Session setup was interrupted by a restart.'))
        } else if (task.state !== 'open' && task.delivery && task.delivery.state !== 'delivered' && rt.botOf(task.requester)) {
          await serial(task.id, async () => {
            if (await conclusionIn(rt.chatOf(task.requester), task.delivery.summaryId)) {
              const trunk = rt.chatOf(task.requester)
              task.delivery = { summaryId: task.delivery.summaryId, targets: [{ sessionId: trunk, state: 'delivered' }],
                targetSessionId: trunk, state: 'delivered', enqueuedAt: Date.now(), deliveredAt: Date.now() }
              await save(task)
            } else await deliverConclusion(task)
          })
        }
      } catch (error) {
        rt.warn('ds-bot: recovering task %s failed: %s', task.id, error)
      }
    }
  }

  Object.assign(rt, { taskCapabilities, canStartTask, taskContext, taskOfTurn, selectTaskRoute, routeTask,
    sendTask, sendTaskAnswer, closeTask, removeTaskBot, recoverTasks })
}
