import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { asyncScope } from './async.js'
import { HISTORY_TIMEOUT_MS, SOURCE_KIND } from './constants.js'

export const TASK_CONCLUSION_HEADER = '[Task closed]'
export const conclusionText = task => [
  TASK_CONCLUSION_HEADER, task.title, `Task: ${task.id}`, `Status: ${task.conclusion.status}`,
  `Conclusion: ${task.conclusion.text}`,
  ...(task.conclusion.evidence ? [`Evidence: ${task.conclusion.evidence}`] : []),
  ...(task.conclusion.link ? [`Link: ${task.conclusion.link}`] : []),
].join('\n')

export function install(rt) {
  const safe = asyncScope(rt)
  const check = () => {
    if (safe.stopped || rt.isStopped?.()) throw new Error('Task operation stopped; delivery remains pending')
    if (rt.readOnly()) throw new Error(rt.readOnly())
  }
  const taskOf = id => {
    check()
    const task = rt.taskOf(id)
    if (!task) throw new Error(`Unknown task "${id}"`)
    return task
  }
  const commit = async (id, update) => {
    check()
    const result = await rt.commitTask(id, update)
    check()
    return result
  }
  const ofTurn = (sessionId, entry = rt.live.get(sessionId)) => entry?.info?.role === 'task-conclusion'
    ? undefined : entry?.info?.taskId ?? rt.state.works?.[rt.workOf(entry?.info)]?.taskId
  const ledgerOf = (task, args) => args.role === 'task-conclusion' ? task.delivery : task.sends?.[args.exchangeId]?.delivery
  const destination = (task, args) => args.role === 'task-conclusion'
    ? rt.chatOf(task.requester) : task.participants[args.toId]?.kind === 'trunk'
      ? rt.chatOf(args.toId) : task.sessions[args.toId]
  const updateLedger = (args, update) => commit(args.taskId, task => {
    const ledger = ledgerOf(task, args)
    if (!ledger) throw new Error('Task delivery has no durable intent')
    update(ledger)
    return task
  })
  async function prepare(args) {
    let task = taskOf(args.taskId)
    if (args.role !== 'task-conclusion' && task.state !== 'open'
      && !(args.deferred || args.resent)) throw new Error('This task is not open')
    const current = destination(task, args)
    if (!current) throw new Error('Task participant has no endpoint')
    if (args.role !== 'task-conclusion' && !task.sends?.[args.exchangeId]) {
      if (task.state !== 'open') throw new Error('Terminal tasks cannot admit new deliveries')
      await commit(task.id, task => {
        task.sends ??= {}
        task.sends[args.exchangeId] = { args: { ...args, sessionId: current },
          delivery: { summaryId: args.exchangeId, targets: [], state: 'pending' } }
        return task
      })
    }
    task = taskOf(task.id)
    if (!ledgerOf(task, args).targets.some(target => target.sessionId === current)
      || ledgerOf(task, args).targetSessionId !== current
      || (task.state === 'open' && task.participants[args.toId]?.kind === 'trunk' && task.sessions[args.toId] !== current)) {
      await commit(task.id, task => {
        const ledger = ledgerOf(task, args)
        if (!ledger.targets.some(target => target.sessionId === current)) ledger.targets.push({ sessionId: current, state: 'pending' })
        ledger.targetSessionId = current
        if (args.role !== 'task-conclusion' && task.state === 'open' && task.participants[args.toId]?.kind === 'trunk') {
          task.sessions[args.toId] = current
        }
        return task
      })
    }
    args.sessionId = current
  }
  function atBoundary(args, { forwarding = false } = {}) {
    const task = taskOf(args.taskId)
    if (args.role === 'task-conclusion') {
      if (task.state === 'open' || task.delivery?.summaryId !== args.exchangeId || args.toId !== task.requester) throw new Error('Invalid task conclusion')
    } else {
      if (task.state !== 'open' && !(forwarding || args.deferred || args.resent)) throw new Error('This task is not open')
      if (task.phase !== 'ready') throw new Error('Task Session setup is incomplete')
    }
    const ledger = ledgerOf(task, args)
    if (!ledger || ledger.targetSessionId !== args.sessionId || destination(task, args) !== args.sessionId) {
      throw new Error('Task delivery endpoint changed')
    }
    return task
  }
  const matches = (source, args) => source?.kind === SOURCE_KIND
    && source.taskId === args.taskId && source.exchangeId === args.exchangeId
  async function observe(sessionId, args) {
    check()
    const agent = await rt.resolveAgent(sessionId)
    check()
    const result = await rt.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    check()
    if (!Array.isArray(result?.events)) throw new Error('Task delivery history is unavailable; outcome remains unknown')
    const consumed = result.events.some(event => event.type === 'user/message' && matches(event.data?.source, args))
    const admitted = result.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data?.inserted?.some(message => matches(message.source, args)))
    const pending = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].find(message => matches(message.source, args))
    return { agent, consumed, admitted, pending }
  }
  async function acknowledge(args, sessionId) {
    await updateLedger(args, ledger => {
      const target = ledger.targets.find(target => target.sessionId === sessionId)
      target.state = 'delivered'
      ledger.state = 'delivered'
      ledger.enqueuedAt ??= Date.now()
      ledger.deliveredAt ??= Date.now()
    })
  }
  async function forwardInLane(args, message) {
    for (;;) {
      check()
      await prepare({ ...args, resent: true })
      const current = destination(taskOf(args.taskId), args)
      args = { ...args, sessionId: current, resent: true }
      await rt.ensureCapabilities(current)
      check()
      const seen = await observe(current, args)
      check()
      if (destination(taskOf(args.taskId), args) !== current) continue
      if (seen.consumed || seen.admitted || seen.pending) {
        await rt.ctx.sessions.flush(seen.agent.session)
        check()
        await acknowledge(args, current)
        return
      }
      atBoundary(args, { forwarding: true })
      seen.agent.followup(createUserMessage({ content: message.content, source: message.source }))
      await rt.ctx.sessions.flush(seen.agent.session)
      check()
      await acknowledge(args, current)
      return
    }
  }
  async function alreadyPresent(args) {
    const ledger = ledgerOf(taskOf(args.taskId), args)
    for (const target of ledger.targets) {
      const seen = await observe(target.sessionId, args)
      check()
      if (!seen.consumed && !seen.admitted && !seen.pending) continue
      await rt.ctx.sessions.flush(seen.agent.session)
      check()
      const current = destination(taskOf(args.taskId), args)
      if (seen.pending && target.sessionId !== current) {
        await forwardInLane({ ...args, resent: true }, seen.pending)
        check()
        // Save the target acknowledgement before withdrawing the durable source.
        if (seen.agent.inbox.remove(seen.pending.id)) {
          await rt.ctx.sessions.flush(seen.agent.session)
          check()
        }
      } else await acknowledge(args, target.sessionId)
      return true
    }
    return false
  }
  async function runDelivery(args, receipt, enqueue) {
    check()
    const operationId = args.exchangeId
    await prepare(args)
    if (await alreadyPresent(args)) { receipt.present = true; return args.exchangeId }
    check()
    const result = await enqueue()
    check()
    if (!receipt.skipped) {
      if (ledgerOf(taskOf(args.taskId), args)) await acknowledge(args, args.sessionId)
      if (operationId !== args.exchangeId) await acknowledge({ ...args, exchangeId: operationId }, args.sessionId)
    }
    return result
  }
  async function recordLate(id, sessionId, exchangeId, text = '') {
    const resultId = `${exchangeId}:reply`
    const task = taskOf(id)
    if (task.closedBy?.sessionId === sessionId && task.closedBy.workId === exchangeId) return
    if (!task.lateReplies.ids.includes(resultId)) {
      await commit(id, task => {
        if (task.lateReplies.ids.includes(resultId)) return task
        task.lateReplies.ids.push(resultId)
        task.lateReplies.count = task.lateReplies.ids.length
        ;(task.lateReplies.results ??= []).push({ resultId, exchangeId, sessionId, at: Date.now(), text: Array.from(text).slice(0, 4000).join('') })
        return task
      })
    }
    check()
    rt.dropWork(exchangeId)
    rt.cancelFailureResumes?.(exchangeId)
    await rt.save({ required: true })
    check()
  }
  function dependencies(id, caller) {
    const currentWork = rt.workOf(rt.live.get(caller)?.info)
    return Object.values(taskOf(id).pendingSends).some(send => send.state !== 'terminal')
      || Object.entries(rt.state.works ?? {}).some(([workId, work]) => work.taskId === id && workId !== currentWork)
      || [...rt.live.entries()].some(([sessionId, entry]) => entry.turn !== undefined && sessionId !== caller
        && (ofTurn(sessionId, entry) === id || rt.taskForSession(sessionId)?.id === id))
      || rt.taskFailureResumes?.(id)
  }
  async function settleTerminal(id, caller) {
    check()
    const running = [...rt.live].filter(([sessionId, entry]) => sessionId !== caller && entry.turn !== undefined && ofTurn(sessionId, entry) === id)
      .map(([sessionId, entry]) => ({ sessionId, turn: entry.turn, info: entry.info }))
    rt.cancelTaskFailureResumes?.(id)
    for (const [workId, work] of Object.entries(rt.state.works ?? {})) {
      if (work.taskId === id) rt.dropWork(workId)
    }
    await rt.save({ required: true })
    check()
    for (const { sessionId, turn, info } of running) {
      const agent = await rt.resolveAgent(sessionId)
      check()
      if (rt.live.get(sessionId)?.turn === turn && rt.live.get(sessionId)?.info === info) agent.cancel({ kind: 'hook', reason: 'ds-bot/task-closed' })
    }
  }
  async function concludeInLane(id, enqueue) {
    let task = taskOf(id)
    if (!task.delivery || !task.conclusion || task.state === 'open' || !rt.botOf(task.requester)) return
    if (task.delivery.state === 'delivered') return
    // A previous required save may have failed while retaining dirty state.
    await commit(id, task => task)
    task = taskOf(id)
    const args = { taskId: id, exchangeId: task.delivery.summaryId, fromId: task.requester, toId: task.requester,
      role: 'task-conclusion', text: conclusionText(task), replySessionId: task.sessions[task.requester], steer: false }
    if (Array.from(args.text).length > 1000) throw new Error('The complete task conclusion exceeds 1000 characters')
    await enqueue(args, {})
    check()
  }
  async function closeTask(sessionId, args) {
    await rt.load()
    check()
    const id = args.task ?? rt.taskForSession(sessionId)?.id
    if (!id && rt.branchOf(sessionId)) return rt.closeBranch(sessionId, args)
    const selected = taskOf(id)
    if (selected.sessions[selected.requester] !== sessionId || rt.selfOf(sessionId) !== selected.requester) {
      throw new Error('Only the root requester task Session can close this task')
    }
    const { status, conclusion, evidence, link } = args
    if (!['done', 'blocked', 'cancelled', 'failed'].includes(status) || typeof conclusion !== 'string' || !conclusion.trim()) throw new Error('Give a status and concise conclusion')
    if (status === 'done' && (typeof evidence !== 'string' || !evidence.trim())) throw new Error('Done requires non-empty evidence')
    if (link !== undefined && (typeof link !== 'string' || /[\r\n]/.test(link)
      || !/^(?:https?:\/\/\S+|[A-Za-z]:[\\/].+|\\\\.+|(?:dsh|session):\S+)$/.test(link))) throw new Error('Link must be one URL, absolute path or Session link')
    const next = { status, text: conclusion.trim(), ...(evidence?.trim() ? { evidence: evidence.trim() } : {}), ...(link ? { link } : {}) }
    if (Array.from(conclusionText({ ...selected, conclusion: next })).length > 1000) throw new Error('The complete task conclusion must be at most 1000 characters')
    return rt.withTask(id, async enqueue => {
      let task = taskOf(id)
      if (task.state === 'open') {
        if (status === 'done' && dependencies(id, sessionId)) throw new Error('Task still has open dependencies')
        await commit(id, task => {
          if (task.state !== 'open') throw new Error('This task is not open')
          if (status === 'done' && dependencies(id, sessionId)) throw new Error('Task still has open dependencies')
          task.state = status
          task.closedAt = task.updatedAt = Date.now()
          task.conclusion = next
          task.delivery = { summaryId: `${id}:closed`, targets: [], state: 'pending' }
          task.closedBy = { sessionId,
            ...(rt.live.get(sessionId)?.turn === undefined ? {} : { turn: rt.live.get(sessionId).turn }),
            ...(rt.workOf(rt.live.get(sessionId)?.info) ? { workId: rt.workOf(rt.live.get(sessionId).info) } : {}) }
          for (const send of Object.values(task.pendingSends)) send.state = 'terminal'
          return task
        })
      } else if (JSON.stringify(task.conclusion) !== JSON.stringify(next)) throw new Error('Task is already closed with its recorded conclusion')
      task = taskOf(id)
      await settleTerminal(id, sessionId)
      await concludeInLane(id, enqueue)
      return `Task ${id} closed as ${task.state}; its conclusion is recorded for the main chat.`
    })
  }
  async function recover() {
    for (const task of Array.from(rt.taskById.values())) {
      check()
      await rt.withTask(task.id, async enqueue => {
        if (taskOf(task.id).state !== 'open') {
          await settleTerminal(task.id, task.closedBy?.sessionId)
          await concludeInLane(task.id, enqueue)
          return
        }
        for (const saved of Object.values(task.sends ?? {})) {
          if (saved.delivery.state === 'delivered' || saved.args.merge) continue
          await enqueue({ ...saved.args, resent: true }, {})
          check()
        }
      })
    }
  }
  async function removeBot(botId) {
    for (const saved of Array.from(rt.taskById.values())) {
      if (saved.state !== 'open' || !saved.participants[botId]) continue
      await rt.withTask(saved.id, async enqueue => {
        await commit(saved.id, task => {
          if (task.state !== 'open') return task
          task.state = 'failed'
          task.closedAt = task.updatedAt = Date.now()
          task.conclusion = { status: 'failed', text: `Participant ${rt.botOf(botId)?.name ?? botId} was removed.` }
          task.delivery = { summaryId: `${task.id}:closed`, targets: [], state: 'pending' }
          for (const send of Object.values(task.pendingSends)) send.state = 'terminal'
          return task
        })
        await settleTerminal(saved.id)
        if (saved.requester !== botId) await concludeInLane(saved.id, enqueue)
      })
    }
  }
  Object.assign(rt, { taskOfTurn: ofTurn, taskDependencies: dependencies, recordTaskLateReply: recordLate,
    prepareTaskDelivery: prepare, checkTaskDelivery: atBoundary, runTaskDelivery: runDelivery,
    closeTask, recoverTaskLifecycle: recover, taskLifecycleCheck: check, removeTaskBot: removeBot,
    confirmTaskDeliveryTarget: async args => {
      await prepare(args)
      await updateLedger(args, ledger => { ledger.targetSessionId = args.sessionId })
    },
    forwardTaskMessage: (owner, message) => {
      const source = message.source
      const task = taskOf(source.taskId)
      const args = source.role === 'task-conclusion'
        ? { taskId: task.id, toId: task.requester, exchangeId: source.exchangeId, role: source.role }
        : task.sends?.[source.exchangeId]?.args
      if (!args) throw new Error('Forwarded task message has no durable send record')
      if (args.toId !== owner.botId) throw new Error('Forwarded task message belongs to another Bot')
      return rt.withTask(task.id, () => forwardInLane({ ...args, resent: true }, message))
    } })
}
