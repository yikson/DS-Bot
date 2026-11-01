// One-off workers: a Bot hands a self-contained job to a DSH Agent Session with a
// brief, and the worker reports back once to the Session that sent it. Workers have no
// Bot identity, memory or team tools; Sir can watch or take over from the sidebar.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { asyncScope } from './async.js'
import { FAILURE_RESUME_DELAY_MS, FAILURE_RESUME_MAX, TRANSIENT_FAILURE_CODES } from './constants.js'
import { turnFailure } from './turns.js'

const STATES = ['ready', 'blocked', 'failed', 'dropped']
const FINAL = new Set(['ready', 'failed', 'dropped', 'stopped'])
const TEXT_MAX = 4000
const clip = (value, max = TEXT_MAX) => Array.from(String(value ?? '').trim()).slice(0, max).join('')
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

export const reportText = (worker, report) => [
  `worker · ${worker.title} — ${report.state}`,
  `Worker: ${worker.id} · Session: ${worker.sessionId}`,
  `Summary: ${report.summary}`,
  ...(report.evidence ? [`Evidence: ${report.evidence}`] : []),
  ...(report.question ? [`Question: ${report.question}`] : []),
].join('\n')

const briefText = (worker, botName) => [
  `[Worker brief from ${botName}]`, `Title: ${worker.title}`, '', worker.brief, '',
  `You are a one-off worker. Work in your folder and check your results yourself. When the job is done, or you need a decision, call worker_report once: state ready, blocked (with a question), failed or dropped (nothing to do), a short summary and evidence. Your report goes to ${botName}; you cannot message other Bots or start workers.`,
].join('\n')

export function install(rt) {
  const safe = asyncScope(rt)
  const { ctx } = rt

  const all = () => Object.values(rt.state.agents ?? {}).flatMap(agent => Object.values(agent.workers ?? {}))
  const workerOf = sessionId => all().find(worker => worker.sessionId === sessionId)
  const byId = id => all().find(worker => worker.id === id)
  const save = async (worker) => {
    worker.updatedAt = Date.now()
    await rt.save({ required: true })
  }
  const say = async (sessionId, text) => {
    const agent = await rt.resolveAgent(sessionId)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await ctx.sessions.flush(agent.session)
  }
  const callerBot = (exec) => {
    const botId = rt.selfOf(exec.agent?.id)
    if (botId === undefined || rt.agentOf?.(exec.agent?.id)) throw new Error('Only Bots can manage workers')
    return rt.botOf(botId)
  }
  const ownWorker = (exec, id) => {
    const bot = callerBot(exec)
    const worker = byId(String(id ?? '').trim())
    if (!worker || worker.botId !== bot.id) throw new Error(`No worker "${id}" of yours; see list_workers`)
    return { bot, worker }
  }

  // The report card goes to the dispatching Session and wakes its Bot there.
  async function deliverReport(worker) {
    if (worker.delivered !== false || !worker.report || !rt.botOf(worker.botId)) return
    await rt.deliver({ toId: worker.botId, sessionId: worker.dispatcherSessionId, role: 'worker-report',
      exchangeId: `worker:${worker.id}:${worker.reports ?? 0}`, text: reportText(worker, worker.report), steer: false })
    worker.delivered = true
    await save(worker)
  }
  async function record(worker, report) {
    worker.report = report
    worker.reports = (worker.reports ?? 0) + 1
    worker.delivered = false
    if (report.state !== 'waiting') worker.state = report.state === 'blocked' ? 'blocked' : report.state
    await save(worker)
    await deliverReport(worker).catch(error => rt.warn('ds-bot: worker %s report not delivered yet: %s', worker.id, error))
  }

  const workerReport = defineTool({
    name: 'worker_report',
    description: 'Report the outcome of your worker job to the Bot that started it. Call it once when you are done (ready), have nothing to do (dropped), failed, or need a decision (blocked, with a question).',
    parameters: {
      state: { type: 'string', required: true, enum: STATES },
      summary: { type: 'string', required: true, description: 'What you did and found, in a few sentences.' },
      evidence: { type: 'string', description: 'Paths, commits, test results or links that show it.' },
      question: { type: 'string', description: 'With state blocked: the one decision you need.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const worker = workerOf(exec.agent?.id)
      if (!worker) throw new Error('worker_report works only in a worker Session')
      if (FINAL.has(worker.state)) throw new Error(`This worker already ended (${worker.state})`)
      if (!STATES.includes(args.state) || !clip(args.summary)) throw new Error('Give a state and a summary')
      if (args.state === 'blocked' && !clip(args.question)) throw new Error('A blocked report needs the question you need answered')
      turns.get(worker.sessionId)?.add('reported')
      await record(worker, { state: args.state, summary: clip(args.summary),
        ...(clip(args.evidence) ? { evidence: clip(args.evidence) } : {}), ...(clip(args.question) ? { question: clip(args.question) } : {}) })
      return `Reported ${args.state} to ${rt.botOf(worker.botId)?.name ?? 'the Bot'}.${FINAL.has(worker.state) ? ' Your job is over; end your turn.' : ' Wait for its answer.'}`
    },
  })
  const registered = new WeakSet()
  const offerReport = (agent) => {
    if (!agent || registered.has(agent) || !workerOf(agent.session?.id) || typeof agent.ctx?.tools?.register !== 'function') return
    registered.add(agent)
    agent.ctx.tools.register(workerReport)
  }
  safe.on('agent/created', ({ agent }) => {
    safe.run('workers background job', () => rt.load().then(() => offerReport(agent)))
  })

  ctx.tools.register(defineTool({
    name: 'start_worker',
    description: 'Start a one-off worker for a self-contained job: a fresh DSH Session with your brief, in its own folder. It reports back here once with worker_report; you do not wait for it. The user can watch it in the sidebar under DSH Agent.',
    parameters: {
      title: { type: 'string', required: true, description: 'A short name for the job.' },
      brief: { type: 'string', required: true, description: 'Everything the worker needs: goal, context, limits, how to check the result.' },
      workdir: { type: 'string', description: 'Full folder path to work in; your own working folder when left out.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      const title = clip(args.title, 80)
      const brief = clip(args.brief, 20000)
      if (!title || !brief) throw new Error('Give a title and a brief')
      const dir = args.workdir === undefined ? rt.workDirOf({ botId: bot.id }) : await rt.cleanWorkDir(args.workdir)
      if (args.workdir !== undefined && !dir) throw new Error(`No folder at ${args.workdir}`)
      const host = rt.ensureAgent()
      const sessionId = await rt.createAgentSession(host.id, undefined, {
        ...(dir ? { cwd: dir } : {}), ...(rt.config.workerPreset ? { agentPreset: rt.config.workerPreset } : {}) })
      const worker = { id: randomUUID().slice(0, 8), sessionId, dispatcherSessionId: exec.agent.id, botId: bot.id,
        title, brief, state: 'running', ...(dir ? { workdir: dir } : {}), createdAt: Date.now(), updatedAt: Date.now() }
      ;(host.workers ??= {})[worker.id] = worker
      await save(worker)
      const agent = await rt.resolveAgent(sessionId)
      offerReport(agent)
      await ctx.sessionTitle.rename(agent.session, `worker · ${title}`)
      await rt.applyPermission(bot, sessionId)
      await say(sessionId, briefText(worker, bot.name))
      return `Worker ${worker.id} started (Session ${sessionId}). Its report will arrive here as a new message; do not wait for it.`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'list_workers',
    description: 'List the workers you started, with their state and latest report.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      const mine = all().filter(worker => worker.botId === bot.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
      if (mine.length === 0) return 'No workers.'
      return mine.map(worker => `- ${worker.id} — ${worker.title} (${worker.state}; Session ${worker.sessionId})${worker.report ? `\n  ${worker.report.summary.slice(0, 200)}` : ''}`).join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'message_worker',
    description: 'Send a worker more input or the answer to its question; it reads it at its next step.',
    parameters: {
      worker: { type: 'string', required: true, description: 'Worker id from start_worker or list_workers.' },
      message: { type: 'string', required: true },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const { bot, worker } = ownWorker(exec, args.worker)
      if (FINAL.has(worker.state)) throw new Error(`Worker ${worker.id} has ended (${worker.state}); start a new one`)
      if (!clip(args.message)) throw new Error('Write a message')
      worker.state = 'running'
      await save(worker)
      await say(worker.sessionId, `[Message from ${bot.name}]\n${clip(args.message, 20000)}`)
      return `Sent to worker ${worker.id}.`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'stop_worker',
    description: 'Stop a worker: cancels what it is doing and ends the job.',
    parameters: { worker: { type: 'string', required: true } },
    output,
    async execute(args, exec) {
      await rt.load()
      const { worker } = ownWorker(exec, args.worker)
      if (FINAL.has(worker.state)) return `Worker ${worker.id} already ended (${worker.state}).`
      worker.state = 'stopped'
      await save(worker)
      forgetRetry(worker.sessionId)
      const agent = await rt.resolveAgent(worker.sessionId)
      if (agent.status !== 'idle') agent.cancel({ kind: 'hook', reason: 'ds-bot/worker-stopped' })
      return `Worker ${worker.id} stopped.`
    },
  }))

  // A turn that ends without a report sends what the worker said last, so the
  // dispatcher is never left waiting; a transient model failure is retried first.
  const turns = new Map()
  const lastWords = new Map()
  const retries = new Map()
  const forgetRetry = (sessionId) => {
    safe.clearTimeout(retries.get(sessionId)?.timer)
    retries.delete(sessionId)
  }
  safe.on('session/event', (session, event) => {
    const worker = session?.id && workerOf(session.id)
    if (!worker) return
    if (event.type === 'turn/start') turns.set(worker.sessionId, new Set())
    if (event.type === 'assistant/message') {
      const said = (event.data?.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n').trim()
      if (said) lastWords.set(worker.sessionId, said)
    }
    if (event.type !== 'turn/end') return
    const reported = turns.get(worker.sessionId)?.has('reported')
    turns.delete(worker.sessionId)
    if (reported || FINAL.has(worker.state)) return
    const reason = event.data?.reason
    if (reason?.kind === 'interrupted' || reason?.reason?.kind === 'disposed') return
    const failure = reason?.kind === 'error' ? turnFailure(reason.error) : undefined
    const retry = retries.get(worker.sessionId) ?? { attempts: 0 }
    if (failure && TRANSIENT_FAILURE_CODES.has(failure.code) && retry.attempts < FAILURE_RESUME_MAX) {
      retry.attempts += 1
      retry.timer = safe.setTimeout(() => safe.run('workers background job', () => say(worker.sessionId,
        `[Your last turn stopped because the model connection failed (${failure.code}). Check what is already done before you repeat anything, then go on.]`)),
      FAILURE_RESUME_DELAY_MS * 2 ** (retry.attempts - 1))
      retry.timer?.unref?.()
      retries.set(worker.sessionId, retry)
      return
    }
    forgetRetry(worker.sessionId)
    const words = lastWords.get(worker.sessionId)
    safe.run('workers background job', () => record(worker, failure
      ? { state: 'failed', summary: `Its model call failed (${failure.code}${failure.message ? `: ${failure.message.slice(0, 200)}` : ''}).` }
      : { state: 'waiting', summary: words ? `Ended its turn without a report. Last words: ${clip(words, 1500)}` : 'Ended its turn without a report.' }))
  })

  // After a restart: deliver reports that did not arrive, and tell running workers
  // to check their state before they go on.
  safe.effect(() => {
    safe.run('workers background job', () => rt.load().then(async () => {
      for (const worker of all()) {
        if (!rt.botOf(worker.botId)) continue
        await deliverReport(worker).catch(error => rt.warn('ds-bot: worker %s report not delivered yet: %s', worker.id, error))
        if (worker.state === 'running') {
          await say(worker.sessionId, '[DeepSeek Harness restarted. Check your folder, git history and anything outside before you repeat an action, then finish the job and call worker_report.]')
            .catch(error => rt.warn('ds-bot: worker %s recovery note not sent: %s', worker.id, error))
        }
      }
    }))
    return () => { for (const sessionId of retries.keys()) forgetRetry(sessionId) }
  }, 'ds-bot: workers')

  Object.assign(rt, { workerOf })
}
