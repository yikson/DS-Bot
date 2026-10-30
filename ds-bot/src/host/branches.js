import { asyncScope } from './async.js'
import { randomUUID } from 'node:crypto'
import { BRANCH_SUMMARY_HEADER, HISTORY_TIMEOUT_MS, TEXT_KEPT } from './constants.js'
import { splitRef } from './text.js'

// Includes messages durably queued but not yet consumed by an agent turn.
export const sourcesIn = events => events.flatMap(event => event.type === 'user/message'
  ? [event.data?.source] : event.type === 'agent/inbox/spliced'
    ? (event.data?.inserted ?? []).map(message => message.source) : []).filter(Boolean)

export function replyTarget(rt, source) {
  return rt.roomOf(source.senderRoomId)?.sessions?.[source.senderSessionId]
    ?? rt.branchForWork?.(source.exchangeId)?.sessionId
    ?? source.replySessionId ?? rt.chatOf?.(source.senderSessionId)
}

export function deliverySession(rt, args) {
  return args.sessionId ?? rt.branchForWork?.(args.replyTo)?.sessionId ?? rt.chatOf(args.toId)
}

export function install(rt) {
  const safe = asyncScope(rt)
  const { ctx, state, config } = rt
  const closing = new Map()
  const creating = new Set()
  const answerRetries = new Map()
  let stopped = false
  safe.effect(() => () => {
    stopped = true
    for (const retry of answerRetries.values()) safe.clearTimeout(retry.timer)
    answerRetries.clear()
  }, 'ds-bot: branch answer retries')
  const serial = (key, action) => {
    const job = (closing.get(key) ?? Promise.resolve()).catch(() => {}).then(action)
    closing.set(key, job)
    return job.finally(() => { if (closing.get(key) === job) closing.delete(key) })
  }
  const branchOf = sessionId => {
    const owner = rt.branchOwners.get(sessionId)
    return owner && rt.botOf(owner.botId)?.workBranches?.[owner.branchId]
  }
  const branchForWork = id => {
    const owner = rt.branchByWork.get(id)
    return owner && rt.botOf(owner.botId)?.workBranches?.[owner.branchId]
  }
  const relatedBranch = (sessionId, targetId) => {
    const info = rt.live.get(sessionId)?.info
    const branch = branchOf(info?.replySessionId) ?? branchForWork(info?.replyTo)
    return branch && rt.selfOf(branch.sessionId) === targetId
      && branch.targetBotId === rt.selfOf(sessionId) ? branch : undefined
  }
  const warned = new Set()
  const pairOwner = (sender, target) => {
    for (const pair of config.workBranches ?? []) {
      const bots = Array.isArray(pair) && pair.length === 2
        ? pair.map(name => Object.values(state.bots).filter(bot => bot.name === name)) : []
      if (bots.length !== 2 || bots.some(matches => matches.length !== 1) || bots[0][0] === bots[1][0]) {
        const key = JSON.stringify(pair)
        if (!warned.has(key)) { warned.add(key); rt.warn('ds-bot: invalid work branch pair %s', key) }
        continue
      }
      const [owner, peer] = bots.map(matches => matches[0])
      if ((sender.id === owner.id && target.id === peer.id) || (target.id === owner.id && sender.id === peer.id)) return owner
    }
  }

  const openBranches = (owner, peerId) => Object.values(owner.workBranches ?? {})
    .filter(branch => branch.state === 'open' && branch.targetBotId === peerId)
  const workBranchChoices = senderId => {
    const sender = rt.botOf(senderId)
    if (!sender) return []
    return Object.values(state.bots).flatMap(other => {
      const owner = pairOwner(sender, other)
      if (!owner) return []
      const peer = owner.id === senderId ? other : sender
      return openBranches(owner, peer.id).map(branch => `${other.name}: ${branch.id} — ${branch.title}`)
    })
  }

  async function createBranch(bot, peer, text, id) {
    if (typeof ctx.sessionController.fork !== 'function') throw new Error('Work branches require sessionController.fork; this DSH cannot enable them.')
    const branch = { id, trunkSessionId: rt.chatOf(bot.id), targetBotId: peer.id,
      title: Array.from(text.split('\n')[0]).slice(0, 80).join(''), brief: Array.from(text).slice(0, TEXT_KEPT).join(''),
      workIds: [], state: 'creating', openedAt: Date.now() }
    ;(bot.workBranches ??= {})[id] = branch
    creating.add(id)
    try {
      await rt.save({ required: true })
      const result = await ctx.sessionController.fork({ sessionId: branch.trunkSessionId, allowMigration: false })
      if (!result.sessionId) throw new Error(result.error?.message ?? 'Fork did not return a Session')
      branch.sessionId = result.sessionId
      rt.indexSessions()
      // Persist the child identity before any later setup can fail.
      await rt.save({ required: true })
      const agent = await rt.resolveAgent(branch.sessionId)
      const count = agent.session.inheritedEventCount
      if (!Number.isInteger(count) || count < 0) throw new Error('Fork did not expose its inherited event boundary')
      branch.inheritedThrough = count - 1
      await ctx.sessionTitle.rename(agent.session, `${bot.name} · ${branch.title}`)
      await rt.applyPermission(bot, branch.sessionId)
      const ref = await rt.desiredModel(bot)
      const selection = ref ? { ...splitRef(ref), reasoningEffort: await rt.desiredEffort(bot, ref) }
        : (await rt.resolveAgent(branch.trunkSessionId)).session.requestHeader()?.config
      if (!selection?.provider || !selection?.model) throw new Error('Cannot determine the Bot model for the fork')
      const selected = await rt.selectSessionModel(branch.sessionId, selection)
      if (selected?.error) throw new Error(selected.error.message ?? 'Cannot select the Bot model for the fork')
      await rt.ensureCapabilities(branch.sessionId)
      await rt.save({ required: true })
      return branch
    } catch (error) {
      branch.state = 'failed'
      await rt.save({ required: true })
      throw error
    } finally {
      creating.delete(id)
    }
  }

  // Called inside request admission: replaying a receipt never forks again.
  async function routeBranch(sender, target, sessionId, text, toUser, work) {
    if (toUser) return {}
    const own = branchOf(sessionId)
    if (own) {
      if (own.state !== 'open') throw new Error('This work branch is not open')
      return { branch: own, replySessionId: sessionId }
    }
    const related = relatedBranch(sessionId, target.id)
    if (related) {
      if (related.state !== 'open') throw new Error('This work branch is not open')
      return { branch: related, sessionId: related.sessionId }
    }
    if (work === undefined) return {}
    if (work !== 'new') {
      const saved = Object.values(state.bots).flatMap(bot => Object.values(bot.workBranches ?? {})
        .map(branch => ({ bot, branch }))).find(({ bot, branch }) => branch.id === work
          && ((bot.id === sender.id && branch.targetBotId === target.id) || (bot.id === target.id && branch.targetBotId === sender.id)))
      if (saved) {
        if (saved.branch.state !== 'open') throw new Error('This work branch is not open')
        return saved.bot.id === sender.id ? { branch: saved.branch, replySessionId: saved.branch.sessionId }
          : { branch: saved.branch, sessionId: saved.branch.sessionId }
      }
    }
    const owner = pairOwner(sender, target)
    if (!owner || sessionId !== rt.chatOf(sender.id)) throw new Error('No configured legacy work branch pair for this call')
    if (work !== 'new') {
      const branches = openBranches(owner, owner.id === sender.id ? target.id : sender.id)
      if (branches.length === 0) throw new Error(`No open work branch "${work}" with this Bot; leave work out or use "new"`)
      throw new Error(`Specify message_bot work as one of these open branches (or "new"):\n${branches.map(branch => `${branch.id} — ${branch.title}`).join('\n')}`)
    }
    const id = randomUUID()
    const branch = await createBranch(owner, owner.id === sender.id ? target : sender, text, id)
    return owner.id === sender.id ? { branch, exchangeId: id, replySessionId: branch.sessionId }
      : { branch, exchangeId: id, sessionId: branch.sessionId }
  }

  async function delivered(sessionId, exchangeId, replyTo, failureResumes) {
    const agent = await rt.resolveAgent(sessionId)
    const pending = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])].map(message => message.source)
    const events = await ctx.sessionController.inspect(sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    if (!Array.isArray(events?.events)) throw new Error('Cannot inspect delivery history')
    return [...pending, ...sourcesIn(events.events)].some(source => source &&
      (failureResumes === undefined || source.failureResumes === failureResumes) &&
      (source.exchangeId === exchangeId || (replyTo !== undefined && source.replyTo === replyTo)))
  }

  async function sendBranchTask(branch, args, receipt) {
    return serial(`dispatch:${branch.id}`, async () => {
      if (branch.pendingDelivery) throw new Error('A branch delivery is still pending; resolve it before sending more work')
      branch.pendingDelivery = args
      branch.state = 'open'
      await rt.save({ required: true })
      await rt.deliver(args, receipt)
      delete branch.pendingDelivery
      await rt.save({ required: true })
    })
  }

  async function answerFailed(workId, error) {
    const pending = state.works?.[workId]?.pendingAnswer
    if (pending) {
      pending.failed = true
      await rt.save({ required: true }).catch(saveError => rt.warn('ds-bot: saving failed reply %s failed: %s', workId, saveError))
      const retry = answerRetries.get(workId) ?? { attempts: 0 }
      if (!stopped && !retry.timer && retry.attempts < 3) {
        const delay = 1000 * 2 ** retry.attempts++
        retry.timer = safe.setTimeout(() => {
          retry.timer = undefined
          return resumeBranchAnswer(workId).catch(retryError => rt.warn('ds-bot: retrying reply %s failed: %s', workId, retryError))
        }, delay)
        retry.timer?.unref?.()
        answerRetries.set(workId, retry)
      }
    }
    throw error
  }

  function clearAnswerRetry(workId) {
    safe.clearTimeout(answerRetries.get(workId)?.timer)
    answerRetries.delete(workId)
  }

  async function sendAnswer(id, source, text, long) {
    return serial(`reply:${source.exchangeId}`, async () => {
      const work = state.works?.[source.exchangeId]
      const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
      const args = work?.pendingAnswer?.args ?? {
        fromId: rt.selfOf(id), toId: source.senderSessionId, sessionId: replyTarget(rt, source),
        exchangeId: `${source.exchangeId}:reply`, role: 'reply', replyTo: source.exchangeId,
        text: long?.text ?? text, ...(long?.length === undefined ? {} : { files: long.files, length: long.length }),
        ...(work?.parent ? { work: work.parent } : {}),
        ...(branchOf(id) ? { replySessionId: id } : {}),
      }
      // Existing non-branch callers keep their normal delivery path; branch replies
      // require durable inspection because a crash can leave the inbox ahead of state.
      const branch = branchOf(id) ?? branchOf(args.sessionId)
      if (work) {
        work.pendingAnswer ??= { args, name, text }
        await rt.save({ required: true })
      }
      if (!branch || !await delivered(args.sessionId, args.exchangeId, args.replyTo)) await rt.deliver(args)
      else await ctx.sessions.flush((await rt.resolveAgent(args.sessionId)).session)
      rt.closeWork?.(source.exchangeId, work?.pendingAnswer?.name ?? name, work?.pendingAnswer?.text ?? text)
      await rt.save({ required: true })
      clearAnswerRetry(source.exchangeId)
    }).catch(error => answerFailed(source.exchangeId, error))
  }

  const resumeBranchTask = branch => serial(`dispatch:${branch.id}`, async () => {
    const args = branch.pendingDelivery
    if (!args) return
    if (!await delivered(deliverySession(rt, args), args.exchangeId)) await rt.deliver({ ...args, resent: true })
    delete branch.pendingDelivery
    await rt.save({ required: true })
  })

  const resumeBranchAnswer = workId => serial(`reply:${workId}`, async () => {
    const pending = state.works?.[workId]?.pendingAnswer
    if (!pending) return
    if (pending.args.taskId) return rt.resumeTaskAnswer(workId)
    const { args, name, text } = pending
    if (!await delivered(args.sessionId, args.exchangeId, workId)) await rt.deliver({ ...args, resent: true })
    else await ctx.sessions.flush((await rt.resolveAgent(args.sessionId)).session)
    rt.closeWork(workId, name, text)
    await rt.save({ required: true })
    clearAnswerRetry(workId)
  }).catch(error => answerFailed(workId, error))

  async function sendSummary(bot, branch) {
    if (branch.summaryDelivered) return
    const current = rt.chatOf(bot.id)
    const sessions = [...new Set([current, branch.trunkSessionId])]
    const checked = await Promise.allSettled(sessions.map(sessionId => delivered(sessionId, branch.summaryId)))
    if (!checked.some(result => result.status === 'fulfilled' && result.value)) {
      const failed = checked.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      await rt.deliver({ fromId: bot.id, toId: bot.id, sessionId: current,
        replySessionId: branch.sessionId, role: 'branch-summary', exchangeId: branch.summaryId, text: branch.conclusion.text })
    }
    branch.summaryDelivered = true
    await rt.save({ required: true })
  }

  async function closeBranch(sessionId, { status, conclusion, link }) {
    const branch = branchOf(sessionId)
    if (!branch) throw new Error('Only a work branch can close itself')
    return serial(`close:${branch.id}`, async () => {
      if (!['done', 'blocked', 'cancelled'].includes(status) || typeof conclusion !== 'string' || !conclusion.trim()) throw new Error('Give a status and concise conclusion')
      if (link !== undefined && (typeof link !== 'string' || /[\r\n]/.test(link) || !/^(?:https?:\/\/\S+|[A-Za-z]:[\\/].+|\\\\.+|(?:dsh|session):\S+)$/.test(link))) throw new Error('Link must be one URL, absolute path or Session link')
      const text = `[Work branch closed] ${branch.title}\nBranch: ${branch.id}\nStatus: ${status}\nConclusion: ${conclusion.trim()}\nLink: ${link || 'none'}`
      if (Array.from(`${BRANCH_SUMMARY_HEADER}\n${text}`).length > 1000) throw new Error('The complete conclusion must be at most 1000 characters')
      if (branch.state === 'closed' && !branch.summaryDelivered) throw new Error('Closed legacy branch delivery requires inspection; it is not replayed')
      if (branch.state !== 'closed') {
        if (branch.state !== 'open') throw new Error('This work branch is not open')
        branch.state = 'closed'
        branch.closedAt = Date.now()
        branch.conclusion = { status, text, ...(link ? { link } : {}) }
        branch.summaryId = `${branch.id}:closed`
        branch.summaryDelivered = false
        await rt.save({ required: true })
      }
      await sendSummary(rt.botOf(rt.selfOf(sessionId)), branch)
      return 'Work branch closed; its conclusion is in the main chat.'
    })
  }

  Object.assign(rt, { branchOf, branchForWork, relatedBranch, workBranchChoices, workBranchPair: pairOwner, routeBranch, sendBranchTask, sendAnswer, closeBranch,
    creatingBranches: creating, resumeBranchTask, resumeBranchAnswer,
    branchDelivered: delivered, sendBranchSummary: (bot, branch) => serial(`close:${branch.id}`, () => sendSummary(bot, branch)),
    replyTarget: source => replyTarget(rt, source), deliverySession: args => deliverySession(rt, args) })
}
