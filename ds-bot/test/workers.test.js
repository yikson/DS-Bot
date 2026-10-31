import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import fsp from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { createRuntime, inject } from '../index.js'
import { validateTask } from '../src/host/tasks.js'
import { hasWorkers, validateWorkerUpdate, workerClaims } from '../src/host/worker-data.js'
import { workerEvidence, workerResult } from '../src/host/workers.js'
import { historyEntry } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

// The checkout bundle exposes persistence, not all of its transitive format libraries.
const { sessionFormatCatalog } = createRequire(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))('@deepseek-ai/dsh-session-format-catalog')

const task = () => ({
  id: 'task', mode: 'v2', title: 'Worker test', brief: 'Run isolated work.',
  requester: 'a', assignee: 'b', state: 'open', phase: 'ready',
  capabilityAtCreation: { requester: true, initialAssignee: true },
  sessions: { a: 'ta', b: 'tb' },
  participants: { a: { role: 'requester', kind: 'fresh' }, b: { role: 'assignee', kind: 'fresh' } },
  openedAt: 1, updatedAt: 1, closedAt: null, conclusion: null, creationIntents: {}, pendingSends: {},
  lateReplies: { count: 0, ids: [] },
})
const seed = () => ({ version: 1, bots: {
  a: { id: 'a', name: 'PM', model: 'mock/model', role: 'PM', createdAt: 1, capabilities: [] },
  b: { id: 'b', name: 'Dev', model: 'mock/model', role: 'Dev', createdAt: 1, capabilities: [] },
}, rooms: {}, agents: {}, tasks: { task: task() }, mainBotIds: ['a'], workspaceId: 'unit-workspace' })
const worker = () => ({
  id: 'w', kind: 'native-worker', taskId: 'task', requestedBy: 'a', requesterSessionId: 'ta',
  sessionId: 'ws', marker: 'worker:task:w', title: 'Check', mode: 'execute',
  sandboxRoot: '/project', canonicalRoot: '/project', initialWorkdir: '/project', sandbox: 'workspace-write',
  approval: 'never', initialModel: { provider: 'mock', model: 'model' }, followupCount: 0, currentRunId: 'w',
  admissionsClosed: false, runs: { w: { id: 'w', ordinal: 0, state: 'pending', admissionKey: 'ta:call',
    promptRequestId: 'w', promptDigest: 'hash', admission: { state: 'reserved' } } },
  cleanup: { state: 'none' }, archivedAt: null,
})
const event = (seq, type, data) => ({ seq, type, data, time: seq })
const inserted = (seq = 0, id = 'm') => event(seq, 'agent/inbox/spliced', {
  target: 'next-turn', start: 0, inserted: [{ id, source: { kind: 'user', rpcId: 'w' }, content: [] }],
})
const claimed = (seq = 2, outcome) => event(seq, 'agent/inbox/spliced', {
  target: 'next-turn', start: 0, removedCount: 1, inserted: [], ...(outcome ? { outcome } : {}),
})

test('optional workers preserve absent/empty history and structural validation ignores current roster/limits', () => {
  assert.equal(hasWorkers({ tasks: { task: task() } }), false)
  const value = task()
  value.workers = {}
  assert.equal(hasWorkers({ tasks: { task: value } }), false)
  value.workers.w = worker()
  assert.equal(hasWorkers({ tasks: { task: value } }), true)
  assert.equal(validateTask(value, 'task'), value)
  value.workers.w.requestedBy = 'gone'
  assert.throws(() => validateTask(value, 'task'), /requester/)
})

test('malformed worker reservations retain a security claim; duplicate claims never become ordinary Sessions', () => {
  const state = { tasks: { task: { workers: { w: { sessionId: 'reserved' } } },
    other: { workers: { broken: { sessionId: 'reserved' } } } } }
  assert.equal(workerClaims(state).get('reserved').length, 2)
})

test('worker tombstones, permissions, settled outcomes and terminal admission counts cannot be rewritten', () => {
  const old = { w: worker() }
  assert.throws(() => validateWorkerUpdate(old, {}), /tombstone/)
  const changed = structuredClone(old)
  changed.w.sandboxRoot = '/other'
  assert.throws(() => validateWorkerUpdate(old, changed), /identity/)
  const generationChanged = structuredClone(old)
  generationChanged.w.createdGeneration = 'rewritten-generation'
  assert.throws(() => validateWorkerUpdate(old, generationChanged), /identity/)
  old.w.sandbox = 'read-only'
  changed.w = { ...old.w, sandbox: 'workspace-write' }
  assert.throws(() => validateWorkerUpdate(old, changed), /permission/)
  assert.throws(() => validateWorkerUpdate({}, old, true), /add workers/)
  old.w.runs.w.state = 'completed'
  changed.w = structuredClone(old.w)
  changed.w.runs.w.state = 'running'
  assert.throws(() => validateWorkerUpdate(old, changed), /immutable/)
})

for (const kind of ['completed', 'blocked', 'error', 'aborted', 'interrupted']) {
  test(`raw claim binds ${kind} before any user/message, independent of later turns`, () => {
    const events = [inserted(), event(1, 'turn/start', { turn: 7 }), claimed(),
      event(3, 'turn/end', { turn: 7, reason: { kind } }),
      event(4, 'turn/start', { turn: 8 }), event(5, 'turn/end', { turn: 8, reason: { kind: 'completed' } })]
    const evidence = workerEvidence(events, worker().runs.w)
    assert.equal(evidence.turn, 7)
    assert.equal(evidence.endSeq, 3)
    assert.deepEqual(evidence.finish, { kind })
    assert.equal(evidence.text, '(no final text)')
  })
}

test('canceled input is never mistaken for a claim or a successful later turn', () => {
  const evidence = workerEvidence([inserted(), claimed(1, 'canceled'), event(2, 'turn/start', { turn: 1 }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })], worker().runs.w)
  assert.equal(evidence.turn, undefined)
  assert.equal(evidence.droppedSeq, 1)
  assert.equal(evidence.finish, undefined)
})

test('result keeps final text, exact interrupted warning, outside-input notice, link and Unicode budget', () => {
  const w = worker()
  const events = [inserted(), event(1, 'turn/start', { turn: 1 }), claimed(),
    event(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'first' }] } }),
    event(4, 'user/message', { source: { kind: 'user', rpcId: 'outside' }, content: [] }),
    event(5, 'assistant/message', { message: { content: [{ type: 'text', text: 'last' }] } }),
    event(6, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } })]
  const e = workerEvidence(events, w.runs.w)
  assert.equal(e.text, 'last')
  const text = workerResult(w, w.runs.w, e.finish, 'x😀'.repeat(5000), e.outsideInput)
  assert.equal(Array.from(text).length, 4000)
  assert.match(text, /may have partially run; not re-run/)
  assert.match(text, /worker received outside input/)
  assert.match(text, /session:ws/)
  const source = { kind: 'worker-result', taskId: 'task', workerId: 'w', runId: 'w', resultId: 'w:result', requesterSessionId: 'ta' }
  const entry = historyEntry(event(8, 'user/message', { source, content: [{ type: 'text', text }] }), false)
  assert.equal(entry.who, 'worker')
  assert.equal(entry.provenance.resultId, 'w:result')
  assert.equal(entry.provenance.sessionId, 'ta')
})

test('flag-off with no workers registers identical tools, schemas and prompt sections', async t => {
  const a = fakeContext()
  const b = fakeContext()
  const roots = await Promise.all([mkdtemp(join(tmpdir(), 'worker-off-')), mkdtemp(join(tmpdir(), 'worker-off-'))])
  const ra = createRuntime(a, { home: roots[0], memory: false })
  const rb = createRuntime(b, { home: roots[1], memory: false, nativeWorkers: false })
  await Promise.all([ra.load(), rb.load()])
  assert.deepEqual(a.calls, b.calls)
  assert.deepEqual([...a.registeredTools.keys()], [...b.registeredTools.keys()])
  assert.deepEqual([...a.sections.keys()], [...b.sections.keys()])
  assert.equal(a.registeredTools.has('run_worker'), false)
  assert.equal(ra.state.tasks && Object.keys(ra.state.tasks).length, 0)
  t.after(async () => { await a.dispose(); await b.dispose(); for (const root of roots) await rm(root, { recursive: true, force: true }) })
})

test('the final worker guard denies unknown ownership before loading even when pre-execute is skipped', async t => {
  const home = await mkdtemp(join(tmpdir(), 'worker-unloaded-'))
  const ctx = fakeContext()
  createRuntime(ctx, { home, nativeWorkers: true, memory: false })
  const reason = ctx.guards[0]({ name: 'worker_escape_probe', agent: { id: 'renamed-worker' } })
  assert.match(reason, /ownership is unavailable/)
  assert.equal(ctx.guards[0]({ name: 'worker_escape_probe' }), undefined)
  await ctx.dispose()
  t.after(() => rm(home, { recursive: true, force: true }))
})

class WorkerMock extends LlmAdapter {
  requests = []
  fault
  async listModels(provider) { return [{ provider, id: 'model', name: 'model' }] }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, defaultMaxTokens: 500,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }
  }
  async *stream(options) {
    this.requests.push(options)
    if (this.fault === 'hang') {
      await new Promise((resolve, reject) => {
        this.release = resolve
        if (options.signal.aborted) return reject(options.signal.reason)
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Native evidence.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native evidence.' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// Native factory, scoped tools, inbox/claim, loop, sandbox and approval are real DSH.
// The controller/persistence facade below is a unit fixture, not Web/cold-controller acceptance.
async function nativeHarness(t, config = {}, { beforeLoad, beforeRuntime, mountPreset } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'worker-native-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dsh')
  const cwd = join(root, 'project')
  const home = join(root, 'bot')
  await mkdir(join(cwd, 'child'), { recursive: true })
  await mkdir(home)
  await writeFile(join(home, 'state.json'), JSON.stringify(seed()))
  await beforeLoad?.({ home, cwd, statePath: join(home, 'state.json') })
  const ctx = new Context()
  for (const [plugin, options] of [[LlmRuntime], [SessionStore], [SessionProjections], [SystemPrompt],
    [ToolRuntime], [AgentRegistry], [AgentLoop, { agents: [] }], [SandboxPolicy], [Approval]]) await ctx.plugin(plugin, options)
  const adapter = new WorkerMock()
  ctx.llm.registerAdapter(['mock'], adapter)
  const dirs = new Map()
  const flushes = []
  ctx.provide('workingDirectory', { get: session => dirs.get(session.id) ?? session.header.cwd,
    set: async (agent, path) => { dirs.set(agent.id, path) } })
  ctx.provide('agentPresets', { resolve: async () => ({ id: 'test-default' }), mount: mountPreset ?? (async () => {}), serviceFor: () => undefined })
  ctx.provide('workspaceRegistry', { get: () => ({ id: 'unit-workspace', path: cwd, title: 'Unit workspace' }),
    archiveSession: async () => {}, archivedSessionIds: [] })
  const titles = new Map()
  ctx.provide('sessionTitle', { get: session => titles.get(session?.id), rename: async (session, title) => {
    titles.set(session.id, { title })
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
  } })
  ctx.provide('sessionQuery', {})
  const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush = async session => { flushes.push(session.id); return originalFlush(session) }
  let admissionWait
  const histories = new Map()
  const resolve = async id => {
    if (ctx.agents.get(id)) return ctx.agents.get(id)
    const raw = histories.get(id)
    if (!raw) throw new Error('fixture Session missing')
    return (await ctx.agents.create({ sessionId: id, seed: raw.events, meta: { cwd: raw.meta.cwd },
      agentOptions: { provider: 'mock', model: 'model' } })).agent
  }
  ctx.provide('sessionController', {
    resolveAgent: async id => ({ agent: ctx.agents.get(id) ?? (histories.has(id) ? await resolve(id) : undefined) }),
    inspect: async id => {
      const agent = ctx.agents.get(id)
      if (!agent) {
        if (histories.has(id)) return histories.get(id)
        throw new Error('fixture Session missing')
      }
      return { meta: agent.session.header, events: agent.session.snapshotEvents() }
    },
    page: async ({ address }) => ({ records: ctx.agents.get(address.sessionId).session.snapshotEvents().map(event => ({ event })), hasMore: false }),
    prompt: async (request, signal) => {
      signal.throwIfAborted()
      await admissionWait?.()
      const agent = await resolve(request.sessionId)
      agent.followup(createUserMessage({
        content: request.content, source: { kind: 'user', rpcId: request.requestId },
      }))
      return { accepted: true }
    },
  })
  const plugin = await ctx.plugin(scope => {
    scope.provide('connection', { fetch: { register: () => () => {} } })
  })
  let rt
  await beforeRuntime?.({ ctx, cwd, home })
  const mount = () => ctx.plugin({ inject, apply(scope) {
    rt = createRuntime(scope, { home, memory: false, nativeWorkers: true, taskSessions: ['PM', 'Dev'], ...config })
  } })
  let fiber = await mount()
  await rt.load()
  // Skip unrelated Bot capability restoration in this native worker unit harness.
  rt.ensureCapabilities = async () => {}
  for (const id of ['a', 'b', 'ta', 'tb']) {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd }, agentOptions: { provider: 'mock', model: 'model' } })
    setSandboxMode(handle.agent.session, 'workspace-write')
    setApprovalPolicy(handle.agent.session, 'ask')
  }
  const exec = { agent: ctx.agents.get('ta'), callId: 'call-1', signal: AbortSignal.timeout(10000) }
  const wait = async predicate => {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('worker condition timed out')
  }
  const get = () => Object.values(rt.taskOf('task').workers ?? {})[0]
  t.after(async () => {
    await fiber.dispose(); await plugin.dispose(); await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { ctx, get rt() { return rt }, adapter, exec, cwd, home, dirs, get, wait, flushes,
    get fiber() { return fiber },
    reload: async () => {
      const previous = ctx.agents.list()
      await fiber.dispose()
      for (const agent of previous) histories.set(agent.id, {
        meta: agent.session.header, events: agent.session.snapshotEvents(),
      })
      fiber = await mount()
      await rt.load()
      rt.ensureCapabilities = async () => {}
    },
    pauseAdmission: callback => { admissionWait = callback } }
}

test('native worker is asynchronous, uses the immutable root/current cd, forced never, initial agentOptions and durable exact-target result', async t => {
  const h = await nativeHarness(t)
  h.dirs.set('ta', join(h.cwd, 'child'))
  const result = await h.rt.runWorker({ prompt: 'Report evidence.', effort: 'high' }, h.exec)
  assert.match(result, /^started worker /)
  await h.wait(() => h.get()?.runs[h.get().id].result)
  await h.wait(() => h.rt.taskOf('task').sends?.[`${h.get().id}:result`]?.delivery.state === 'delivered')
  const w = h.get()
  const agent = h.ctx.agents.get(w.sessionId)
  assert.equal(agent.session.header.cwd, h.cwd)
  assert.equal(h.dirs.get(w.sessionId), join(h.cwd, 'child'))
  assert.equal(h.ctx.approval.overrideOf(agent.session), 'never')
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write')
  assert.equal(agent.session.requestHeader().config.provider, 'mock')
  assert.equal(agent.session.requestHeader().config.model, 'model')
  assert.equal(agent.session.requestHeader().config.reasoningEffort, 'high')
  const run = w.runs[w.id]
  assert.equal(run.state, 'completed')
  assert.equal(typeof run.turn, 'number')
  assert.equal(typeof run.claimSeq, 'number')
  assert.equal(typeof run.requestHeaderSeq, 'number')
  assert.equal(run.result.id, `${w.id}:result`)
  assert.equal(h.rt.selfOf(w.sessionId), undefined)
  assert.equal(h.rt.isBotSession(w.sessionId), false)
  const messages = h.ctx.agents.get('ta').session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced')
    .flatMap(e => e.data.inserted).filter(m => m.source?.kind === 'worker-result')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].source.requesterSessionId, 'ta')
  assert.equal(h.ctx.agents.get('tb').session.snapshotEvents().some(e => e.data?.source?.kind === 'worker-result'), false)
  assert.equal((await h.rt.runWorker({ prompt: 'Report evidence.', effort: 'high' }, h.exec)), result)
  assert.equal(Object.keys(h.rt.taskOf('task').workers).length, 1)
})

for (const failure of ['blocked', 'assembly']) {
  test(`native ${failure} before user-message settles the exact claim`, async t => {
    const h = await nativeHarness(t)
    h.ctx.on('agent/created', ({ agent }) => {
      if (!h.rt.workerClaim(agent.id)) return
      if (failure === 'blocked') agent.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
      else agent.ctx.on('system-prompt/assemble', async () => { throw new Error('assembly fixture failure') })
    })
    await h.rt.runWorker({ prompt: 'Fail before message admission.' }, h.exec)
    await h.wait(() => h.get()?.runs[h.get().id].result)
    const w = h.get()
    assert.equal(w.runs[w.id].state, 'failed')
    assert.equal(w.runs[w.id].finish.kind, failure === 'blocked' ? 'blocked' : 'error')
    assert.match(w.runs[w.id].result.text, /\(no final text\)/)
    assert.equal(w.runs[w.id].turn, 1)
  })
}

test('verify uses the direct read-only setter and cannot request workspace-write/full access or cross-root cwd', async t => {
  const h = await nativeHarness(t)
  await assert.rejects(h.rt.runWorker({ prompt: 'Verify.', mode: 'verify', permission: 'workspace-write' }, h.exec), /ceiling/)
  await assert.rejects(h.rt.runWorker({ prompt: 'Verify.', permission: 'danger-full-access' }, h.exec), /permission/)
  await assert.rejects(h.rt.runWorker({ prompt: 'Verify.', workdir: tmpdir() }, h.exec), /inside/)
  assert.equal(Object.keys(h.rt.taskOf('task').workers ?? {}).length, 0)
  await h.rt.runWorker({ prompt: 'Verify.', mode: 'verify' }, h.exec)
  assert.equal(h.get().sandbox, 'read-only')
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: h.ctx.agents.get(h.get().sessionId).session }).mode, 'read-only')
})

test('all forbidden/unknown scoped names are denied even after replacement and HMR disposal leaves deny-all', async t => {
  const h = await nativeHarness(t)
  await h.rt.runWorker({ prompt: 'Report.' }, h.exec)
  const agent = h.ctx.agents.get(h.get().sessionId)
  let calls = 0
  const names = ['message_bot', 'run_worker', 'worker_followup', 'cancel_worker', 'subagent', 'spawn_agent',
    'create_goal', 'update_goal', 'get_goal', 'schedule', 'plugin_manager', 'mcp:write', 'unknown_alias']
  for (const name of names) {
    const definition = { name, parameters: {}, output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: () => { calls++; return 'escaped' } }
    const dispose = agent.ctx.tools.register(defineTool(definition))
    const result = await h.ctx.tools.execute({ agent, name, arguments: {}, callId: randomId(), signal: AbortSignal.timeout(2000) })
    assert.equal(result.isError, true, name)
    dispose()
    agent.ctx.tools.register(defineTool(definition))
    const replaced = await h.ctx.tools.execute({ agent, name, arguments: {}, callId: randomId(), signal: AbortSignal.timeout(2000) })
    assert.equal(replaced.isError, true, `re-registered ${name}`)
  }
  assert.equal(calls, 0)
  agent.ctx.tools.register(defineTool({ name: 'read', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => 'permitted' }))
  const before = await h.ctx.tools.execute({ agent, name: 'read', arguments: {}, callId: randomId(), signal: AbortSignal.timeout(2000) })
  assert.equal(before.isError, false)
  await h.fiber.dispose()
  const result = await h.ctx.tools.execute({ agent, name: 'read', arguments: {}, callId: randomId(), signal: AbortSignal.timeout(2000) })
  assert.equal(result.isError, true)
})

function randomId() { return `call-${Math.random()}` }

test('admission limits/capability and exact task endpoints are checked at call time without rewriting history', async t => {
  const h = await nativeHarness(t, { maxWorkersPerTask: 0 })
  await assert.rejects(h.rt.runWorker({ prompt: 'Run.' }, h.exec), /limit/)
  assert.equal(h.rt.taskOf('task').workers, undefined)
  h.rt.config.maxWorkersPerTask = 1
  await h.rt.runWorker({ prompt: 'Run.' }, h.exec)
  await assert.rejects(h.rt.runWorker({ prompt: 'Again.' }, { ...h.exec, callId: 'second' }), /limit/)
  h.rt.config.taskSessions = []
  await assert.rejects(h.rt.runWorker({ prompt: 'No capability.' }, { ...h.exec, callId: 'third' }), /eligible/)
  h.rt.config.nativeWorkers = false
  h.rt.indexSessions()
  assert.equal(h.ctx.tools.schemas(h.exec.agent).some(tool => tool.name === 'run_worker'), false)
  await assert.rejects(h.rt.runWorker({ prompt: 'Gate off.' }, h.exec), /disabled/)
  assert.equal(Object.keys(h.rt.taskOf('task').workers).length, 1)
  assert.equal(validateTask(h.rt.taskOf('task'), 'task').workers[h.get().id].id, h.get().id)
  await assert.rejects(h.rt.runWorker({ prompt: 'Trunk.' }, { ...h.exec, agent: h.ctx.agents.get('a') }), /disabled/)
})

test('done refuses running workers; terminal-first close drains them without changing the conclusion or reviving the task', async t => {
  const h = await nativeHarness(t)
  h.adapter.fault = 'hang'
  await h.rt.runWorker({ prompt: 'Wait for cancellation.' }, h.exec)
  await h.wait(() => h.get()?.runs[h.get().id].state === 'running')
  await assert.rejects(h.rt.closeTask('ta', { task: 'task', status: 'done', conclusion: 'Done.', evidence: 'Tests.' }), /dependencies/)
  h.adapter.fault = undefined
  await h.rt.closeTask('ta', { task: 'task', status: 'blocked', conclusion: 'Stop pending work.' })
  assert.equal(h.rt.taskOf('task').state, 'blocked')
  const conclusion = structuredClone(h.rt.taskOf('task').conclusion)
  await h.wait(() => h.get()?.cleanup.state === 'settled')
  assert.equal(h.get().runs[h.get().id].state, 'cancelled')
  assert.equal(h.get().runs[h.get().id].finish.reason.kind, 'aborted')
  assert.equal(h.get().runs[h.get().id].finish.reason.reason.reason, 'ds-bot/worker-stop')
  assert.equal(h.get().admissionsClosed, true)
  assert.deepEqual(h.rt.taskOf('task').conclusion, conclusion)
  assert.equal(h.rt.taskOf('task').delivery.summaryId, 'task:closed')
  await h.wait(() => h.rt.taskOf('task').lateReplies.count === 1)
  assert.equal(Object.keys(h.rt.taskOf('task').workers).length, 1)
  assert.equal(h.rt.taskOf('task').state, 'blocked')
})

test('a late prompt admission after terminal commit is fenced, drained and never becomes an unowned run', async t => {
  const h = await nativeHarness(t)
  h.adapter.fault = 'hang'
  let release
  let waiting = false
  h.pauseAdmission(() => new Promise(resolve => { waiting = true; release = resolve }))
  const start = h.rt.runWorker({ prompt: 'Delayed admission.' }, h.exec)
  start.catch(() => {})
  await h.wait(() => waiting)
  await h.rt.commitTask('task', task => {
    task.state = 'failed'
    task.closedAt = 2
    task.conclusion = { status: 'failed', text: 'Closed during admission.' }
    task.delivery = { summaryId: 'task:closed', state: 'pending', targets: [] }
    return task
  })
  release()
  await assert.rejects(start, /stopped/)
  h.adapter.fault = undefined
  await h.wait(() => h.get()?.cleanup.state === 'settled')
  assert.equal(h.get().runs[h.get().id].state, 'cancelled')
  assert.equal(h.get().admissionsClosed, true)
  assert.equal(h.rt.taskOf('task').state, 'failed')
  assert.equal(h.rt.taskOf('task').lateReplies.count, 1)
})

test('result receiver flush failure retries with raw-log dedupe and no second result copy', async t => {
  const h = await nativeHarness(t)
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
  let refused = false
  h.ctx.sessions.flush = async session => {
    if (!refused && session.id === 'ta' && session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source?.kind === 'worker-result'))) {
      refused = true
      throw new Error('temporary receiver flush failure')
    }
    return flush(session)
  }
  await h.rt.runWorker({ prompt: 'Result retry.' }, h.exec)
  await h.wait(() => h.rt.taskOf('task').sends?.[`${h.get()?.id}:result`]?.delivery.state === 'delivered')
  assert.equal(refused, true)
  const admissions = h.ctx.agents.get('ta').session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted).filter(message => message.source?.kind === 'worker-result')
  assert.equal(admissions.length, 1)
})

test('worker ownership refuses DSH Agent adoption and task endpoint claims in both directions', async t => {
  const h = await nativeHarness(t)
  await h.rt.runWorker({ prompt: 'Owned worker.' }, h.exec)
  h.rt.state.agents.g = { id: 'g', name: 'DSH Agent', sessions: [] }
  await assert.rejects(h.rt.adoptAgentSession('g', h.get().sessionId), /cannot be adopted/)
  await assert.rejects(h.rt.commitTask('task', task => {
    task.sessions.extra = h.get().sessionId
    task.participants.extra = { role: 'participant', kind: 'fresh' }
    return task
  }), /conflicting Session|worker-owned/)
  assert.equal(h.rt.selfOf(h.get().sessionId), undefined)
})

test('native requester tightening cancels active work, persists the lower ceiling and reasserts never after worker UI changes', async t => {
  const h = await nativeHarness(t)
  h.adapter.fault = 'hang'
  await h.rt.runWorker({ prompt: 'Wait for permission tightening.' }, h.exec)
  await h.wait(() => h.get()?.runs[h.get().id].state === 'running')
  const agent = h.ctx.agents.get(h.get().sessionId)
  h.adapter.fault = undefined
  setSandboxMode(h.exec.agent.session, 'read-only')
  await h.wait(() => h.get()?.sandbox === 'read-only')
  await h.wait(() => h.get()?.runs[h.get().id].result)
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only')
  setSandboxMode(h.exec.agent.session, 'workspace-write')
  setSandboxMode(agent.session, 'workspace-write')
  setApprovalPolicy(agent.session, 'ask')
  await h.rt.reconcileWorkerPermissions('a')
  assert.equal(h.get().sandbox, 'read-only')
  assert.equal(h.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'read-only')
  assert.equal(h.ctx.approval.overrideOf(agent.session), 'never')
})

test('headerless restart settles unknown without a model and native publication is permanently refused before queued work', async t => {
  const h = await nativeHarness(t)
  const w = worker()
  Object.assign(w, { sandboxRoot: h.cwd, canonicalRoot: h.cwd, initialWorkdir: h.cwd, createdHost: 'earlier-host' })
  await h.rt.commitTask('task', task => { task.workers = { w }; return task })
  const inspect = h.ctx.sessionController.inspect
  h.ctx.sessionController.inspect = async id => id === 'ws'
    ? { meta: { id: 'ws', cwd: h.cwd }, events: [] } : inspect(id)
  const before = h.adapter.requests.length
  await h.rt.recoverWorkers()
  assert.equal(h.get().runs.w.state, 'unknown')
  assert.equal(h.get().admissionBlockReason, 'restart-before-first-header')
  assert.equal(h.get().admissionsClosed, true)
  assert.match(h.get().runs.w.result.text, /unknown outcome; not rerun/)
  await assert.rejects(h.ctx.agents.create({ sessionId: 'ws', meta: { cwd: h.cwd },
    agentOptions: { provider: 'mock', model: 'model' } }), /permanently closed/)
  // The coordinator may read the delivered unknown result; no worker request was made.
  assert.equal(h.adapter.requests.slice(before).some(request => request.messages.some(message =>
    message.content?.some(block => block.type === 'text' && block.text === 'Run isolated work.'))), false)
  assert.equal(h.ctx.agents.get('ws'), undefined)
})

for (const withUser of [false, true]) {
  test(`restart interrupted closer remains unknown with original user/message=${withUser}`, async t => {
    const h = await nativeHarness(t)
    const w = worker()
    Object.assign(w, { sandboxRoot: h.cwd, canonicalRoot: h.cwd, initialWorkdir: h.cwd, createdHost: 'earlier-host' })
    await h.rt.commitTask('task', task => { task.workers = { w }; return task })
    const events = [inserted(), event(1, 'turn/start', { turn: 1 }), claimed(),
      ...(withUser ? [event(3, 'user/message', { source: { kind: 'user', rpcId: 'w' }, content: [] })] : []),
      event(4, 'turn/end', { turn: 1, reason: { kind: 'interrupted', cause: 'restart-fixture' } })]
    const inspect = h.ctx.sessionController.inspect
    h.ctx.sessionController.inspect = async id => id === 'ws' ? { meta: { id, cwd: h.cwd }, events } : inspect(id)
    await h.rt.recoverWorkers()
    assert.equal(h.get().runs.w.state, 'unknown')
    assert.deepEqual(h.get().runs.w.finish, { kind: 'interrupted', cause: 'restart-fixture' })
    assert.match(h.get().runs.w.result.text, /may have partially run; not re-run/)
    assert.equal(h.get().admissionBlockReason, 'restart-before-first-header')
  })
}

for (const failure of ['EACCES', 'EISDIR', 'version']) {
  test(`real storage ${failure} denies a renamed cold worker even with the rollout off`, async t => {
    let restore
    const originalRead = fsp.readFile
    t.after(() => { fsp.readFile = originalRead; syncBuiltinESMExports() })
    let agent
    const h = await nativeHarness(t, { nativeWorkers: false }, {
      async beforeLoad({ cwd, statePath }) {
        const data = seed()
        const w = worker()
        Object.assign(w, { sandboxRoot: cwd, canonicalRoot: cwd, initialWorkdir: cwd })
        data.tasks.task.workers = { w }
        const saved = JSON.stringify(data)
        await writeFile(join(cwd, '..', 'bot', 'workers.created.jsonl'), JSON.stringify({
          version: 1, sessionId: 'ws', marker: w.marker,
        }) + '\n')
        await writeFile(statePath, saved)
        if (failure === 'EACCES') {
          let failing = true
          fsp.readFile = async (path, ...args) => {
            if (failing && path === statePath) throw Object.assign(new Error('worker storage read failure'), { code: 'EACCES' })
            return originalRead(path, ...args)
          }
          syncBuiltinESMExports()
          restore = async () => { failing = false }
        } else if (failure === 'EISDIR') {
          await rm(statePath)
          await mkdir(statePath)
          restore = async () => { await rm(statePath, { recursive: true }); await writeFile(statePath, saved) }
        } else {
          await writeFile(statePath, JSON.stringify({ ...data, version: 2 }))
          restore = async () => writeFile(statePath, saved)
        }
      },
      async beforeRuntime({ ctx, cwd }) {
        ;({ agent } = await ctx.agents.create({ sessionId: 'ws', meta: { cwd },
          agentOptions: { provider: 'mock', model: 'model' } }))
        agent.session.append('session/title', { title: 'worker:task:w', messageSeqs: [],
          source: { kind: 'user' } })
        await ctx.sessionTitle.rename(agent.session, 'Ordinary renamed Session')
      },
    })
    let bodies = 0
    for (const name of ['send_message', 'pwsh']) {
      agent.ctx.tools.register(defineTool({ name, parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: () => { bodies++; return 'escaped' } }))
    }
    const execute = name => h.ctx.tools.execute({ agent, name, arguments: {}, callId: randomId(), signal: AbortSignal.timeout(2000) })
    for (const name of ['send_message', 'pwsh']) assert.equal((await execute(name)).isError, true)
    assert.equal(bodies, 0)
    assert.notEqual(h.rt.stateReadError(), undefined)
    const rawSeed = agent.session.snapshotEvents()
    await assert.rejects(h.ctx.agents.create({ sessionId: 'cold-worker', seed: rawSeed, meta: { cwd: h.cwd },
      agentOptions: { provider: 'mock', model: 'model' } }), /ownership is unavailable/)
    const { agent: plain } = await h.ctx.agents.create({ sessionId: 'plain-user', meta: { cwd: h.cwd },
      agentOptions: { provider: 'mock', model: 'model' } })
    plain.ctx.tools.register(defineTool({ name: 'pwsh', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: () => 'plain Session works' }))
    assert.equal((await h.ctx.tools.execute({ agent: plain, name: 'pwsh', arguments: {},
      callId: randomId(), signal: AbortSignal.timeout(2000) })).isError, false)
    await restore()
    assert.equal((await execute('send_message')).isError, true)
    assert.equal(h.rt.stateReadError(), undefined)
    assert.equal(h.rt.workerClaim('ws').workerId, 'w')
    assert.equal(bodies, 0)
  })
}

test('worker marker and creation tombstone are durable before the first prompt and survive rename', async t => {
  const h = await nativeHarness(t)
  let checked = false
  h.pauseAdmission(async () => {
    const w = h.get()
    const raw = await h.ctx.sessionController.inspect(w.sessionId)
    const marker = raw.events.find(e => e.type === 'session/title' && e.data.title === w.marker)
    assert.equal(marker.data.title, w.marker)
    assert.equal(raw.events.some(e => e.type === 'request/header'), false)
    const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader({
      ...raw.meta, delegationDepth: raw.meta.delegationDepth ?? 0,
    }, 0),
      { recovery: 'strict', validation: 'current' })
    for (const event of raw.events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event))
    assert.equal(restore.finish().events[marker.seq].data.title, w.marker)
    assert.equal(h.flushes.includes(w.sessionId), true)
    const rows = (await fsp.readFile(join(h.home, 'workers.created.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.sessionId === w.sessionId).length, 1)
    checked = true
  })
  await h.rt.runWorker({ prompt: 'Check durable marker.' }, h.exec)
  assert.equal(checked, true)
  const w = h.get()
  const agent = h.ctx.agents.get(w.sessionId)
  await h.ctx.sessionTitle.rename(agent.session, 'Ordinary renamed Session')
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'session/title' && e.data.title === w.marker).length, 1)
})

for (const unavailable of ['index', 'index-and-marker', 'index-and-ledger']) {
  test(`renamed cold worker refuses native prompt with unreadable ${unavailable}; plain user Session remains usable`, async t => {
    const h = await nativeHarness(t)
    await h.rt.runWorker({ prompt: 'Must never run twice.' }, h.exec)
    await h.wait(() => h.get().runs[h.get().id].result)
    const id = h.get().sessionId
    await h.ctx.sessionTitle.rename(h.ctx.agents.get(id).session, 'Ordinary renamed Session')
    const data = JSON.parse(await fsp.readFile(join(h.home, 'state.json'), 'utf8'))
    await writeFile(join(h.home, 'state.json'), JSON.stringify({ ...data, version: 2 }))
    if (unavailable === 'index-and-marker') {
      const inspect = h.ctx.sessionController.inspect
      h.ctx.sessionController.inspect = async session => {
        if (session === id) throw new Error('marker storage read failure')
        return inspect(session)
      }
    }
    if (unavailable === 'index-and-ledger') {
      await rm(join(h.home, 'workers.created.jsonl'))
      await mkdir(join(h.home, 'workers.created.jsonl'))
    }
    await h.reload()
    const count = h.adapter.requests.length
    await assert.rejects(h.ctx.sessionController.prompt({ sessionId: id, requestId: randomId(), mode: 'queue',
      content: [{ type: 'text', text: 'Must be refused before a model request.' }] }, AbortSignal.timeout(2000)),
    /ownership is unavailable/)
    assert.equal(h.adapter.requests.length, count)
    assert.equal(h.ctx.agents.get(id), undefined)
    const { agent } = await h.ctx.agents.create({ sessionId: 'user-created', meta: { cwd: h.cwd },
      agentOptions: { provider: 'mock', model: 'model' } })
    await h.ctx.sessionController.prompt({ sessionId: agent.id, requestId: randomId(), mode: 'queue',
      content: [{ type: 'text', text: 'Plain Session prompt.' }] }, AbortSignal.timeout(2000))
    await agent.whenIdle()
    assert.equal(h.adapter.requests.length, count + 1)
  })
}

test('plugin HMR disposal settles unknown/plugin-reload once with warning, closed activation and no re-prompt', async t => {
  const h = await nativeHarness(t)
  h.adapter.fault = 'hang'
  await h.rt.runWorker({ prompt: 'Interrupted only by plugin reload.' }, h.exec)
  await h.wait(() => h.get().runs[h.get().id].state === 'running')
  const w = h.get()
  const requests = () => h.adapter.requests.filter(request => request.messages.some(message =>
    message.content?.some(block => block.text === 'Interrupted only by plugin reload.'))).length
  assert.equal(requests(), 1)
  h.adapter.fault = undefined
  await h.reload()
  await h.rt.recoverWorkers()
  await h.wait(() => h.get().runs[w.id].result)
  const run = h.get().runs[w.id]
  assert.equal(run.state, 'unknown')
  assert.equal(run.finish.reason, 'plugin-reload')
  assert.deepEqual(run.finish.cause, { kind: 'aborted', reason: { kind: 'disposed' } })
  assert.match(run.result.text, /may have partially run; not re-run/)
  assert.equal(h.get().admissionBlockReason, 'plugin-reload')
  await h.wait(() => h.rt.taskOf('task').sends?.[run.result.id]?.delivery.state === 'delivered')
  await h.rt.recoverWorkers()
  assert.equal(h.ctx.agents.get('ta').session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced')
    .flatMap(e => e.data.inserted).filter(m => m.source?.resultId === run.result.id).length, 1)
  await assert.rejects(h.ctx.sessionController.prompt({ sessionId: w.sessionId, requestId: randomId(), mode: 'queue',
    content: [{ type: 'text', text: 'Never re-prompt a disposed worker.' }] }, AbortSignal.timeout(2000)), /plugin-reload.*permanently closed/)
  assert.equal(requests(), 1)
})

test('a failed real refresh retains positive Bot/task/plain ownership and worker tombstones', async t => {
  const h = await nativeHarness(t)
  await h.rt.runWorker({ prompt: 'Stored owner.' }, h.exec)
  await h.wait(() => h.get().runs[h.get().id].result)
  const { agent: plain } = await h.ctx.agents.create({ sessionId: 'plain', meta: { cwd: h.cwd },
    agentOptions: { provider: 'mock', model: 'model' } })
  h.rt.state.agents['plain-owner'] = { id: 'plain-owner', sessions: ['plain'], name: 'Plain Agent', createdAt: 1 }
  await h.rt.save({ required: true })
  const saved = JSON.parse(await fsp.readFile(join(h.home, 'state.json'), 'utf8'))
  await writeFile(join(h.home, 'state.json'), JSON.stringify({ ...saved, version: 2 }))
  await rm(join(h.home, 'state.lock'))
  await h.rt.refresh()
  assert.notEqual(h.rt.stateReadError(), undefined)
  assert.equal(h.rt.selfOf('ta'), 'a')
  assert.equal(h.rt.agentOf('plain').id, 'plain-owner')
  assert.equal(h.rt.workerClaim(h.get().sessionId).workerId, h.get().id)
  plain.ctx.tools.register(defineTool({ name: 'plain_owned_probe', description: 'Known plain Session remains usable',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: () => 'known owner' }))
  assert.equal((await h.ctx.tools.execute({ agent: plain, name: 'plain_owned_probe', arguments: {},
    callId: randomId(), signal: AbortSignal.timeout(2000) })).isError, false)
  await writeFile(join(h.home, 'state.json'), JSON.stringify(saved))
  await h.rt.refresh()
  assert.equal(h.rt.stateReadError(), undefined)
})

test('scoped-only default-preset tools stay visible but cannot fail setup or execute', async t => {
  let bodies = 0
  const h = await nativeHarness(t, {}, {
    async mountPreset(scope) {
      scope.tools.register(defineTool({ name: 'subagent', description: 'Scoped preset regression sentinel', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: () => { bodies++; return 'escaped' } }))
    },
  })
  await h.rt.runWorker({ prompt: 'Use the scoped preset.' }, h.exec)
  await h.wait(() => h.get().runs[h.get().id].result)
  assert.equal(h.get().runs[h.get().id].state, 'completed', JSON.stringify(h.get().runs[h.get().id].finish))
  const agent = h.ctx.agents.get(h.get().sessionId)
  assert.equal(h.ctx.tools.schemas(agent).some(tool => tool.name === 'subagent'), true)
  assert.equal((await h.ctx.tools.execute({ agent, name: 'subagent', arguments: {}, callId: randomId(), signal: AbortSignal.timeout(2000) })).isError, true)
  assert.equal(bodies, 0)
})

for (const boundary of ['inspect', 'save', 'flush']) {
  test(`native terminal during ${boundary} await settles without HMR and delivers exactly once`, async t => {
    const h = await nativeHarness(t)
    h.adapter.fault = 'hang'
    await h.rt.runWorker({ prompt: 'Hold a native model call.' }, h.exec)
    // Startup recovery must not rescue the missed notification this regression targets.
    if (boundary === 'inspect') await new Promise(resolve => setTimeout(resolve, 3200))
    const id = h.get().sessionId
    let release
    let paused = false
    const gate = () => new Promise(resolve => { paused = true; release = resolve })
    if (boundary === 'inspect') {
      const inspect = h.ctx.sessionController.inspect
      h.ctx.sessionController.inspect = async sessionId => {
        const snapshot = await inspect(sessionId)
        if (sessionId === id && !paused) await gate()
        return snapshot
      }
    } else if (boundary === 'save') {
      const save = h.rt.save
      h.rt.save = async options => {
        if (!paused && h.get().runs[h.get().id].state === 'running') await gate()
        return save(options)
      }
    } else {
      const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
      h.ctx.sessions.flush = async session => {
        if (session.id === id && !paused) await gate()
        return flush(session)
      }
    }
    const recovery = h.rt.recoverWorkers()
    await h.wait(() => paused)
    h.adapter.fault = undefined
    h.adapter.release()
    await h.ctx.agents.get(id).whenIdle()
    release()
    await recovery
    await h.wait(() => h.get().runs[h.get().id].state === 'completed'
      && h.rt.taskOf('task').sends?.[`${h.get().id}:result`]?.delivery.state === 'delivered')
    const copies = h.ctx.agents.get('ta').session.snapshotEvents().filter(e => e.type === 'agent/inbox/spliced')
      .flatMap(e => e.data.inserted).filter(message => message.source?.kind === 'worker-result')
    assert.equal(copies.length, 1)
  })
}

test('periodic evidence check recovers an idle completed turn after stale snapshots', async t => {
  const h = await nativeHarness(t)
  h.adapter.fault = 'hang'
  await h.rt.runWorker({ prompt: 'Leave stale history snapshots.' }, h.exec)
  const workerId = h.get().sessionId
  const inspect = h.ctx.sessionController.inspect
  const stale = await inspect(workerId)
  let reads = 0
  h.ctx.sessionController.inspect = async id => id === workerId && ++reads <= 2 ? stale : inspect(id)
  h.adapter.fault = undefined
  h.adapter.release()
  await h.ctx.agents.get(workerId).whenIdle()
  await h.wait(() => h.get().runs[h.get().id].state === 'completed')
  assert.ok(reads >= 3)
})

test('own native abort waits for quiescence before cancelled and keeps its exact native reason', async t => {
  const h = await nativeHarness(t)
  h.adapter.fault = 'hang'
  await h.rt.runWorker({ prompt: 'Cancel only after drain.' }, h.exec)
  const agent = h.ctx.agents.get(h.get().sessionId)
  const nativeIdle = agent.whenIdle.bind(agent)
  let release
  const confirmation = new Promise(resolve => { release = resolve })
  agent.whenIdle = async () => { await nativeIdle(); await confirmation }
  const stopping = h.rt.stopNativeWorker(h.get().id)
  await h.wait(() => agent.status === 'idle')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.get().runs[h.get().id].state, 'cancelling')
  assert.equal(h.get().runs[h.get().id].result, undefined)
  h.adapter.fault = undefined
  release()
  await stopping
  const run = h.get().runs[h.get().id]
  assert.equal(run.state, 'cancelled')
  assert.deepEqual(run.finish, { kind: 'cancelled', reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'ds-bot/worker-stop' } } })
})

test('a prior completed run and an unrelated abort are not rewritten as cancelled', async t => {
  const h = await nativeHarness(t)
  await h.rt.runWorker({ prompt: 'Complete before stop.' }, h.exec)
  await h.wait(() => h.get().runs[h.get().id].state === 'completed')
  const before = structuredClone(h.get().runs[h.get().id])
  await h.rt.stopNativeWorker(h.get().id)
  assert.deepEqual(h.get().runs[h.get().id], before)
  h.adapter.fault = 'hang'
  await h.rt.runWorker({ prompt: 'Unrelated abort.' }, { ...h.exec, callId: 'unrelated' })
  const other = Object.values(h.rt.taskOf('task').workers)[1]
  h.ctx.agents.get(other.sessionId).cancel({ kind: 'hook', reason: 'unrelated-user-action' })
  h.adapter.fault = undefined
  await h.wait(() => h.rt.taskOf('task').workers[other.id].runs[other.id].state === 'failed')
  await h.rt.stopNativeWorker(other.id)
  assert.equal(h.rt.taskOf('task').workers[other.id].runs[other.id].state, 'failed')
})
