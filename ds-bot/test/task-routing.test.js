import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { answerSender } from '../src/host/turns.js'
import { asyncScope } from '../src/host/async.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { fakeContext } from './fake-ctx.js'

async function setup(t, config = {}, seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-routing-'))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(seed ?? {
    version: 1, mainBotIds: ['a'], bots: Object.fromEntries(['a', 'b', 'c', 'd'].map(id =>
      [id, { id, name: id.toUpperCase(), sessionId: id, createdAt: 1, permission: 'full' }])),
    rooms: {}, exchanges: [],
  }))
  const agents = new Map(), logs = new Map()
  const forks = [], fresh = [], selections = [], permissions = [], capabilities = [], restores = [], titles = []
  const profile = { provider: 'profile', model: 'default', reasoningEffort: 'low' }
  const ctx = fakeContext({ services: {
    agentPresets: { list: async () => [{ id: 'standard' }], serviceFor: () => undefined },
    agentDefaultModel: { currentSelection: () => profile, saveSelection: async value => restores.push(value) },
    permissionPresets: { set: (session, preset) => permissions.push([session.id, preset]) },
  } })
  const agentOf = id => {
    if (agents.has(id)) return agents.get(id)
    const events = logs.get(id) ?? (/^[a-d]$/.test(id) ? [{ type: 'turn/end', seq: 13, data: { reason: { kind: 'completed' } } }] : [])
    logs.set(id, events)
    const scope = fakeContext()
    scope.tools.register = tool => {
      scope.registeredTools.set(tool.name, tool)
      return () => scope.registeredTools.delete(tool.name)
    }
    const agent = {
      id, status: 'idle', calls: [], ctx: scope,
      session: { id, inheritedEventCount: 14, requestHeader: () => ({ config: profile }) },
      inbox: { nextStep: [], nextTurn: [], remove(messageId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const i = list.findIndex(message => message.id === messageId)
          if (i >= 0) { list.splice(i, 1); return true }
        }
        return false
      }, clear() { this.nextStep.length = 0; this.nextTurn.length = 0 } },
      followup(message) { this.calls.push(['followup', message]); this.inbox.nextTurn.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) },
      steer(message) { this.calls.push(['steer', message]); this.inbox.nextStep.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) },
    }
    agents.set(id, agent)
    t.after(() => scope.dispose())
    return agent
  }
  Object.assign(ctx, {
    sessionController: {
      fork: async args => { forks.push(args); return { sessionId: `fork-${forks.length}` } },
      create: async args => { fresh.push(args); return { sessionId: `fresh-${fresh.length}` } },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async args => { selections.push(args); return { selected: args } },
      inspect: async id => { agentOf(id); return { events: structuredClone(logs.get(id)) } },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async (session, title) => titles.push([session.id, title]) },
    sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'workspace' }) },
  })
  const rt = createRuntime(ctx, { home, memory: false, taskSessionsEnabled: true, taskSessions: ['A', 'B'], ...config })
  await rt.load()
  rt.ensureCapabilities = async sessionId => {
    assert.ok(rt.isBotSession(sessionId))
    capabilities.push(sessionId)
  }
  const announced = new Set()
  const tool = async (name, args, id = 'a') => {
    const agent = agentOf(id)
    if (!announced.has(id)) {
      announced.add(id)
      for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
    }
    return (agent.ctx.registeredTools.get(name) ?? ctx.registeredTools.get(name)).execute(args, { agent })
  }
  const send = (id = 'a', to = 'B', extra = {}) => tool('message_bot', { to, message: 'Current delegation missing from the fork prefix', ...extra }, id)
  const tasks = () => Object.values(rt.state.tasks)
  const incoming = sessionId => agentOf(sessionId).calls.at(-1)?.[1].source
  const handling = (sessionId, source) => rt.live.set(sessionId, { turn: 7, info: source })
  const saved = () => JSON.parse(readFileSync(statePath, 'utf8'))
  let seq = 100
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, data, seq: ++seq, time: Date.now() })
    }
  }
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, home, statePath, agentOf, logs, forks, fresh, selections, restores, permissions, capabilities, titles, tool, send, tasks, incoming, handling, saved, emit }
}

for (const gate of [false, true]) {
  for (const a of [false, true]) for (const b of [false, true]) {
    test(`root routing matrix gate=${gate} pair=${Number(a)}${Number(b)}`, async t => {
      const f = await setup(t, { taskSessionsEnabled: gate, taskSessions: [a && 'A', b && 'B'].filter(Boolean) })
      await f.send()
      const count = Number(gate && a && b)
      assert.equal(f.tasks().length, count)
      assert.equal(f.forks.length, count)
      assert.equal(f.fresh.length, count)
      assert.equal(f.agentOf('b').calls.length, 1 - count)
      if (count) {
        const task = f.tasks()[0]
        assert.equal(task.phase, 'ready')
        assert.equal(f.incoming(task.sessions.b).taskId, task.id)
      }
    })
  }
}

test('requester fork records actual boundary and explicit brief; assignee uses standard fresh setup', async t => {
  const f = await setup(t)
  f.rt.desiredModel = async () => 'mock/task'
  f.rt.desiredEffort = async () => 'high'
  await f.send()
  const task = f.tasks()[0]
  assert.deepEqual(f.forks, [{ sessionId: 'a', atSeq: 13, allowMigration: false }])
  assert.equal(task.participants.a.inheritedThrough, 13)
  assert.equal(task.participants.b.inheritedThrough, null)
  assert.equal(f.fresh[0].agentPreset, 'standard')
  assert.deepEqual(f.selections.map(item => [item.provider, item.model, item.reasoningEffort]), [['mock', 'task', 'high'], ['mock', 'task', 'high']])
  assert.deepEqual(f.restores, [f.agentOf('a').session.requestHeader().config, f.agentOf('a').session.requestHeader().config])
  for (const [botId, sessionId] of Object.entries(task.sessions)) {
    assert.equal(f.rt.selfOf(sessionId), botId)
    assert.equal(f.rt.isBotSession(sessionId), true)
    assert.ok(f.permissions.some(([id, preset]) => id === sessionId && preset === 'full'))
    assert.ok(f.capabilities.includes(sessionId))
    const prompt = f.ctx.sections.get('bot-identity').text({ agent: f.agentOf(sessionId) })
    assert.match(prompt, new RegExp(`You are ${botId.toUpperCase()},`))
    assert.ok(prompt.includes(task.brief))
    assert.ok(prompt.includes(task.id))
  }
  const message = f.agentOf(task.sessions.b).calls[0][1]
  assert.ok(message.content[0].text.includes(task.brief))
  assert.ok(message.content[0].text.includes(task.id))
  assert.equal(f.saved().tasks[task.id].phase, 'ready')
})

for (const fallback of [false, true]) {
  test(`task workdir is applied to both saved, permissioned endpoints before delivery; fresh requester=${fallback}`, async t => {
    const f = await setup(t)
    const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-task-folder-')))
    t.after(() => rmSync(workdir, { recursive: true, force: true, maxRetries: 5 }))
    f.rt.dshHome = join(f.home, 'dsh')
    // Seed the optional persisted workdir without adding a routing/tool argument.
    const commit = f.rt.commitTask
    f.rt.commitTask = (id, update) => commit(id, previous => {
      const next = update(previous)
      if (previous === undefined) next.workdir = workdir
      return next
    })
    if (fallback) f.ctx.sessionController.fork = async () => {
      throw Object.assign(new Error('session "a" has no completed turn to fork from'), { code: 'session/fork-unavailable' })
    }
    const directories = new Map()
    const applied = [], approvals = []
    f.ctx.workingDirectory = {
      get: session => directories.get(session.id),
      async set(agent, path, signal) {
        signal.throwIfAborted()
        const task = f.rt.taskForSession(agent.id)
        assert.ok(task)
        assert.equal(f.saved().tasks[task.id].sessions[f.rt.selfOf(agent.id)], agent.id)
        assert.ok(f.permissions.some(([id, preset]) => id === agent.id && preset === 'full'))
        assert.equal(agent.calls.length, 0)
        directories.set(agent.id, path)
        applied.push(agent.id)
        return path
      },
    }
    const get = f.ctx.get
    f.ctx.get = name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) }
      : name === 'approval' ? { request: async ({ agent }) => { approvals.push(agent.id); return 'allowed-once' } }
        : name === 'workingDirectory' ? f.ctx.workingDirectory : get(name)
    const capabilities = f.rt.ensureCapabilities
    f.rt.ensureCapabilities = async (id, options) => {
      assert.equal(f.ctx.workingDirectory.get(f.agentOf(id).session), workdir)
      return capabilities(id, options)
    }
    await f.send()
    const task = f.tasks()[0]
    const endpoints = [task.sessions.a, task.sessions.b]
    assert.deepEqual(applied, endpoints)
    assert.deepEqual(approvals, endpoints)
    assert.deepEqual(endpoints.map(id => directories.get(id)), [workdir, workdir])
    assert.equal(task.participants.a.kind, fallback ? 'fresh' : 'fork')
    assert.equal(task.participants.b.kind, 'fresh')
    assert.equal(task.phase, 'ready')
    assert.equal(f.agentOf(task.sessions.b).calls.length, 1)
    assert.ok(f.fresh.every(options => options.cwd === workdir))
    assert.equal(f.agentOf('a').calls.length + f.agentOf('b').calls.length, 0)
    assert.deepEqual([f.rt.botOf('a').workDir, f.rt.botOf('b').workDir], [undefined, undefined])
  })
}

test('no-completed-turn is the only fresh requester fallback', async t => {
  const f = await setup(t)
  f.ctx.sessionController.fork = async () => { throw Object.assign(new Error('session "a" has no completed turn to fork from'), { code: 'session/fork-unavailable' }) }
  await f.send()
  const task = f.tasks()[0]
  assert.equal(f.fresh.length, 2)
  assert.equal(task.participants.a.kind, 'fresh')
  assert.equal(task.participants.a.inheritedThrough, null)
  assert.deepEqual(Object.values(task.creationIntents).map(intent => intent.state), ['failed', 'created', 'created'])
})

for (const error of [
  new Error('timeout'), new Error('transport disconnected'),
  Object.assign(new Error('session "a" has no completed turn to fork from'), { code: 'gateway/internal' }),
  Object.assign(new Error('event 8 does not exist'), { code: 'session/fork-unavailable' }),
]) {
  test(`unknown fork outcome fails closed: ${error.code ?? error.message}`, async t => {
    const f = await setup(t)
    f.ctx.sessionController.fork = async () => { throw error }
    await assert.rejects(f.send(), err => err === error)
    const task = f.tasks()[0]
    assert.equal(task.state, 'failed')
    assert.equal(task.conclusion.status, 'blocked')
    assert.deepEqual(task.delivery, { summaryId: `${task.id}:closed`, targets: [], state: 'pending' })
    assert.equal(Object.values(task.creationIntents)[0].state, 'unknown')
    assert.equal(f.fresh.length, 0)
    assert.equal(f.agentOf('b').calls.length, 0)
    await assert.rejects(f.send('a', 'B', { task: task.id }), /not open/)
  })
}

test('creation intent is durable before fork and before fresh create; endpoint saved before setup', async t => {
  const f = await setup(t)
  const fork = f.ctx.sessionController.fork
  f.ctx.sessionController.fork = async args => {
    const task = Object.values(f.saved().tasks)[0]
    assert.equal(task.phase, 'creating')
    assert.equal(Object.values(task.creationIntents)[0].state, 'creating')
    assert.equal(Object.values(task.creationIntents)[0].sourceSessionId, 'a')
    return fork(args)
  }
  const create = f.ctx.sessionController.create
  f.ctx.sessionController.create = async args => {
    const task = Object.values(f.saved().tasks)[0]
    assert.equal(Object.values(task.creationIntents).at(-1).state, 'creating')
    assert.ok(task.sessions.a)
    return create(args)
  }
  f.ctx.sessionTitle.rename = async (session, marker) => {
    const task = Object.values(f.saved().tasks)[0]
    assert.ok(Object.values(task.sessions).includes(session.id))
    assert.ok(Object.values(task.creationIntents).some(intent => intent.sessionId === session.id && intent.marker === marker))
  }
  await f.send()
})

test('two concurrent and reverse tasks between one pair have separate Sessions and exact replies', async t => {
  const f = await setup(t)
  await Promise.all([f.send(), f.send('a', 'B', { message: 'Second independent task' }), f.send('b', 'A')])
  assert.equal(f.tasks().length, 3)
  assert.equal(new Set(f.tasks().flatMap(task => Object.values(task.sessions))).size, 6)
  for (const task of f.tasks()) {
    const source = f.incoming(task.sessions[task.assignee])
    await answerSender(f.rt, task.sessions[task.assignee], source, `result-${task.id}`)
    const reply = f.agentOf(task.sessions[task.requester]).calls.at(-1)[1]
    assert.equal(reply.source.taskId, task.id)
    assert.match(reply.content[0].text, new RegExp(`result-${task.id}$`))
  }
  assert.equal(f.agentOf('a').calls.length + f.agentOf('b').calls.length, 0)
})

test('same request_id in different tasks is separate and repeated root admission creates one task', async t => {
  const f = await setup(t)
  const result = await Promise.all([f.send('a', 'B', { request_id: 'root' }), f.send('a', 'B', { request_id: 'root' })])
  assert.equal(result[0], result[1])
  assert.equal(f.tasks().length, 1)
  await f.send('a', 'B', { message: 'another' })
  for (const task of f.tasks()) {
    await f.send(task.sessions.a, 'B', { request_id: 'followup' })
    const n = f.agentOf(task.sessions.b).calls.length
    await f.send(task.sessions.a, 'B', { request_id: 'followup' })
    assert.equal(f.agentOf(task.sessions.b).calls.length, n)
  }
  assert.equal(Object.keys(f.rt.state.requests).length, 3)
})

for (const shared of [false, true]) {
  test(`flat participant routing, selector refusals, receipts and capability removal; shared=${shared}`, async t => {
    const f = await setup(t, { taskSessions: shared ? ['A', 'B'] : ['A', 'B', 'C'] })
    await f.send()
    const id = f.tasks()[0].id
    await f.send(f.rt.taskOf(id).sessions.a, 'C')
    let task = f.rt.taskOf(id)
    const cSession = task.sessions.c
    assert.equal(task.participants.c.kind, shared ? 'trunk' : 'fresh')
    assert.equal(f.rt.taskBySession.has(cSession), !shared)
    f.handling(cSession, f.incoming(cSession))
    f.rt.config.taskSessions = ['C', 'D']
    f.rt.config.taskSessionsEnabled = false
    await f.send(cSession, 'D', { request_id: 'same' })
    task = f.rt.taskOf(id)
    assert.equal(task.participants.d.kind, 'fresh')
    const n = f.fresh.length
    await f.send(cSession, 'D', { request_id: 'same' })
    await f.send(cSession, 'D', { message: 'another message' })
    assert.equal(f.fresh.length, n)
    for (const extra of [{ task: 'new' }, { task: 'missing' }, { work: 'new' }, { reply_to: 'user' }]) {
      await assert.rejects(f.send(cSession, 'D', { ...extra, request_id: 'refused' }), /inherited task/)
    }
    assert.equal(f.tasks().length, 1)
    assert.equal(Object.keys(f.rt.state.requests).length, 1)
    assert.equal(f.fresh.length, n)
    await f.send(cSession, 'D', { task: id, work: 'ignored' })
    assert.equal(f.incoming(task.sessions.d).taskId, id)
  })
}

test('shared trunk handles two tasks and multiple callers without mixing reply addresses', async t => {
  const f = await setup(t)
  await Promise.all([f.send(), f.send('a', 'B', { message: 'T2' })])
  const ids = f.tasks().map(task => task.id)
  for (const id of ids) {
    const task = f.rt.taskOf(id)
    await f.send(task.sessions.a, 'C', { request_id: 'C' })
    await f.send(task.sessions.b, 'C', { request_id: 'C' })
  }
  const messages = f.agentOf('c').calls.map(call => call[1])
  assert.equal(messages.length, 4)
  for (const message of messages) {
    const source = message.source
    f.handling('c', source)
    assert.equal(f.rt.taskContext('c'), source.taskId)
    await answerSender(f.rt, 'c', source, source.replySessionId)
    const reply = f.agentOf(source.replySessionId).calls.at(-1)[1]
    assert.equal(reply.source.taskId, source.taskId)
    assert.equal(reply.source.replyTo, source.exchangeId)
  }
  assert.equal(f.agentOf('a').calls.length, 0)
})

test('shared trunk inherits task from saved work when the trigger has no taskId', async t => {
  const f = await setup(t)
  await f.send()
  await f.send(f.tasks()[0].sessions.a, 'C')
  const source = { ...f.incoming('c') }
  delete source.taskId
  f.handling('c', source)
  await f.send('c', 'D')
  assert.equal(f.tasks().length, 1)
  assert.equal(f.incoming('d').taskId, f.tasks()[0].id)
})

test('task selector wins over work and refuses unknown/terminal/nonmember before receipts', async t => {
  const f = await setup(t)
  await f.send()
  const id = f.tasks()[0].id
  await f.send('a', 'B', { task: id, work: 'missing' })
  for (const [caller, to, task] of [['a', 'B', 'missing'], ['c', 'B', id], ['a', 'C', id]]) {
    await assert.rejects(f.send(caller, to, { task, work: 'new', request_id: 'refused' }), /unknown|participants/)
  }
  await f.rt.commitTask(id, task => ({ ...task, state: 'done', closedAt: Date.now() }))
  await assert.rejects(f.send('a', 'B', { task: id, request_id: 'refused' }), /not open/)
  assert.equal(Object.keys(f.rt.state.requests).length, 0)
})

for (const gate of [false, true]) {
  test(`legacy precedence and alias routing with gate=${gate}`, async t => {
    const f = await setup(t, { taskSessionsEnabled: gate, taskSessions: [], workBranches: [['A', 'B']] })
    await f.send('a', 'B', { work: 'new' })
    const legacy = Object.values(f.rt.botOf('a').workBranches)[0]
    assert.equal(f.tasks().length, 0)
    await f.send('a', 'B', { work: legacy.id })
    f.handling('b', f.incoming('b'))
    await f.send('b', 'A')
    assert.equal(f.forks.length, 1)
    await assert.rejects(f.send('b', 'A', { task: 'new', request_id: 'escape' }), /inherited legacy/)
    await f.send('a', 'B')
    assert.equal(f.tasks().length, Number(gate))
    assert.equal(f.agentOf('b').calls.length, gate ? 2 : 3)
    f.rt.config.workBranches = []
    await f.send('a', 'B', { work: legacy.id })
    assert.equal(f.forks.length, 1 + Number(gate))
  })
}

test('reply_to user and group calls never open root tasks; explicit task is refused', async t => {
  const f = await setup(t)
  await f.send('a', 'B', { reply_to: 'user' })
  assert.equal(f.incoming('b').audience, 'user')
  await assert.rejects(f.send('a', 'B', { reply_to: 'user', task: 'new' }), /private Bot request/)
  f.rt.state.rooms.r = { id: 'r', name: 'Room', members: ['a', 'b'], sessions: { a: 'room-a' } }
  f.rt.indexSessions()
  let calls = 0
  f.rt.roomStepText = async () => calls++
  await f.send('room-a', 'B')
  await assert.rejects(f.send('room-a', 'B', { task: 'new' }), /private Bot request/)
  assert.equal(calls, 1)
  assert.equal(f.tasks().length, 0)
})

test('interrupted creation is failed on reload without a second create or fork', async t => {
  const f = await setup(t)
  const fork = f.ctx.sessionController.fork
  f.ctx.sessionController.fork = async args => {
    const result = await fork(args)
    asyncScope(f.rt).stop()
    return result
  }
  await assert.rejects(f.send(), /stopped/)
  const g = await setup(t, {}, f.saved())
  await g.rt.recoverTasks()
  assert.equal(g.tasks()[0].state, 'failed')
  assert.equal(Object.values(g.tasks()[0].creationIntents)[0].state, 'unknown')
  assert.equal(g.forks.length + g.fresh.length, 0)
})

test('failed durable intent save prevents any Session side effect', async t => {
  const f = await setup(t)
  const save = f.rt.save
  f.rt.save = async options => {
    if (Object.values(f.rt.state.tasks).some(task => Object.keys(task.creationIntents).length)) throw new Error('disk full')
    return save(options)
  }
  await assert.rejects(f.send(), /disk full/)
  assert.equal(f.forks.length + f.fresh.length, 0)
})

test('stopped delivery retains durable pending send and never claims it delivered', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  f.rt.ensureCapabilities = async () => asyncScope(f.rt).stop()
  await assert.rejects(f.send(task.sessions.a, 'B', { message: 'pending' }), /stopped/)
  assert.equal(Object.keys(f.saved().tasks[task.id].pendingSends).length, 1)
  assert.equal(f.agentOf(task.sessions.b).calls.length, 1)
})

test('pending send recovery inspects durable history and does not enqueue twice', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  const message = f.agentOf(task.sessions.b).calls[0][1]
  const args = { fromId: 'a', toId: 'b', sessionId: task.sessions.b, replySessionId: task.sessions.a, taskId: task.id, exchangeId: message.source.exchangeId, role: 'request', text: 'saved' }
  await f.rt.commitTask(task.id, task => { task.pendingSends[args.exchangeId] = { ...args, state: 'pending' }; return task })
  await f.rt.recoverTasks()
  assert.equal(f.agentOf(task.sessions.b).calls.length, 1)
  assert.equal(Object.keys(f.rt.taskOf(task.id).pendingSends).length, 0)
})

test('final task enqueue check rejects closure during capability resolution', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  f.rt.ensureCapabilities = async () => {
    await f.rt.commitTask(task.id, task => ({ ...task, state: 'cancelled', closedAt: Date.now() }))
  }
  await assert.rejects(f.send(task.sessions.a, 'B'), /not open/)
  assert.equal(f.agentOf(task.sessions.b).calls.length, 1)
})

test('S1 final boundary observes visibility changes after task capabilities await', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  const source = f.incoming(task.sessions.b)
  f.rt.live.set(task.sessions.b, { turn: 4, info: source, steerable: true, visible: false })
  f.rt.state.exchangeTurns[task.sessions.b] = [4]
  f.handling(task.sessions.a, { kind: SOURCE_KIND, role: 'reply', work: source.exchangeId, taskId: task.id })
  f.rt.ensureCapabilities = async () => { f.rt.live.get(task.sessions.b).visible = true }
  await f.send(task.sessions.a, 'B')
  assert.equal(f.agentOf(task.sessions.b).calls.at(-1)[0], 'followup')
})

test('participant creation and sends share one async lane and wait for ready setup', async t => {
  const f = await setup(t, { taskSessions: ['A', 'B', 'C'] })
  await f.send()
  const task = f.tasks()[0]
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const select = f.rt.selectSessionModel
  f.rt.selectSessionModel = async (...args) => {
    if (f.rt.selfOf(args[0]) === 'c') { entered.resolve(); await release.promise }
    return select(...args)
  }
  const first = f.send(task.sessions.a, 'C', { message: 'first' })
  await entered.promise
  assert.equal(f.rt.taskOf(task.id).phase, 'creating')
  const c = f.rt.taskOf(task.id).sessions.c
  const second = f.send(task.sessions.b, 'C', { message: 'second' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.agentOf(c).calls.length, 0)
  release.resolve()
  await Promise.all([first, second])
  assert.equal(f.rt.taskOf(task.id).phase, 'ready')
  assert.equal(f.fresh.length, 2)
  assert.equal(f.agentOf(c).calls.length, 2)
  assert.deepEqual(new Set(f.agentOf(c).calls.map(call => call[1].source.replySessionId)), new Set([task.sessions.a, task.sessions.b]))
})

test('creation/setup/send lane can be acquired by terminal lifecycle before a later send', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const close = f.rt.withTask(task.id, async () => {
    entered.resolve()
    await release.promise
    await f.rt.commitTask(task.id, task => ({ ...task, state: 'cancelled', closedAt: Date.now() }))
  })
  await entered.promise
  const send = f.send(task.sessions.a, 'B')
  const refused = assert.rejects(send, /not open/)
  release.resolve()
  await close
  await refused
  assert.equal(f.agentOf(task.sessions.b).calls.length, 1)
})

test('capability enablement on a shared trunk does not change existing endpoint or inherited task', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  await f.send(task.sessions.a, 'C')
  const trigger = f.incoming('c')
  f.rt.config.taskSessions = ['A', 'B', 'C', 'D']
  f.handling('c', trigger)
  await f.send('c', 'D')
  assert.equal(f.tasks().length, 1)
  assert.equal(f.rt.taskOf(task.id).participants.c.kind, 'trunk')
  f.handling('c', { kind: 'user' })
  await f.send('c', 'A')
  assert.equal(f.tasks().length, 2)
  const reverse = f.tasks().find(value => value.id !== task.id)
  assert.equal(reverse.requester, 'c')
  assert.notEqual(reverse.sessions.c, 'c')
  f.handling('c', trigger)
  await f.send('c', 'D')
  assert.equal(f.tasks().length, 2)
})

test('shared trunk address changes during capability wait are persisted before the final enqueue', async t => {
  const f = await setup(t)
  await f.send()
  const id = f.tasks()[0].id
  await f.send(f.rt.taskOf(id).sessions.a, 'C')
  let moved = false
  f.rt.ensureCapabilities = async sessionId => {
    if (sessionId === 'c' && !moved) {
      moved = true
      f.rt.botOf('c').sessionId = 'c-next'
      await f.rt.save({ required: true })
    }
  }
  await f.send(f.rt.taskOf(id).sessions.a, 'C', { message: 'new part' })
  assert.equal(f.agentOf('c').calls.length, 1)
  assert.equal(f.incoming('c-next').taskId, id)
  assert.equal(f.saved().tasks[id].sessions.c, 'c-next')
})

test('pending task reply resumes into its exact caller Session without duplicating the result', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  const source = f.incoming(task.sessions.b)
  let once = true
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.flush = async session => {
    if (once && session.id === task.sessions.a) { once = false; throw new Error('flush interrupted') }
    return flush(session)
  }
  await assert.rejects(f.rt.sendTaskAnswer(task.sessions.b, source, 'one result'), /flush interrupted/)
  assert.ok(f.rt.state.works[source.exchangeId].pendingAnswer.args.taskId)
  await f.rt.resumeTaskAnswer(source.exchangeId)
  assert.equal(f.agentOf(task.sessions.a).calls.length, 1)
  assert.equal(f.rt.state.works[source.exchangeId], undefined)
  assert.equal(f.agentOf('a').calls.length, 0)
})

test('a known Session with failed model setup is retained and never prompted or recreated', async t => {
  const f = await setup(t)
  f.rt.selectSessionModel = async () => ({ error: { message: 'model unavailable' } })
  await assert.rejects(f.send(), /model unavailable/)
  const task = f.tasks()[0]
  assert.equal(task.state, 'failed')
  assert.ok(task.sessions.a)
  assert.equal(f.agentOf(task.sessions.a).calls.length, 0)
  await f.rt.recoverTasks()
  assert.equal(f.forks.length, 1)
  assert.equal(f.fresh.length, 0)
})

test('an unknown additional-participant creation never retries and blocks further task sends', async t => {
  const f = await setup(t, { taskSessions: ['A', 'B', 'C'] })
  await f.send()
  const task = f.tasks()[0]
  const create = f.ctx.sessionController.create
  f.ctx.sessionController.create = async args => { await create(args); throw new Error('transport lost after create') }
  await assert.rejects(f.send(task.sessions.a, 'C'), /transport lost/)
  assert.equal(f.rt.taskOf(task.id).state, 'failed')
  await assert.rejects(f.send(task.sessions.a, 'C'), /not open/)
  await f.rt.recoverTasks()
  assert.equal(f.fresh.length, 2)
  assert.equal(f.agentOf('fresh-2').calls.length, 0)
})

test('two known no-completed-turn errors cannot share a fallback Session across reverse tasks', async t => {
  const f = await setup(t)
  f.ctx.sessionController.fork = async ({ sessionId }) => {
    throw Object.assign(new Error(`session "${sessionId}" has no completed turn to fork from`), { code: 'session/fork-unavailable' })
  }
  await Promise.all([f.send(), f.send('b', 'A')])
  assert.equal(f.tasks().length, 2)
  assert.equal(new Set(f.tasks().flatMap(task => Object.values(task.sessions))).size, 4)
})

test('leading blank lines in a delegation still produce a valid task title and preserve the brief', async t => {
  const f = await setup(t)
  const message = '\n\n  Check the archive\nReport evidence.'
  await f.send('a', 'B', { message })
  assert.equal(f.tasks()[0].title, 'Check the archive')
  assert.equal(f.tasks()[0].brief, message)
})

test('same-task same-work unread merge keeps one explicit brief and leaves no pending send', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  f.handling(task.sessions.b, f.incoming(task.sessions.b))
  await f.send(task.sessions.b, 'C', { message: 'child first' })
  await f.send(task.sessions.b, 'C', { message: 'child second' })
  const messages = f.agentOf('c').inbox.nextTurn
  assert.equal(messages.length, 1)
  const body = messages[0].content[0].text
  assert.match(body, /child first\n\nchild second$/)
  assert.equal(body.split(`[Task: ${task.id}]`).length, 2)
  assert.equal(Object.keys(f.rt.taskOf(task.id).pendingSends).length, 0)
})

test('an uncertain merged send fails closed on recovery instead of replaying a possibly consumed update', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  f.handling(task.sessions.b, f.incoming(task.sessions.b))
  await f.send(task.sessions.b, 'C', { message: 'first' })
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.flush = async session => {
    if (session.id === 'c') throw new Error('flush unknown')
    return flush(session)
  }
  await assert.rejects(f.send(task.sessions.b, 'C', { message: 'update' }), /flush unknown/)
  f.ctx.sessions.flush = flush
  await f.rt.recoverTasks()
  assert.equal(f.agentOf('c').calls.length, 2)
  const pending = Object.values(f.rt.taskOf(task.id).pendingSends)
  assert.equal(pending.length, 1)
  assert.match(pending[0].diagnostic, /outcome is unknown/)
})

for (const scenario of ['written-call', 'transient-failure', 'deferred-other-task']) {
  test(`shared-trunk turn keeps its exact task and caller in ${scenario}`, async t => {
    const f = await setup(t)
    await f.send()
    const first = f.tasks()[0]
    await f.send(first.sessions.a, 'C')
    const source = f.incoming('c')
    const delivered = [], resumes = []
    f.emit('c', 'turn/start', { turn: 2 })
    f.emit('c', 'user/message', { content: [{ type: 'text', text: 'first task' }], source })
    f.rt.deliver = async args => { delivered.push(args) }
    f.rt.scheduleFailureResume = record => resumes.push(record)
    if (scenario === 'written-call') {
      f.emit('c', 'assistant/message', { message: { content: [{ type: 'text', text: '<tool_call><function=read_file><parameter=path>x</parameter></function></tool_call>' }] } })
    } else if (scenario === 'deferred-other-task') {
      // Already queued messages can still be consumed together after a host restart.
      await f.send('a', 'B', { message: 'second task' })
      const second = f.tasks().find(task => task.id !== first.id)
      const exchangeId = 'second-task-request'
      f.rt.openWork(exchangeId, { from: 'a', to: 'c', taskId: second.id })
      await f.rt.commitTask(second.id, task => {
        task.participants.c = { role: 'participant', kind: 'trunk' }
        task.sessions.c = 'c'
        return task
      })
      f.emit('c', 'user/message', { content: [{ type: 'text', text: 'second task' }], source: {
        kind: SOURCE_KIND, role: 'request', exchangeId, senderSessionId: 'a',
        replySessionId: second.sessions.a, taskId: second.id,
      } })
    }
    delivered.length = 0
    assert.equal(f.rt.workAsker(source.exchangeId).taskId, first.id)
    f.emit('c', 'turn/end', { turn: 2, reason: scenario === 'transient-failure'
      ? { kind: 'error', error: { code: 'TRANSPORT', message: 'offline' } } : { kind: 'completed' } })
    await new Promise(resolve => setImmediate(resolve))
    const args = scenario === 'transient-failure' ? resumes[0]?.args
      : delivered.find(args => scenario === 'written-call' ? args.retried : args.deferred)
    const expected = scenario === 'deferred-other-task' ? f.tasks().find(task => task.id !== first.id) : first
    assert.equal(args.taskId, expected.id)
    assert.equal(args.sessionId, 'c')
    assert.equal(args.replySessionId, expected.sessions.a)
  })
}

test('direct deferred/retry delivery waits behind participant setup in the same async lane', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  await f.send(task.sessions.a, 'C')
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const setupJob = f.rt.withTask(task.id, async () => {
    await f.rt.commitTask(task.id, task => ({ ...task, phase: 'creating' }))
    entered.resolve()
    await release.promise
    await f.rt.commitTask(task.id, task => ({ ...task, phase: 'ready' }))
  })
  await entered.promise
  const before = f.agentOf('c').calls.length
  const args = {
    fromId: 'a', toId: 'c', taskId: task.id, sessionId: 'c', replySessionId: task.sessions.a,
    exchangeId: 'deferred', role: 'request', text: 'deferred task work', deferred: true,
  }
  const send = f.rt.deliver(args)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.agentOf('c').calls.length, before)
  release.resolve()
  await Promise.all([setupJob, send])
  assert.equal(f.agentOf('c').calls.length, before + 1)
  assert.equal(f.incoming('c').taskId, task.id)
})

test('the lane enqueue callback cannot be retained and used after its action finishes', async t => {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  let expired
  await f.rt.withTask(task.id, enqueue => { expired = enqueue })
  assert.throws(() => expired({ taskId: task.id }), /outside its execution lane/)
})

test('a running trunk and later trunk writes cannot change the fork boundary or delegation brief', async t => {
  const f = await setup(t)
  f.handling('a', { kind: 'user' })
  const fork = f.ctx.sessionController.fork
  f.ctx.sessionController.fork = async args => {
    const result = await fork(args)
    f.agentOf('a').session.inheritedEventCount = 1000
    return result
  }
  await f.send()
  const task = f.tasks()[0]
  assert.equal(task.participants.a.inheritedThrough, 13)
  assert.ok(task.brief.includes('Current delegation'))
  assert.deepEqual(f.forks[0], { sessionId: 'a', atSeq: 13, allowMigration: false })
})

test('generation stopping after fresh create returns never creates that participant again', async t => {
  const f = await setup(t)
  const create = f.ctx.sessionController.create
  f.ctx.sessionController.create = async args => {
    const result = await create(args)
    asyncScope(f.rt).stop()
    return result
  }
  await assert.rejects(f.send(), /stopped/)
  const g = await setup(t, {}, f.saved())
  await g.rt.recoverTasks()
  assert.equal(g.tasks()[0].state, 'failed')
  assert.equal(Object.values(g.tasks()[0].creationIntents).at(-1).state, 'unknown')
  assert.equal(g.fresh.length + g.forks.length, 0)
})

test('equivalent implicit and explicit current-task selectors replay the same named request', async t => {
  const f = await setup(t)
  const root = await f.send('a', 'B', { request_id: 'root' })
  assert.equal(await f.send('a', 'B', { task: 'new', request_id: 'root' }), root)
  const task = f.tasks()[0]
  const follow = await f.send(task.sessions.a, 'B', { request_id: 'follow' })
  assert.equal(await f.send(task.sessions.a, 'B', { task: task.id, request_id: 'follow' }), follow)
  assert.equal(f.tasks().length, 1)
  assert.equal(f.agentOf(task.sessions.b).calls.length, 2)
})

test('two delegations with a queued trunk instruction produce exactly two requests and two replies', async t => {
  const f = await setup(t)
  const queued = { id: 'queued-user', content: [{ type: 'text', text: 'Second root delegation' }],
    source: { kind: 'user', rpcId: 'trunk-only' } }
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [queued] } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', data: { title: 'standalone event after turn/end' } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', data: queued },
  ].map((event, seq) => ({ ...event, seq, time: seq + 1 }))
  f.logs.set('a', events)
  f.ctx.sessionController.fork = async args => {
    f.forks.push(args)
    const seed = buildForkSeed(events, args.atSeq ?? 3)
    const id = `fork-${f.forks.length}`
    const child = f.agentOf(id)
    child.session.inheritedEventCount = seed.find(event => event.type === 'session/end-seed').seq
    for (const event of seed) {
      if (event.type !== 'agent/inbox/spliced') continue
      const { start, removedCount = 0, inserted } = event.data
      child.inbox.nextTurn.splice(start, removedCount, ...inserted)
    }
    assert.equal(child.inbox.nextTurn[0].source.rpcId, 'trunk-only')
    return { sessionId: id }
  }
  await f.send('a', 'B', { message: 'First root delegation' })
  await f.send('a', 'B', { message: 'Second root delegation' })
  for (const task of f.tasks()) {
    const child = f.agentOf(task.sessions.a)
    // Without isolation, waking the fork for its reply also runs the inherited command.
    await answerSender(f.rt, task.sessions.b, f.incoming(task.sessions.b), `result-${task.id}`)
    for (const message of child.inbox.nextTurn.splice(0)) {
      if (message.source.kind === 'user') await f.send(child.id, 'B', { message: 'Duplicate from inherited input' })
    }
    assert.equal(task.participants.a.inheritedThrough, 2)
    assert.equal(f.saved().tasks[task.id].creationIntents[Object.keys(task.creationIntents)[0]].atSeq, 2)
  }
  assert.equal(f.tasks().length, 2)
  assert.equal(f.rt.state.exchanges.filter(entry => entry.role === 'request').length, 2)
  assert.equal(f.rt.state.exchanges.filter(entry => entry.role === 'reply').length, 2)
  assert.equal(f.forks.every(args => args.atSeq === 2 && args.allowMigration === false), true)
  assert.deepEqual(f.logs.get('a'), events)
})

test('admitted fork boundary stays fixed when the trunk completes another turn before fork', async t => {
  const f = await setup(t)
  const clean = f.rt.cleanWorkDir
  f.rt.cleanWorkDir = async (...args) => {
    f.logs.get('a').push({ type: 'turn/end', seq: 99, data: { turn: 2 } })
    return clean(...args)
  }
  await f.send()
  assert.equal(f.forks[0].atSeq, 13)
  assert.equal(f.tasks()[0].participants.a.forkAtSeq, 13)
})

test('a readable first-turn admission uses a fresh requester without a later default fork', async t => {
  const f = await setup(t)
  f.logs.set('a', [{ type: 'turn/start', seq: 0, data: { turn: 1 } }])
  await f.send()
  assert.equal(f.forks.length, 0)
  assert.equal(f.fresh.length, 2)
  assert.equal(f.tasks()[0].participants.a.kind, 'fresh')
})

test('an unreadable admission history cannot authorize a fork or fresh fallback', async t => {
  const f = await setup(t)
  f.ctx.sessionController.inspect = async () => ({ error: { message: 'unreadable' } })
  await assert.rejects(f.send(), /Cannot inspect/)
  assert.equal(f.forks.length + f.fresh.length, 0)
})

test('inherited inbox removal is flushed and failure prevents ready or task delivery', async t => {
  const f = await setup(t)
  const fork = f.ctx.sessionController.fork
  f.ctx.sessionController.fork = async args => {
    const result = await fork(args)
    f.agentOf(result.sessionId).inbox.nextTurn.push({ id: 'queued', source: { kind: 'user' } })
    return result
  }
  f.ctx.sessions.flush = async session => {
    if (session.id.startsWith('fork')) throw new Error('isolation flush failed')
  }
  await assert.rejects(f.send(), /isolation flush failed/)
  assert.equal(f.tasks()[0].state, 'failed')
  assert.equal(f.fresh.length, 0)
  assert.equal(f.rt.state.exchanges.length, 0)
})

test('discarding inherited Bot input never removes the original trunk delivery recovery record', async t => {
  const f = await setup(t)
  await f.send('c', 'A', { message: 'unrelated private request' })
  const original = f.agentOf('a').inbox.nextTurn[0]
  assert.equal(f.rt.unreadOf('a').length, 1)
  const fork = f.ctx.sessionController.fork
  f.ctx.sessionController.fork = async args => {
    const result = await fork(args)
    const child = f.agentOf(result.sessionId)
    child.inbox.nextTurn.push(original)
    child.inbox.clear = () => {
      for (const message of child.inbox.nextTurn.splice(0)) f.ctx.emit('agent/inbox/discarded', { agent: child, message })
    }
    return result
  }
  await f.send()
  assert.equal(f.rt.unreadOf('a').length, 1)
  assert.equal(f.agentOf('a').inbox.nextTurn[0], original)
})
