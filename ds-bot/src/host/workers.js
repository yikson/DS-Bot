import { createHash, randomUUID } from 'node:crypto'
import { appendFile, readFile, realpath, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { asyncScope } from './async.js'
import { HISTORY_TIMEOUT_MS, TEAM_TOOLS } from './constants.js'
import { within } from './folders.js'
import { splitRef, textOf } from './text.js'
import { hasWorkers, unsettled, workerClaims } from './worker-data.js'

const POLICY = Symbol.for('ds-bot/native-worker-policy')
const TOOL = Symbol.for('ds-bot/native-worker-tool')
const isWorkerMarker = event => event.type === 'session/title' && event.data.source?.kind === 'user'
  && /^worker:[^:]+:[^:]+$/.test(event.data.title)
const POLL_MS = 1000
const STOP_REASONS = new Set(['ds-bot/worker-stop', 'ds-bot/stale-worker-admission'])
const ALLOWED = new Set(['read', 'read_image', 'write', 'edit', 'bash', 'pwsh',
  'grep', 'glob', 'working_directory', 'run_code'])
const CONTEXT = new Set(['runtime-context', 'agent-instructions', 'skill-catalog',
  'time-context', 'compact-checkpoint'])
const rank = mode => ['read-only', 'workspace-write', 'danger-full-access'].indexOf(mode)
const minMode = (a, b) => rank(a) < rank(b) ? a : b
const points = (text, limit) => Array.from(text).slice(0, limit).join('')
const pendingInput = agent => [...agent.inbox.nextTurn, ...agent.inbox.nextStep]

// Raw splices are the authority, including failures before a user/message is appended.
export function workerEvidence(events, run) {
  const queues = { 'next-turn': [], 'next-step': [] }
  const found = {}
  let turn
  let matching = false
  let lastText = ''
  let outsideInput = false
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const queue = queues[splice.target]
      if (!queue || splice.start < 0 || splice.start > queue.length
        || (splice.removedCount ?? 0) > queue.length - splice.start) throw new Error('Worker inbox history is ambiguous')
      const removed = queue.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      for (const message of splice.inserted) {
        if (message.source?.rpcId === run.promptRequestId) {
          if (found.messageId && found.messageId !== message.id) throw new Error('Worker admission has multiple messages')
          found.messageId = message.id
          found.insertedSeq = event.seq
        } else if (found.messageId && !CONTEXT.has(message.source?.kind)) outsideInput = true
      }
      if (found.messageId && removed.some(message => message.id === found.messageId)) {
        if (splice.outcome === 'canceled') found.droppedSeq = event.seq
        else {
          if (turn === undefined || (found.turn !== undefined && found.turn !== turn)) throw new Error('Worker claim has no unique turn')
          found.turn = turn
          found.claimSeq = event.seq
          matching = true
        }
      }
    }
    if (matching && event.type === 'request/header') found.requestHeaderSeq = event.seq
    if (matching && event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) lastText = text
    }
    if (found.messageId && event.type === 'user/message'
      && !CONTEXT.has(event.data?.source?.kind) && event.data?.source?.rpcId !== run.promptRequestId) outsideInput = true
    if (event.type === 'turn/end') {
      if (matching && event.data.turn === found.turn) {
        found.endSeq = event.seq
        found.finish = event.data.reason
        found.text = lastText || '(no final text)'
        matching = false
      }
      turn = undefined
    }
  }
  return { ...found, outsideInput }
}

export function workerResult(worker, run, finish, text = '(no final text)', outsideInput = false) {
  const header = [
    `[Worker result] ${points(worker.title, 80)}`,
    `Task: ${worker.taskId}; worker: ${worker.id}; run: ${run.id}`,
    `Finish: ${points(JSON.stringify(finish), 1000)}`,
    `Session: session:${worker.sessionId}`,
    ...(outsideInput ? ['worker received outside input'] : []),
    ...(finish.kind === 'interrupted' || finish.reason === 'plugin-reload' ? ['may have partially run; not re-run'] : []),
    ...(finish.kind === 'unknown' ? ['unknown outcome; not rerun'] : []),
  ].join('\n') + '\n'
  return header + points(text, Math.max(0, 4000 - Array.from(header).length))
}

export function install(rt) {
  const safe = asyncScope(rt)
  const { ctx } = rt
  const agents = ctx.get?.('agents')
  const host = `${process.pid}:${performance.timeOrigin}`
  const generation = randomUUID()
  const identities = new Map()
  const createdSessions = new Set()
  const creationPath = join(rt.home, 'workers.created.jsonl')
  let creationRead
  const admissions = new Map()
  const creations = new Set()
  const active = new Map()
  const polls = new Map()
  const tools = new Map()
  const policies = new Set()
  const settling = new Set()
  const cleanupAttempts = new Map()
  const checked = new WeakMap()
  let activated = false
  let api
  const check = args => {
    safe.signal.throwIfAborted()
    rt.taskLifecycleCheck(args)
  }
  const claim = sessionId => {
    const rows = workerClaims(rt.state).get(sessionId)
    if (!rows) return
    if (rows.length !== 1 || !rt.taskOf(rows[0].taskId)) throw new Error('Worker ownership is unresolved')
    return rows[0]
  }
  let ownershipFailed = false
  let ownershipIndexed = false
  const positivelyOwned = id => id !== undefined && (rt.selfOf(id) !== undefined
    || rt.botOf(id) !== undefined || rt.roomOf(id) !== undefined || rt.agentOf?.(id) !== undefined)
  const unknownOwnership = id => id !== undefined && (!ownershipIndexed || ownershipFailed
    || rt.stateReadError?.() !== undefined) && !positivelyOwned(id)
  const ownershipDenial = id => unknownOwnership(id)
    && (identities.get(id) !== false || createdSessions.has(id))
    ? 'Worker ownership is unavailable; native activation and all tools are denied' : undefined
  async function readCreations() {
    creationRead ??= readFile(creationPath, 'utf8').then(text => {
      for (const line of text.split('\n').filter(Boolean)) {
        const record = JSON.parse(line)
        if (record.version !== 1 || typeof record.sessionId !== 'string') throw new Error('Invalid worker creation record')
        createdSessions.add(record.sessionId)
      }
    }).catch(error => {
      creationRead = undefined
      if (error.code !== 'ENOENT') throw error
    })
    await creationRead
    safe.signal.throwIfAborted()
  }
  async function recordCreation(worker) {
    await readCreations()
    if (createdSessions.has(worker.sessionId)) return
    await appendFile(creationPath, JSON.stringify({ version: 1, sessionId: worker.sessionId,
      taskId: worker.taskId, workerId: worker.id, marker: worker.marker }) + '\n', { flush: true })
    createdSessions.add(worker.sessionId)
    check()
  }
  async function identify(agent) {
    if (identities.has(agent.id)) return identities.get(agent.id)
    let ledgerError
    try { await readCreations() } catch (error) { ledgerError = error }
    try {
      const raw = await ctx.sessionController.inspect(agent.id, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
      safe.signal.throwIfAborted()
      if (!Array.isArray(raw?.events)) throw new Error('Worker identity history is unavailable')
      const marked = raw.events.some(isWorkerMarker)
      const owned = marked || createdSessions.has(agent.id)
      identities.set(agent.id, owned)
      return owned
    } catch {
      safe.signal.throwIfAborted()
      if (createdSessions.has(agent.id)) { identities.set(agent.id, true); return true }
      // A readable creation ledger excludes user-created Sessions even if history is unavailable.
      if (!ledgerError) { identities.set(agent.id, false); return false }
      throw new Error('Worker identity is unavailable')
    }
  }
  function markSession(agent, worker) {
    // This log-only event survives rename/compaction; the current title is never an identity.
    agent.session.append('session/title', { title: worker.marker, messageSeqs: [],
      source: { kind: 'user' } })
    identities.set(agent.id, true)
  }
  const current = id => {
    check()
    const rows = [...workerClaims(rt.state).values()].flat().filter(row => row.workerId === id)
    if (rows.length !== 1 || !rt.taskOf(rows[0].taskId)) throw new Error('Worker ownership is unresolved')
    return rows[0].worker
  }
  const commit = (id, update, args) => {
    const worker = current(id)
    return rt.withTask(worker.taskId, () => rt.commitTask(worker.taskId, task => {
      check(args)
      update(task.workers[id], task)
      return task
    }))
  }
  const eligible = sessionId => {
    check()
    if (rt.config.nativeWorkers !== true) throw new Error('Native workers are disabled')
    const task = rt.taskForSession(sessionId)
    const owner = rt.taskOwners.get(sessionId)?.botId
    if (!task || task.state !== 'open' || task.phase !== 'ready' || !owner
      || task.sessions[owner] !== sessionId || task.participants[owner].kind === 'trunk'
      || !rt.botOf(owner) || !rt.taskCapabilities().has(owner)) throw new Error('Workers require an eligible task-owned Session')
    return { task, owner }
  }
  const limits = () => {
    for (const name of ['maxWorkersPerTask', 'maxWorkerFollowups']) {
      const value = rt.config[name] ?? 2
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`)
    }
    return rt.config.maxWorkersPerTask ?? 2
  }
  async function services(mode) {
    if (!agents?.create || !ctx.get('agentPresets')?.resolve || !ctx.get('sandboxPolicy')?.resolve
      || !ctx.get('approval')?.overrideOf || !ctx.get('workingDirectory')?.set || !ctx.tools.guard) {
      throw new Error(mode === 'verify' ? 'Worker verification requires supported read-only sandbox control'
        : 'Native workers require supported creation, sandbox and approval services')
    }
    api ??= Promise.all([import('@deepseek-ai/dsh-sandbox-policy'), import('@deepseek-ai/dsh-user-approval')])
      .then(([sandbox, approval]) => ({ setSandboxMode: sandbox.setSandboxMode, setApprovalPolicy: approval.setApprovalPolicy }))
    try {
      const setters = await api
      if (typeof setters.setSandboxMode !== 'function' || typeof setters.setApprovalPolicy !== 'function') throw new Error('Unsupported native permission setters')
      return setters
    } catch (error) {
      throw new Error(mode === 'verify' ? 'Worker verification requires supported read-only sandbox control'
        : 'Native workers require supported sandbox and approval control', { cause: error })
    }
  }
  async function directory(root, canonicalRoot, base, path) {
    if (!isAbsolute(root) || await realpath(root) !== canonicalRoot) throw new Error('Worker sandbox root changed')
    const target = await realpath(resolve(base, path))
    if (!(await stat(target)).isDirectory() || !within(target, canonicalRoot)) throw new Error('Worker directory must stay inside its requester sandbox root')
    await rt.workFolder(target)
    check()
    return target
  }
  async function requester(worker) {
    const task = rt.taskOf(worker.taskId)
    if (!task || task.sessions[worker.requestedBy] !== worker.requesterSessionId
      || task.participants[worker.requestedBy]?.kind === 'trunk') throw new Error('Worker requester endpoint changed')
    const agent = await rt.resolveAgent(worker.requesterSessionId)
    check()
    const policy = ctx.get('sandboxPolicy').resolve({ session: agent.session })
    if (rank(policy.mode) < 0 || agent.session.header.cwd !== worker.sandboxRoot
      || await realpath(policy.workspaceRoot) !== worker.canonicalRoot) throw new Error('Worker requester sandbox is unresolved')
    return { agent, policy }
  }
  async function permission(agent, worker) {
    const setters = await services(worker.mode)
    check()
    const { policy } = await requester(worker)
    check()
    const selected = minMode(worker.sandbox, policy.mode)
    if (selected !== worker.sandbox) {
      await commit(worker.id, saved => { saved.sandbox = selected })
      check()
      agent.cancel({ kind: 'hook', reason: 'ds-bot/worker-permission-tightened' }, { keepInbox: true })
      worker = current(worker.id)
    }
    const ownPolicy = ctx.get('sandboxPolicy').resolve({ session: agent.session })
    if (ownPolicy.mode !== selected) setters.setSandboxMode(agent.session, selected)
    if (ctx.get('approval').overrideOf(agent.session) !== 'never') setters.setApprovalPolicy(agent.session, 'never')
    const actual = ctx.get('sandboxPolicy').resolve({ session: agent.session })
    if (actual.mode !== selected || agent.session.header.cwd !== worker.sandboxRoot
      || await realpath(actual.workspaceRoot) !== worker.canonicalRoot
      || ctx.get('approval').overrideOf(agent.session) !== 'never') throw new Error(worker.mode === 'verify'
      ? 'Worker verification requires supported read-only sandbox control' : 'Worker permission readback failed')
    await directory(worker.sandboxRoot, worker.canonicalRoot, rt.sessionFolder(agent.session), '.')
    check()
    await ctx.sessions.flush(agent.session)
    check()
    return worker
  }
  const permitted = name => ALLOWED.has(name) && !TEAM_TOOLS.includes(name)
  function denial(exec) {
    const unavailable = ownershipDenial(exec.agent?.id)
    if (unavailable) return unavailable
    const slot = exec.agent?.[POLICY]
    let row
    try { row = claim(exec.agent?.id) } catch { return 'Worker ownership is unresolved' }
    if (!row && !slot && exec.agent?.id !== undefined
      && !positivelyOwned(exec.agent.id) && !identities.has(exec.agent.id)) return 'Worker identity has not been checked'
    if (!row && !slot && !identities.get(exec.agent?.id) && !createdSessions.has(exec.agent?.id)) return
    if (!row) return 'Worker ownership reservation is missing'
    if (!slot || slot.owner !== safe || safe.stopped || !slot.ready) return 'Worker policy is not ready'
    const worker = row.worker
    if (!permitted(exec.name)) return `Native workers cannot execute ${exec.name}`
    if (worker.admissionsClosed || rt.taskOf(worker.taskId)?.state !== 'open'
      || current(worker.id).cleanup.state !== 'none') return 'Worker admissions are closed'
    try {
      const request = agents.get(worker.requesterSessionId)
      const policy = ctx.get('sandboxPolicy')
      if (!request || rank(worker.sandbox) > rank(policy.resolve({ session: request.session }).mode)
        || policy.resolve({ session: exec.agent.session }).mode !== worker.sandbox
        || ctx.get('approval').overrideOf(exec.agent.session) !== 'never'
        || realpathSync(worker.sandboxRoot) !== worker.canonicalRoot) return 'Worker permission reconciliation required'
    } catch { return 'Worker policy lookup failed' }
    if (checked.get(exec) !== worker.sandbox) return 'Worker execution policy was not checked'
  }
  function barrier(agent) {
    let slot = agent[POLICY]
    if (!slot) {
      slot = agent[POLICY] = { owner: safe, ready: false }
      // Agent scope outlives a plugin-only replacement; the old closure stays deny-all.
      agent.ctx.tools.guard(exec => slot.ready && !slot.owner.stopped
        ? slot.deny(exec) : 'Worker policy transition is closed')
      agent.ctx.on('agent/pre-step', (payload, next) => slot.ready && !slot.owner.stopped
        ? slot.admit(payload, next) : { kind: 'reject' })
    }
    if (slot.owner !== safe) slot.ready = false
    slot.owner = safe
    slot.deny = denial
    slot.admit = async (_payload, next) => {
      try {
        await rt.refresh()
        check()
        const row = claim(agent.id)
        if (ownershipDenial(agent.id) || !row || row.worker.admissionsClosed
          || rt.taskOf(row.taskId)?.state !== 'open') return { kind: 'reject' }
        await permission(agent, row.worker)
        check()
        return slot.ready ? next() : { kind: 'reject' }
      } catch { return { kind: 'reject' } }
    }
    policies.add(slot)
    return slot
  }
  async function configure(agent, { fresh = false } = {}) {
    const slot = barrier(agent)
    slot.ready = false
    try {
      const row = claim(agent.id)
      if (!row) throw new Error('Worker has no durable reservation')
      if (ownershipDenial(agent.id)) throw new Error(ownershipDenial(agent.id))
      let worker = row.worker
      if (worker.admissionsClosed) throw new Error(`Worker ${worker.admissionBlockReason ?? 'admissions-closed'}: native activation is permanently closed`)
      if (!fresh && worker.createdHost !== host && !agent.session.snapshotEvents().some(event => event.type === 'request/header')) {
        await commit(worker.id, saved => {
          saved.admissionsClosed = true
          saved.admissionBlockReason = 'restart-before-first-header'
        })
        throw new Error('Worker restart-before-first-header: native activation is permanently closed')
      }
      if (!identities.get(agent.id)) {
        await recordCreation(worker)
        markSession(agent, worker)
      }
      await permission(agent, worker)
      check()
      worker = current(worker.id)
      const inherited = ctx.tools.schemas().map(schema => schema.name).filter(name => !permitted(name))
      if (inherited.length) agent.ctx.tools.restrict({ deny: inherited })
      check()
      slot.ready = true
    } catch (error) {
      rt.warn('ds-bot: worker policy refused %s: %s', agent.id, error.message)
      throw error
    }
  }
  async function route(args, bot, requesterAgent) {
    const selected = args.model ?? (args.mode === 'verify' ? rt.config.verifierModel ?? rt.config.workerModel : rt.config.workerModel)
    const configEffort = args.model === undefined && typeof selected === 'object' ? selected?.effort : undefined
    const fallback = requesterAgent.session.requestHeader()?.config
    const ref = await rt.resolveModel(selected === undefined
      ? (fallback?.provider && fallback?.model ? `${fallback.provider}/${fallback.model}` : await rt.desiredModel(bot))
      : typeof selected === 'string' ? selected : `${selected.provider}/${selected.model}`)
    const explicit = args.effort ?? configEffort
    const reasoningEffort = explicit !== undefined ? await rt.resolveEffort(ref, explicit) : await rt.desiredEffort(bot, ref)
    check()
    return { ...splitRef(ref), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }
  async function runWorker(args, exec) {
    const attempt = { active: true, signal: AbortSignal.any([safe.signal, AbortSignal.timeout(HISTORY_TIMEOUT_MS),
      ...(exec.signal ? [exec.signal] : [])]) }
    const timeout = Symbol('worker admission timeout')
    const operation = startWorker(args, exec, attempt)
    try {
      const result = await safe.race(operation, HISTORY_TIMEOUT_MS, timeout)
      if (result !== timeout) return result
      attempt.active = false
      if (attempt.workerId) safe.run('worker admission deadline', async () => {
        await commit(attempt.workerId, saved => {
          saved.admissionsClosed = true
          saved.admissionBlockReason = 'admission-deadline'
        })
        await stop(attempt.workerId)
      })
      throw new Error('Worker admission deadline exceeded; its reserved outcome remains under reconciliation')
    } finally { attempt.active = false }
  }
  async function startWorker(args, exec, attempt) {
    await rt.load()
    const sessionId = exec.agent?.id
    const admissionEligible = () => {
      attempt.signal.throwIfAborted()
      if (!attempt.active) throw new Error('Worker admission attempt expired')
      return eligible(sessionId)
    }
    let { task, owner } = admissionEligible()
    if (typeof args.prompt !== 'string' || !args.prompt.trim() || !exec.callId) throw new Error('Give a self-contained prompt and a tool invocation identity')
    const mode = args.mode ?? 'execute'
    if (!['execute', 'verify'].includes(mode) || (args.permission !== undefined
      && !['read-only', 'workspace-write'].includes(args.permission))) throw new Error('Invalid worker mode or permission')
    if (args.workdir !== undefined && (typeof args.workdir !== 'string' || !isAbsolute(args.workdir))) throw new Error('Worker workdir must be absolute')
    const admissionKey = JSON.stringify([sessionId, exec.callId])
    const digest = createHash('sha256').update(args.prompt).digest('hex')
    const replay = Object.values(task.workers ?? {}).find(worker => Object.values(worker.runs).some(run => run.admissionKey === admissionKey))
    if (replay) {
      if (replay.runs[replay.id].promptDigest !== digest) throw new Error('Worker admission replay changed its prompt')
      return `started worker ${replay.id}`
    }
    const setters = await services(mode)
    admissionEligible()
    const policy = ctx.get('sandboxPolicy').resolve({ session: exec.agent.session })
    if (rank(policy.mode) < 0) throw new Error('Unknown requester sandbox')
    const maximum = mode === 'verify' ? 'read-only' : minMode(policy.mode, 'workspace-write')
    if (args.permission && rank(args.permission) > rank(maximum)) throw new Error('Worker permission exceeds requester or verification ceiling')
    const sandbox = args.permission ?? maximum
    const sandboxRoot = exec.agent.session.header.cwd
    if (typeof sandboxRoot !== 'string' || !isAbsolute(sandboxRoot)) throw new Error('Worker requires a requester header cwd')
    const canonicalRoot = await realpath(sandboxRoot)
    if (await realpath(policy.workspaceRoot) !== canonicalRoot) throw new Error('Requester sandbox root differs from its header')
    const initialWorkdir = await directory(sandboxRoot, canonicalRoot, rt.sessionFolder(exec.agent.session), args.workdir ?? '.')
    admissionEligible()
    const initialModel = await route({ ...args, mode }, rt.botOf(owner), exec.agent)
    admissionEligible()
    const preset = await ctx.get('agentPresets').resolve()
    admissionEligible()
    if (!preset?.id || preset.broken) throw new Error('Worker default preset is unavailable')
    const id = randomUUID()
    const worker = {
      id, kind: 'native-worker', taskId: task.id, requestedBy: owner, requesterSessionId: sessionId,
      sessionId: randomUUID(), marker: `worker:${task.id}:${id}`, title: points((args.title ?? args.prompt.split(/\r?\n/).find(line => line.trim()) ?? '').trim(), 80),
      mode, sandboxRoot, canonicalRoot, initialWorkdir, sandbox, approval: 'never', initialModel,
      followupCount: 0, currentRunId: id, admissionsClosed: false, admissionBlockReason: null,
      createdHost: host, createdGeneration: generation, openedAt: Date.now(),
      runs: { [id]: { id, ordinal: 0, state: 'pending', admissionKey, promptRequestId: id,
        promptDigest: digest, admission: { state: 'reserved' } } },
      cleanup: { state: 'none', cancelRequestedAt: null, confirmedIdleAt: null }, archivedAt: null,
    }
    await rt.withTask(task.id, () => rt.commitTask(task.id, saved => {
      const now = admissionEligible()
      const existing = Object.values(saved.workers ?? {}).find(worker => worker.runs[worker.id].admissionKey === admissionKey)
      if (existing) throw new Error(`Worker admission already reserved as ${existing.id}`)
      if (now.task.id !== saved.id || Object.keys(saved.workers ?? {}).length >= limits()) throw new Error('Worker lifetime limit reached')
      saved.workers ??= {}
      saved.workers[id] = worker
      return saved
    }))
    attempt.workerId = id
    let agent
    const admissionCheck = () => {
      admissionEligible()
      if (current(id).admissionsClosed) throw new Error('Worker admission is closed')
    }
    try {
      admissionCheck()
      await recordCreation(worker)
      admissionCheck()
      creations.add(id)
      let handle
      try { handle = await agents.create({
        sessionId: worker.sessionId, signal: attempt.signal, agentOptions: initialModel,
        meta: { cwd: sandboxRoot, agentPreset: preset.id },
        setup: async (scope, created) => {
          barrier(created)
          markSession(created, worker)
          await ctx.get('agentPresets').mount(scope, preset.id)
          admissionCheck()
          setters.setSandboxMode(created.session, sandbox)
          setters.setApprovalPolicy(created.session, 'never')
          await ctx.get('workingDirectory').set(created, initialWorkdir)
          admissionCheck()
          // Publication is the final synchronous ownership/eligibility boundary.
          return { commit() {
            admissionCheck()
            if (claim(created.id)?.workerId !== id) throw new Error('Worker reservation changed before publication')
          } }
        },
      }) } finally { creations.delete(id) }
      agent = handle.agent
      admissionCheck()
      await configure(agent, { fresh: true })
      admissionCheck()
      await ctx.sessions.flush(agent.session)
      admissionCheck()
      await commit(id, saved => {
        admissionCheck()
        saved.runs[id].admission.state = 'intent'
      })
      admissionCheck()
      check()
      exec.signal?.throwIfAborted()
      const signal = attempt.signal
      signal.throwIfAborted()
      const pending = ctx.sessionController.prompt({
        sessionId: worker.sessionId, requestId: id, mode: 'queue', content: [{ type: 'text', text: args.prompt }],
      }, signal)
      admissions.set(id, pending)
      try {
        const result = await pending
        if (safe.stopped || !attempt.active || current(id).admissionsClosed || rt.taskOf(task.id)?.state !== 'open') {
          admissions.delete(id)
          if (safe.stopped) agent.cancel({ kind: 'hook', reason: 'ds-bot/stale-worker-admission' })
          else await stop(id)
          throw new Error('Worker admission was stopped')
        }
        admissionEligible()
        if (!result?.accepted || result.error) throw new Error('Worker prompt was not accepted')
      } finally { if (admissions.get(id) === pending) admissions.delete(id) }
      await reconcile(id).catch(error => {
        check()
        rt.warn('ds-bot: worker %s was accepted; result reconciliation remains pending: %s', id, error.message)
      })
      return `started worker ${id}`
    } catch (error) {
      if (agent && safe.stopped) agent.cancel({ kind: 'hook', reason: 'ds-bot/stale-worker-admission' })
      if (!safe.stopped) {
        const saved = current(id)
        if (admissions.has(id) || saved.runs[id].admission.state === 'intent') {
          await stop(id)
          await reconcile(id)
        } else {
          await finish(id, { kind: 'setup-error', message: points(error.message, 500) })
          await reconcile(id)
        }
      }
      throw error
    }
  }
  async function history(worker, args) {
    const live = agents.get(worker.sessionId)
    if (live) await ctx.sessions.flush(live.session)
    check(args)
    const result = await ctx.sessionController.inspect(worker.sessionId, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
    check(args)
    if (!Array.isArray(result?.events)) throw new Error('Worker raw history is unavailable')
    return result.events
  }
  async function finish(id, reason, evidence = {}, args) {
    check(args)
    await commit(id, (worker, task) => {
      const run = worker.runs[worker.currentRunId]
      if (evidence.quiescentAt !== undefined) worker.cleanup = {
        ...worker.cleanup, state: 'settled', confirmedIdleAt: evidence.quiescentAt,
      }
      if (!unsettled(run)) return
      let finish = reason ?? evidence.finish
      if (finish.kind === 'aborted' && finish.reason?.kind === 'disposed') {
        finish = { kind: 'unknown', reason: 'plugin-reload', cause: finish }
      }
      if (finish.kind === 'unknown' && finish.reason === 'plugin-reload') {
        worker.admissionsClosed = true
        worker.admissionBlockReason = 'plugin-reload'
      }
      const ownStop = ((finish.kind === 'aborted' && finish.reason?.kind === 'hook'
        && STOP_REASONS.has(finish.reason.reason)) || finish.kind === 'blocked')
        && worker.cleanup.cancelRunId === run.id
        && evidence.endSeq > worker.cleanup.cancelAfterSeq
      if (ownStop) {
        // A native abort proves the turn ended, not that late admissions or input drained.
        if (evidence.quiescentAt === undefined) return
        finish = { kind: 'cancelled', reason: finish }
      }
      run.state = finish.kind === 'interrupted' || finish.kind === 'unknown' ? 'unknown'
        : finish.kind === 'completed' ? 'completed' : finish.kind === 'cancelled' ? 'cancelled' : 'failed'
      for (const key of ['messageId', 'insertedSeq', 'turn', 'claimSeq', 'requestHeaderSeq', 'endSeq', 'droppedSeq']) {
        if (evidence[key] !== undefined) run[key] = evidence[key]
      }
      run.admission = { ...run.admission, state: 'settled',
        ...(evidence.messageId ? { messageId: evidence.messageId, insertedSeq: evidence.insertedSeq } : {}) }
      run.outsideInput = evidence.outsideInput ?? false
      run.finish = finish
      run.result = { id: `${run.id}:result`, text: workerResult(worker, run, finish, evidence.text, evidence.outsideInput) }
      if (task.state === 'open') {
        const deliveryArgs = resultArgs(worker, run)
        task.sends ??= {}
        task.sends[run.result.id] ??= { args: deliveryArgs,
          delivery: { summaryId: run.result.id, targets: [], state: 'pending' } }
      } else late(task, worker, run)
    }, args)
  }
  const resultArgs = (worker, run) => ({
    kind: 'worker-result', role: 'worker-result', taskId: worker.taskId, workerId: worker.id,
    runId: run.id, resultId: run.result.id, exchangeId: run.result.id, requesterSessionId: worker.requesterSessionId,
    toId: worker.requestedBy, sessionId: worker.requesterSessionId, text: run.result.text,
  })
  function late(task, worker, run) {
    if (!run.result || task.lateReplies.ids.includes(run.result.id)) return
    task.lateReplies.ids.push(run.result.id)
    task.lateReplies.count = task.lateReplies.ids.length
    ;(task.lateReplies.results ??= []).push({ resultId: run.result.id, exchangeId: run.id,
      sessionId: worker.sessionId, at: Date.now(), text: run.result.text })
  }
  function poll(id) {
    if (safe.stopped || polls.has(id)) return
    const worker = current(id)
    if (!unsettled(worker.runs[worker.currentRunId])) return
    const timer = safe.setTimeout(() => {
      polls.delete(id)
      safe.run('worker periodic evidence', () => reconcile(id))
    }, POLL_MS)
    timer?.unref?.()
    polls.set(id, timer)
  }
  async function reconcile(id, { restart = false, reload = false } = {}) {
    const existing = active.get(id)
    if (existing) {
      existing.dirty = true
      existing.restart ||= restart
      existing.reload ||= reload
      return existing.promise
    }
    const flight = { dirty: true, restart, reload }
    const once = async () => {
      let worker = current(id)
      const run = worker.runs[worker.currentRunId]
      const args = { taskId: worker.taskId, exchangeId: `${run.id}:result`, role: 'worker-result', resultId: `${run.id}:result` }
      if (!unsettled(run) && (rt.taskOf(worker.taskId).state !== 'open'
        || rt.taskOf(worker.taskId).sends?.[run.result.id]?.delivery.state === 'delivered')) return
      return rt.attemptTaskResult(args, async scoped => {
        if (unsettled(current(id).runs[run.id])) {
          const events = await history(worker, scoped)
          const evidence = workerEvidence(events, run)
          check(scoped)
          const live = agents.get(worker.sessionId)
          const header = events.some(event => event.type === 'request/header')
          if (flight.restart && !header) await commit(id, saved => {
            saved.admissionsClosed = true
            saved.admissionBlockReason = 'restart-before-first-header'
          }, scoped)
          if (evidence.finish) await finish(id, undefined, evidence, scoped)
          else if (flight.reload && !live) await finish(id, { kind: 'unknown', reason: 'plugin-reload' }, evidence, scoped)
          else if (flight.restart && live?.status !== 'running') await finish(id, { kind: 'unknown', reason: header ? 'host-restart' : 'restart-before-first-header' }, evidence, scoped)
          else if (evidence.droppedSeq !== undefined && !admissions.has(id) && live?.status === 'idle') {
            await finish(id, { kind: 'failed', reason: 'input-dropped-before-claim' }, evidence, scoped)
          } else if (evidence.messageId) await commit(id, saved => {
            const run = saved.runs[saved.currentRunId]
            if (!unsettled(run)) return
            run.admission = { state: 'settled', messageId: evidence.messageId, insertedSeq: evidence.insertedSeq }
            Object.assign(run, { messageId: evidence.messageId, insertedSeq: evidence.insertedSeq,
              ...(evidence.turn === undefined ? {} : { turn: evidence.turn, claimSeq: evidence.claimSeq }) })
            if (evidence.turn !== undefined && run.state !== 'cancelling') run.state = 'running'
          }, scoped)
        }
        worker = current(id)
        const saved = worker.runs[worker.currentRunId]
        if (saved.result) await rt.deliverWorkerResult(resultArgs(worker, saved), scoped)
      }, () => reconcile(id, { restart: flight.restart, reload: flight.reload }))
    }
    safe.clearTimeout(polls.get(id))
    polls.delete(id)
    flight.promise = Promise.resolve().then(async () => {
      do {
        flight.dirty = false
        await once()
        check()
      } while (flight.dirty)
    })
    active.set(id, flight)
    let succeeded = false
    try { await flight.promise; succeeded = true } finally {
      if (active.get(id) === flight) active.delete(id)
      // Failed attempts retain the existing delivery retry budget/backoff.
      if (succeeded && !safe.stopped) poll(id)
    }
  }
  async function stop(id) {
    let worker = current(id)
    await commit(id, saved => {
      saved.admissionsClosed = true
      saved.cleanup.state = 'cancelling'
      saved.cleanup.cancelRequestedAt ??= Date.now()
      const run = saved.runs[saved.currentRunId]
      saved.cleanup.cancelRunId ??= run.id
      saved.cleanup.cancelAfterSeq ??= (agents.get(saved.sessionId)?.session.seq ?? 0) - 1
      if (unsettled(run)) run.state = 'cancelling'
    })
    let stopActive = true
    const stopCheck = () => {
      check()
      if (!stopActive) throw new Error('Worker stop attempt expired')
    }
    const attempt = (async () => {
      let agent = agents.get(worker.sessionId)
      agent?.cancel({ kind: 'hook', reason: 'ds-bot/worker-stop' }, { keepInbox: true })
      await admissions.get(id)?.catch(() => {})
      stopCheck()
      agent = agents.get(worker.sessionId)
      agent?.cancel({ kind: 'hook', reason: 'ds-bot/worker-stop' }, { keepInbox: true })
      await agent?.whenIdle()
      stopCheck()
      if (agent && agent.status !== 'idle') throw new Error('Worker is not idle')
      if (agent) {
        agent.inbox.clear()
        await ctx.sessions.flush(agent.session)
        stopCheck()
        if (agent.status !== 'idle' || pendingInput(agent).length || admissions.has(id)) throw new Error('Worker input is not drained')
      }
      if (creations.has(id)) throw new Error('Worker creation has not drained')
      return agent
    })()
    const timeout = Symbol('stop timeout')
    const agent = await safe.race(attempt, HISTORY_TIMEOUT_MS, timeout)
    check()
    if (agent === timeout) {
      stopActive = false
      rt.warn('ds-bot: worker %s still cancelling; stop evidence timed out', id)
      return false
    }
    const events = await history(worker)
    const run = current(id).runs[worker.currentRunId]
    const evidence = workerEvidence(events, run)
    await finish(id, evidence.finish ?? { kind: 'cancelled' }, { ...evidence, quiescentAt: Date.now() })
    if (rt.taskOf(worker.taskId)?.state === 'open') await reconcile(id)
    return true
  }
  async function settleTaskWorkers(taskId) {
    const workers = Object.values(rt.taskOf(taskId)?.workers ?? {})
    let incomplete = false
    for (const worker of workers) {
      try {
        if (worker.cleanup.state !== 'settled' && !(await stop(worker.id))) { incomplete = true; continue }
        for (const run of Object.values(current(worker.id).runs)) {
          if (!run.result || current(worker.id).cleanup.resultWithdrawals?.[run.result.id]) continue
          let copy
          if (rt.taskOf(taskId).sends?.[run.result.id]?.delivery.targets.length) {
            const receiver = await rt.resolveAgent(worker.requesterSessionId)
            check()
            copy = pendingInput(receiver).find(message => message.source?.kind === 'worker-result'
              && message.source.resultId === run.result.id && message.source.workerId === worker.id)
            if (rt.taskOf(taskId).state === 'open') throw new Error('Worker cleanup requires terminal task')
            if (copy) receiver.inbox.remove(copy.id)
            await ctx.sessions.flush(receiver.session)
            check()
          }
          await commit(worker.id, saved => {
            saved.cleanup.resultWithdrawals ??= {}
            saved.cleanup.resultWithdrawals[run.result.id] = { at: Date.now(), pendingMessageId: copy?.id ?? null }
          })
        }
        await commit(worker.id, (saved, task) => {
          if (task.state === 'open') throw new Error('Worker archive requires terminal task')
          for (const run of Object.values(saved.runs)) late(task, saved, run)
        })
        const saved = current(worker.id)
        const agent = agents.get(saved.sessionId)
        if (!saved.archivedAt && !admissions.has(saved.id) && (!agent || (agent.status === 'idle' && !pendingInput(agent).length))) {
          await ctx.workspaceRegistry.archiveSession(saved.sessionId)
          check()
          await commit(saved.id, worker => { worker.archivedAt = Date.now() })
        }
      } catch (error) {
        check()
        incomplete = true
        rt.warn('ds-bot: worker %s terminal cleanup remains pending: %s', worker.id, error.message)
      }
    }
    if (incomplete) {
      const attempts = (cleanupAttempts.get(taskId) ?? 0) + 1
      cleanupAttempts.set(taskId, attempts)
      if (attempts < 5) safe.setTimeout(() => rt.scheduleWorkerSettlement(taskId), 1000 * 2 ** (attempts - 1))?.unref?.()
      else rt.warn('ds-bot: task %s worker cleanup retry budget exhausted; recovery remains pending', taskId)
    }
  }
  async function recover() {
    for (const row of [...workerClaims(rt.state).values()].flat()) {
      const worker = row.worker
      try {
        check()
        const live = agents.get(worker.sessionId)
        if (live) await configure(live)
        await reconcile(worker.id, { restart: worker.createdHost !== host && !live,
          reload: worker.createdHost === host && worker.createdGeneration !== generation && !live })
        if (current(worker.id).cleanup.state === 'cancelling') await stop(worker.id)
        if (rt.taskOf(row.taskId)?.state !== 'open') await settleTaskWorkers(row.taskId)
      } catch (error) {
        check()
        rt.warn('ds-bot: worker %s recovery remains pending: %s', row.workerId, error.message)
        // A refused headerless native resume still needs its unknown result.
        if (current(worker.id).admissionBlockReason === 'restart-before-first-header') await reconcile(worker.id, { restart: true })
      }
    }
  }
  function registerTool(agent) {
    let allowed = !safe.stopped && rt.config.nativeWorkers === true && !!rt.taskForSession(agent.id)
    if (allowed) try { eligible(agent.id) } catch { allowed = false }
    const previous = agent[TOOL]
    if (!allowed) {
      if (previous?.owner === safe) { previous.dispose(); delete agent[TOOL]; tools.delete(agent) }
      return
    }
    if (previous?.owner === safe) return
    previous?.dispose()
    const dispose = agent.ctx.tools.register(defineTool({
      name: 'run_worker', description: 'Start one self-contained native worker asynchronously. Its result returns to this exact task Session. Verify is read-only. Inspect evidence before follow-up.',
      parameters: {
        prompt: { type: 'string', required: true }, title: { type: 'string' },
        mode: { type: 'string', enum: ['execute', 'verify'] }, workdir: { type: 'string' },
        model: { type: 'string' }, effort: { type: 'string' },
        permission: { type: 'string', enum: ['read-only', 'workspace-write'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: runWorker,
    }))
    tools.set(agent, dispose)
    const slot = agent[TOOL] = { owner: safe, dispose }
    safe.effect(() => () => {
      dispose()
      if (agent[TOOL] === slot) delete agent[TOOL]
      if (tools.get(agent) === dispose) tools.delete(agent)
    }, 'ds-bot: worker tool', agent.ctx)
  }
  function activate() {
    if (activated || (rt.config.nativeWorkers !== true && !hasWorkers(rt.state) && rt.stateReadError?.() === undefined)) return
    activated = true
    ctx.tools.guard(denial)
    safe.on('tools/pre-execute', async (exec, next) => {
      try {
        await rt.refresh()
        ownershipFailed = false
      } catch { ownershipFailed = true }
      if (exec.agent && !positivelyOwned(exec.agent.id)) {
        try { await identify(exec.agent) } catch (error) { return { kind: 'deny', reason: error.message } }
      }
      const unavailable = ownershipDenial(exec.agent?.id)
      if (unavailable) return { kind: 'deny', reason: unavailable }
      let row
      try { row = claim(exec.agent?.id) } catch (error) { return { kind: 'deny', reason: error.message } }
      if (!row && !exec.agent?.[POLICY] && !identities.get(exec.agent?.id)) return next()
      if (!row || !permitted(exec.name)) return { kind: 'deny', reason: `Native workers cannot execute ${exec.name}` }
      try {
        const worker = await permission(exec.agent, row.worker)
        check()
        checked.set(exec, worker.sandbox)
        const reason = denial(exec)
        return reason ? { kind: 'deny', reason } : next()
      } catch (error) { return { kind: 'deny', reason: `Worker policy refused: ${error.message}` } }
    })
    safe.on('agent/created', async ({ agent }) => {
      await rt.load()
      if (claim(agent.id)) await configure(agent)
      else if (await identify(agent)) {
        barrier(agent)
        throw new Error('Worker ownership is unavailable; native activation and all tools are denied')
      }
      else registerTool(agent)
    })
    safe.on('session/event', (session, event) => {
      if (event.type === 'sandbox/mode' || event.type === 'approval/policy') {
        const affected = [...workerClaims(rt.state).values()].flat()
          .filter(row => row.worker.requesterSessionId === session.id || row.worker.sessionId === session.id)
        for (const row of affected) {
          const agent = agents.get(row.worker.sessionId)
          if (!agent || !agent[POLICY]?.ready) continue
          agent[POLICY].ready = false
          safe.setImmediate(() => safe.run('worker permission change', () => configure(agent)))
        }
      }
      if (!claim(session.id)) return
      if (['agent/inbox/spliced', 'turn/end', 'request/header'].includes(event.type)) {
        const id = claim(session.id).workerId
        safe.setImmediate(() => safe.run('worker evidence', () => reconcile(id)))
      }
    })
    safe.on('agent/inbox/claimed', ({ agent }) => {
      const row = claim(agent.id)
      if (row) safe.setImmediate(() => safe.run('worker claim', () => reconcile(row.workerId)))
    })
    safe.on('agent/status', ({ agent, status }) => {
      const row = status === 'idle' && claim(agent.id)
      if (row) safe.setImmediate(() => safe.run('worker idle evidence', () => reconcile(row.workerId)))
    })
    safe.effect(() => () => { for (const slot of policies) if (slot.owner === safe) slot.ready = false }, 'ds-bot: worker HMR barrier')
    safe.effect(() => () => {
      for (const [agent, dispose] of tools) {
        dispose()
        if (agent[TOOL]?.owner === safe) delete agent[TOOL]
      }
      tools.clear()
    }, 'ds-bot: worker tool takeover')
    for (const agent of agents?.list?.() ?? []) {
      if (claim(agent.id)) {
        barrier(agent)
        safe.setImmediate(() => safe.run('worker policy takeover', () => configure(agent).then(() => reconcile(claim(agent.id).workerId))))
      } else {
        safe.setImmediate(() => safe.run('worker identity takeover', async () => {
          if (await identify(agent)) barrier(agent)
          else registerTool(agent)
        }))
      }
    }
  }
  Object.assign(rt, {
    workerClaim: claim, runWorker, registerWorkerTool: registerTool, indexWorkers: () => {
      ownershipIndexed = rt.stateReadError?.() === undefined
      activate()
      if (activated) for (const agent of agents?.list?.() ?? []) registerTool(agent)
    },
    recoverWorkers: recover, settleTaskWorkers, stopNativeWorker: stop,
    scheduleWorkerSettlement: taskId => {
      if (!Object.keys(rt.taskOf(taskId)?.workers ?? {}).length || settling.has(taskId)) return
      settling.add(taskId)
      safe.setImmediate(() => safe.run('terminal worker settlement', async () => {
        try { await settleTaskWorkers(taskId) } finally { settling.delete(taskId) }
      }))
    },
    workerDependencies: task => Object.values(task.workers ?? {}).some(worker => admissions.has(worker.id) || creations.has(worker.id)
      || worker.cleanup.state === 'cancelling' || Object.values(worker.runs).some(run =>
        unsettled(run) || (run.result && task.sends?.[run.result.id]?.delivery.state !== 'delivered'))),
    reconcileWorkerPermissions: async botId => {
      for (const row of [...workerClaims(rt.state).values()].flat().filter(row => row.worker.requestedBy === botId)) {
        const agent = agents.get(row.worker.sessionId)
        if (agent) await permission(agent, row.worker)
      }
    },
    checkWorkerDirectory: async (exec, cd) => {
      const worker = claim(exec.agent.id)?.worker
      if (!worker) throw new Error('Worker directory ownership is unresolved')
      await directory(worker.sandboxRoot, worker.canonicalRoot, rt.sessionFolder(exec.agent.session), cd)
      check()
    },
    assertNonWorkerSession: async sessionId => {
      if (!hasWorkers(rt.state)) return
      const seen = new Set()
      for (let id = sessionId; id;) {
        if (seen.has(id)) throw new Error('Session fork provenance is ambiguous')
        seen.add(id)
        if (workerClaims(rt.state).has(id)) throw new Error('Worker Sessions and their forks cannot be adopted')
        const result = await ctx.sessionController.inspect(id, AbortSignal.timeout(HISTORY_TIMEOUT_MS))
        check()
        if (!result?.meta) throw new Error('Session fork provenance is unavailable')
        id = result.meta.parentSession
      }
    },
  })
  activate()
}
