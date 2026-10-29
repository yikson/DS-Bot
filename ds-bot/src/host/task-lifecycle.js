import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { asyncScope } from './async.js'
import { HISTORY_TIMEOUT_MS, SOURCE_KIND } from './constants.js'

export const TASK_CONCLUSION_HEADER = '[Task closed]'
const MAX_CONCLUSION_ATTEMPTS = 5
const CONCLUSION_ATTEMPT = Symbol('task conclusion attempt')
const TIMED_OUT = Symbol('task conclusion timeout')
export const conclusionText = task => [
  TASK_CONCLUSION_HEADER, task.title, `Task: ${task.id}`, `Status: ${task.conclusion.status}`,
  `Conclusion: ${task.conclusion.text}`,
  ...(task.conclusion.evidence ? [`Evidence: ${task.conclusion.evidence}`] : []),
  ...(task.conclusion.link ? [`Link: ${task.conclusion.link}`] : []),
].join('\n')

export function install(rt) {
  const safe = asyncScope(rt)
  const conclusions = new Map()
  const check = args => {
    if (safe.stopped || rt.isStopped?.()) throw new Error('Task operation stopped; delivery remains pending')
    if (rt.readOnly()) throw new Error(rt.readOnly())
    if (args?.[CONCLUSION_ATTEMPT]?.active === false) throw new Error('Task conclusion attempt expired; delivery remains pending')
  }
  const taskOf = id => {
    check()
    const task = rt.taskOf(id)
    if (!task) throw new Error(`Unknown task "${id}"`)
    return task
  }
  const commit = async (id, update, args) => {
    check(args)
    const result = await rt.commitTask(id, task => { check(args); return update(task) })
    check(args)
    return result
  }
  async function deferConclusion(args, budget) {
    if (!budget.warned) {
      await commit(args.taskId, task => { task.delivery.state = 'pending'; return task })
      budget.warned = true
      rt.warn('ds-bot: conclusion %s remains pending until next startup: retry limit reached (%d attempts)', args.exchangeId, MAX_CONCLUSION_ATTEMPTS)
    }
    throw Object.assign(new Error('Task conclusion retry limit reached; delivery remains pending until next startup'),
      { code: 'task/conclusion-deferred' })
  }
  async function attemptConclusion(args, action, retry) {
    check()
    let budget = conclusions.get(args.exchangeId)
    if (!budget) conclusions.set(args.exchangeId, budget = { attempts: 0 })
    safe.clearTimeout(budget.timer)
    budget.timer = undefined
    if (budget.attempts >= MAX_CONCLUSION_ATTEMPTS) return deferConclusion(args, budget)
    budget.attempts += 1
    const attempt = { active: true }
    try {
      const result = await safe.race(action({ ...args, [CONCLUSION_ATTEMPT]: attempt }), HISTORY_TIMEOUT_MS, TIMED_OUT)
      check()
      if (result === TIMED_OUT) throw new Error('Task conclusion attempt timed out; delivery remains pending')
      return result
    } catch (error) {
      // A timed-out resolve/inspect may still finish; it must never save or enqueue.
      attempt.active = false
      check()
      if (budget.attempts >= MAX_CONCLUSION_ATTEMPTS) await deferConclusion(args, budget)
      else {
        // The lane action ends before this timer acquires it for the next attempt.
        budget.timer = safe.setTimeout(() => safe.run('task conclusion retry', () => retry().catch(() => {})),
          1000 * 2 ** (budget.attempts - 1))
        budget.timer?.unref?.()
      }
      throw error
    } finally { attempt.active = false }
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
  }, args)
  async function prepare(args) {
    check(args)
    const task = taskOf(args.taskId)
    if (args.role === 'task-conclusion' && (task.state === 'open'
      || task.delivery?.summaryId !== args.exchangeId || args.toId !== task.requester)) throw new Error('Invalid task conclusion')
    if (args.role !== 'task-conclusion' && task.state !== 'open'
      && !(args.deferred || args.resent)) throw new Error('This task is not open')
    const current = destination(task, args)
    if (!current) throw new Error('Task participant has no endpoint')
    if (ledgerOf(task, args)?.targets.some(target => target.sessionId === current && target.state === 'cleared')) {
      throw new Error('Task delivery cannot return to a cleared part')
    }
    const attempt = args[CONCLUSION_ATTEMPT]
    if (attempt?.target && attempt.target !== current) throw new Error('Task conclusion endpoint changed; delivery remains pending')
    if (attempt) attempt.target = current
    if (args.role !== 'task-conclusion' && !task.sends?.[args.exchangeId]) {
      if (task.state !== 'open') throw new Error('Terminal tasks cannot admit new deliveries')
      await commit(task.id, task => {
        task.sends ??= {}
        task.sends[args.exchangeId] = { args: { ...args, sessionId: current },
          delivery: { summaryId: args.exchangeId, targets: [], state: 'pending' } }
        return task
      }, args)
    }
    // A failed save retains dirty targets in memory; every attempt must persist again.
    await commit(task.id, task => {
      const ledger = ledgerOf(task, args)
      if (!ledger.targets.some(target => target.sessionId === current)) {
        ledger.targets.push({ sessionId: current, state: 'pending' })
      }
      ledger.targetSessionId = current
      if (args.role === 'task-conclusion') ledger.state = 'pending'
      if (args.role !== 'task-conclusion' && task.state === 'open' && task.participants[args.toId]?.kind === 'trunk') {
        task.sessions[args.toId] = current
      }
      return task
    }, args)
    args.sessionId = current
  }
  function atBoundary(args, { forwarding = false } = {}) {
    check(args)
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
    if (ledger.targets.some(target => target.sessionId === args.sessionId && target.state === 'cleared')) {
      throw new Error('Task delivery cannot return to a cleared part')
    }
    return task
  }
  const matches = (source, args) => source?.kind === SOURCE_KIND
    && source.taskId === args.taskId && source.exchangeId === args.exchangeId
  async function observe(sessionId, args) {
    check(args)
    const agent = await rt.resolveAgent(sessionId)
    check(args)
    const result = await rt.ctx.sessionController.inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    check(args)
    if (!Array.isArray(result?.events)) throw new Error('Task delivery history is unavailable; outcome remains unknown')
    const consumed = result.events.some(event => event.type === 'user/message' && matches(event.data?.source, args))
    const admitted = result.events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data?.inserted ?? []).filter(message => matches(message.source, args))
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
    for (let migrations = 0; migrations < MAX_CONCLUSION_ATTEMPTS; migrations += 1) {
      check(args)
      args = { ...args, resent: true }
      await prepare(args)
      const current = args.sessionId
      if (destination(taskOf(args.taskId), args) !== current) {
        if (args.role === 'task-conclusion') throw new Error('Task conclusion endpoint changed; delivery remains pending')
        continue
      }
      await rt.ensureCapabilities(current)
      check(args)
      if (await alreadyPresent(args, message)) return
      check(args)
      const agent = await rt.resolveAgent(current)
      check(args)
      if (destination(taskOf(args.taskId), args) !== current) {
        if (args.role === 'task-conclusion') throw new Error('Task conclusion endpoint changed; delivery remains pending')
        continue
      }
      atBoundary(args, { forwarding: true })
      agent.followup(createUserMessage({ content: message.content, source: message.source }))
      await rt.ctx.sessions.flush(agent.session)
      check(args)
      await acknowledge(args, current)
      return
    }
    throw new Error('Task delivery migration limit reached; delivery remains pending')
  }
  async function alreadyPresent(args, moving) {
    const ledger = ledgerOf(taskOf(args.taskId), args)
    const observations = []
    for (const target of ledger.targets.filter(target => target.state !== 'cleared')) {
      const seen = await observe(target.sessionId, args)
      check(args)
      if (args.role === 'task-conclusion' && !seen.consumed && !seen.admitted.length && !seen.pending
        && target.sessionId !== destination(taskOf(args.taskId), args)) {
        // Archived parts cannot receive another copy. Save each absence proof so a
        // deadline or restart resumes with only the targets still needing inspection.
        await updateLedger(args, ledger => {
          seen.pending = [...(seen.agent.inbox?.nextTurn ?? []), ...(seen.agent.inbox?.nextStep ?? [])]
            .find(message => matches(message.source, args))
          if (!seen.pending && target.sessionId !== destination(taskOf(args.taskId), args)) {
            ledger.targets.find(saved => saved.sessionId === target.sessionId).state = 'cleared'
          }
        })
      }
      observations.push({ ...seen, sessionId: target.sessionId })
    }
    // Old splice records survive migrations. Consumption anywhere wins over a stale
    // pending source; otherwise follow the newest recorded copy.
    const seen = observations.find(seen => seen.consumed)
      ?? observations.findLast(seen => seen.pending || seen.admitted.length)
    if (!seen) return false
    const current = destination(taskOf(args.taskId), args)
    if (!seen.consumed && seen.sessionId !== current) {
      if (moving && (seen.pending || seen.admitted.every(message => message.id === moving.id))) return false
      if (seen.pending) {
        await forwardInLane({ ...args, resent: true }, seen.pending)
        check(args)
        // Save the target acknowledgement before withdrawing the durable source.
        if (seen.agent.inbox.remove(seen.pending.id)) {
          await rt.ctx.sessions.flush(seen.agent.session)
          check(args)
        }
        return true
      }
    }
    await rt.ctx.sessions.flush(seen.agent.session)
    check(args)
    await acknowledge(args, seen.sessionId)
    return true
  }
  async function runDelivery(args, receipt, enqueue) {
    if (args.role === 'task-conclusion' && !args[CONCLUSION_ATTEMPT]) {
      return attemptConclusion(args, scoped => runDelivery(scoped, receipt, enqueue), () => rt.deliver({ ...args }, {}))
    }
    check(args)
    const operationId = args.exchangeId
    await prepare(args)
    if (await alreadyPresent(args)) { receipt.present = true; return args.exchangeId }
    check(args)
    const result = await enqueue(args)
    check(args)
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
      try {
        await rt.withTask(task.id, async enqueue => {
          if (taskOf(task.id).state !== 'open') {
            await settleTerminal(task.id, task.closedBy?.sessionId)
            await concludeInLane(task.id, enqueue)
            return
          }
          for (const saved of Object.values(task.sends ?? {})) {
            if (saved.delivery.state === 'delivered' || saved.args.merge) continue
            try {
              await enqueue({ ...saved.args, resent: true }, {})
              check()
            } catch (error) {
              check()
              rt.warn('ds-bot: recovering task %s delivery %s failed; remains pending: %s', task.id, saved.args.exchangeId, error)
            }
          }
        })
        check()
      } catch (error) {
        check()
        if (error?.code !== 'task/conclusion-deferred') rt.warn('ds-bot: recovering task %s failed; remains pending: %s', task.id, error)
      }
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
      const forwarded = { ...args, resent: true }
      return rt.withTask(task.id, () => source.role === 'task-conclusion'
        ? attemptConclusion(forwarded, scoped => forwardInLane(scoped, message), () => rt.forwardTaskMessage(owner, message))
        : forwardInLane(forwarded, message))
    } })
}
