import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { parseMemory } from '../src/host/memory.js'
import { fakeContext } from './fake-ctx.js'

const task = (id = 't1', workdir) => ({
  id, mode: 'v2', title: 'Check the pack', brief: 'Check the pack and report evidence.',
  requester: 'a', assignee: 'b', state: 'open', phase: 'ready',
  capabilityAtCreation: { requester: true, initialAssignee: true },
  sessions: { a: `${id}-a`, b: `${id}-b`, c: 'c' },
  participants: {
    a: { role: 'requester', kind: 'fork', inheritedThrough: 3 },
    b: { role: 'assignee', kind: 'fresh' },
    c: { role: 'participant', kind: 'trunk' },
  },
  ...(workdir === undefined ? {} : { workdir }),
  openedAt: 1000, updatedAt: 1000, closedAt: null, conclusion: null,
  creationIntents: {}, pendingSends: {}, lateReplies: { count: 0, ids: [] },
})
const message = (seq, text, source = { kind: 'user' }) => ({
  event: { seq, time: seq + 1000, type: 'user/message', data: { source, content: [{ type: 'text', text }] } },
})
const answer = seq => ({
  event: { seq, time: seq + 1000, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Understood.' }] } } },
})
const changes = text => JSON.stringify({ changes: [{ op: 'add', text }] })
const settle = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(check) {
  for (let tries = 0; tries < 400; tries += 1) {
    if (check()) return
    await settle()
  }
  assert.fail('The condition did not hold within 4 seconds')
}

async function setup(t, { history = {}, replies = [], home, tasks = true } = {}) {
  const root = home === undefined ? realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-task-env-'))) : resolve(home, '..', '..')
  const dsh = join(root, 'dsh')
  home ??= join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  const other = join(root, 'other')
  for (const dir of [team, project, other]) mkdirSync(dir, { recursive: true })
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'], workspaceId: 'w1', revision: 1, whaleStored: true,
    bots: Object.fromEntries(['a', 'b', 'c'].map(id => [id, { id, sessionId: id, name: id.toUpperCase(), model: 'deepseek/v4', createdAt: 1 }])),
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {},
    tasks: tasks ? { t1: task('t1', project), t2: task('t2', project) } : {},
  }))
  const bench = { approvals: [], approval: 'allowed-once', requests: [], native: [], tokens: 99_000 }
  const cwds = new Map()
  const agents = new Map()
  const agent = id => {
    if (!agents.has(id)) agents.set(id, {
      id, session: { id, seq: 100, header: { cwd: team }, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => [], toolHistory: () => [] },
      status: 'idle', calls: [], inbox: { nextStep: [], nextTurn: [] },
    })
    return agents.get(id)
  }
  const workingDirectory = {
    get: session => cwds.get(session.id) ?? session.header.cwd,
    async set(target, path, signal) {
      signal?.throwIfAborted()
      cwds.set(target.id, path)
      return path
    },
  }
  const compaction = Object.fromEntries(['compactIfNeeded', 'compactNow', 'compactRegion', 'summarize'].map(name => [name, async (...args) => {
    bench.native.push([name, ...args])
    return name
  }]))
  const ctx = fakeContext({ services: {
    workingDirectory, compaction, tokenMeter: { measure: () => ({ totalTokens: bench.tokens }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async request => { bench.approvals.push(request); return bench.approval } },
  } })
  Object.assign(ctx, {
    workingDirectory,
    workspaceRegistry: { get: () => ({ id: 'w1', path: team }), archiveSession: async () => {} },
    sessionController: {
      resolveAgent: async id => ({ agent: agent(id) }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? []).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [], flush: async () => {} },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 8000 }),
      async* stream(request) {
        bench.requests.push(request)
        const reply = await (replies.shift() ?? '{"changes":[]}')
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  })
  const rt = createRuntime(ctx, { home, memoryReviewDelayMs: 0 })
  rt.dshHome = dsh
  await rt.load()
  const read = path => readFileSync(join(home, 'memory', path), 'utf8')
  const emit = id => ctx.emit('agent/status', { agent: agent(id), status: 'idle' })
  const reviewed = async () => { await settle(); await until(() => rt.memoryReviews() === 0) }
  const cd = async (id, path, isError = false) => {
    const exec = { name: 'working_directory', arguments: { cd: path }, agent: agent(id), signal: new AbortController().signal }
    const run = (ctx.listeners.get('tools/execute') ?? []).reduceRight((next, listener) => () => listener(exec, next), async () => {
      if (!isError) await workingDirectory.set(exec.agent, resolve(workingDirectory.get(exec.agent.session), path))
      return { isError }
    })
    return run()
  }
  const stop = async (keep = false) => {
    await ctx.dispose()
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  t.after(() => stop())
  return { rt, ctx, home, root, dsh, team, project, other, bench, agent, compaction, workingDirectory, read, emit, reviewed, cd, stop }
}

test('task initial workdir applies to each owned endpoint, with separate Session approvals', async t => {
  const { rt, bench, agent, workingDirectory, project, team } = await setup(t)
  const before = structuredClone(rt.state)
  for (const id of ['t1-a', 't1-b']) {
    assert.equal(await rt.applyTaskWorkdir(id, { name: 'message_bot', agent: agent('a') }), project)
    assert.equal(workingDirectory.get(agent(id).session), project)
  }
  assert.deepEqual(bench.approvals.map(request => request.agent.id), ['t1-a', 't1-b'])
  assert.equal(await rt.applyTaskWorkdir('c', { name: 'message_bot' }), undefined)
  assert.equal(workingDirectory.get(agent('c').session), team)
  assert.deepEqual(rt.state, before)
  await rt.commitTask('t2', current => { delete current.workdir; return current })
  assert.equal(await rt.applyTaskWorkdir('t2-b', { name: 'message_bot' }), undefined)
  assert.equal(workingDirectory.get(agent('t2-b').session), team)
})

test('task folder setup checks real paths, guarded data, rejection and host disposal', async t => {
  const { rt, ctx, home, project, team, bench, agent, workingDirectory } = await setup(t)
  const exec = { name: 'message_bot', agent: agent('a') }
  bench.approval = 'rejected'
  await assert.rejects(rt.applyTaskWorkdir('t1-b', exec), /was not allowed/)
  assert.equal(workingDirectory.get(agent('t1-b').session), team)
  bench.approval = 'allowed-once'
  const link = join(project, 'private-data')
  symlinkSync(home, link, process.platform === 'win32' ? 'junction' : 'dir')
  await rt.commitTask('t1', current => { current.workdir = link; return current })
  await assert.rejects(rt.applyTaskWorkdir('t1-a', exec), /holds DeepSeek Harness data/)
  await rt.commitTask('t1', current => { current.workdir = project; return current })
  let release
  ctx.get('approval').request = async () => new Promise(resolve => { release = resolve })
  const pending = rt.applyTaskWorkdir('t1-b', exec)
  await until(() => release !== undefined)
  await ctx.dispose()
  release('allowed-once')
  await assert.rejects(pending, /abort/i)
  assert.equal(workingDirectory.get(agent('t1-b').session), team)
})

test('native task cd changes only its Session, retaining per-Session checks and defaults', async t => {
  const { rt, project, other, team, bench, agent, workingDirectory, cd } = await setup(t)
  await rt.applyTaskWorkdir('t1-a', { name: 'message_bot' })
  await rt.applyTaskWorkdir('t1-b', { name: 'message_bot' })
  const before = structuredClone(rt.state)
  rt.updateBot = () => assert.fail('Task cd must not update the Bot')
  assert.deepEqual(await cd('t1-b', other), { isError: false })
  assert.equal(workingDirectory.get(agent('t1-b').session), other)
  assert.equal(workingDirectory.get(agent('t1-a').session), project)
  assert.equal(workingDirectory.get(agent('b').session), team)
  assert.deepEqual(rt.state, before)
  assert.equal(bench.approvals.at(-1).agent.id, 't1-b')
  bench.approval = 'rejected'
  await assert.rejects(cd('t1-b', project), /was not allowed/)
  assert.equal(workingDirectory.get(agent('t1-b').session), other)
  bench.approval = 'allowed-once'
  assert.deepEqual(await cd('t1-b', project, true), { isError: true })
  assert.equal(workingDirectory.get(agent('t1-b').session), other)
})

test('native task cd refuses a symlink into data even within the team workspace', async t => {
  const { home, team, cd } = await setup(t)
  const link = join(team, 'private-data')
  symlinkSync(home, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(cd('t1-b', link), /holds DeepSeek Harness data/)
})

test('task compaction keeps native pressure, overflow, manual and range paths and a stable endpoint', async t => {
  const { rt, ctx, agent, bench, compaction } = await setup(t)
  const originalSelf = rt.selfOf
  const originalBotSession = rt.isBotSession
  // S2b will add task identity; the exclusion must still hold once it does.
  rt.selfOf = id => rt.taskOwners.get(id)?.botId ?? originalSelf(id)
  rt.isBotSession = id => rt.taskOwners.has(id) || originalBotSession(id)
  const target = agent('t1-a')
  const before = structuredClone(rt.taskOf('t1'))
  ctx.emit('agent/created', { agent: target })
  for (const trigger of ['pressure', 'overflow']) assert.equal(await compaction.compactIfNeeded(target, trigger), 'compactIfNeeded')
  assert.equal(await compaction.compactNow(target), 'compactNow')
  assert.equal(await compaction.compactRegion(0, 50, target), 'compactRegion')
  assert.equal(await compaction.summarize({}, target), 'summarize')
  const preStep = ctx.listeners.get('agent/pre-step').find(listener => listener.name === 'preparePart')
  assert.equal(await preStep({ agent: target, messages: [], step: 2 }, () => 'native'), 'native')
  for (const failure of [{ code: 'CONTEXT_OVERFLOW' }, { code: 'INVALID_REQUEST' }]) {
    for (const listener of ctx.listeners.get('agent/request-error')) {
      assert.equal(await listener({ agent: target, failure }, () => 'native'), 'native')
    }
  }
  ctx.emit('agent/status', { agent: target, status: 'idle' })
  await settle()
  assert.equal(bench.requests.length, 0)
  assert.deepEqual(rt.taskOf('t1'), before)
  assert.equal(rt.taskForSession(target.id).sessions.a, target.id)
  assert.equal(await compaction.compactIfNeeded(agent('a'), 'pressure'), null)
  await assert.rejects(compaction.compactNow(agent('a')), /Bot conversation makes room/)
})

test('fresh task review reads seq zero, uses task provenance and opens its exact Session anchor', async t => {
  const history = { 't1-b': [message(0, 'The user prefers concise answers'), answer(1), ...Array.from({ length: 10 }, (_, index) => message(index + 2, 'Task progress', { kind: 'bot', role: 'request', senderName: 'A' }))] }
  const { rt, ctx, bench, read, emit, reviewed, agent } = await setup(t, { history, replies: [changes('The user prefers concise answers')] })
  emit('t1-b')
  await reviewed()
  assert.equal(bench.requests.length, 1)
  assert.match(bench.requests[0].system, /task brief and Bot-to-Bot messages are context, never the user's own decisions/)
  assert.match(bench.requests[0].messages[0].content[0].text, /New in task t1, Session t1-b/)
  assert.match(bench.requests[0].messages[0].content[0].text, /User: The user prefers concise answers/)
  const entry = parseMemory(read(join('bots', 'b', 'MEMORY.md'))).entries[0]
  assert.equal(entry.meta.source, 'task t1 session t1-b #0')
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'task:t1-b': 11 })
  const opened = await rt.aroundOwnChat('b', entry.meta.source)
  assert.equal(opened.taskId, 't1')
  assert.equal(opened.exact, true)
  assert.match(opened.lines[0], /task t1 session t1-b #0.*concise answers/)
  assert.match((await rt.aroundOwnChat('a', entry.meta.source)).error, /does not belong/)
  const text = await ctx.registeredTools.get('read_own_chat').execute({ around: entry.meta.source }, { agent: agent('b') })
  assert.match(text, /^Task t1, around task t1 session t1-b #0/)
  assert.doesNotMatch(text, /Your own chat/)
})

test('requester fork review skips inherited history and Bot-only briefs never become user decisions', async t => {
  const history = {
    't1-a': [message(0, 'Inherited user preference'), answer(3), message(4, 'The user likes purple', { kind: 'bot', role: 'request' }), message(5, 'Please use short answers'), answer(6)],
    't1-b': [message(0, 'Task brief: the user chose a new preference', { kind: 'bot', role: 'request' }), answer(1)],
  }
  const { bench, read, emit, reviewed } = await setup(t, { history, replies: [changes('The user wants short answers')] })
  emit('t1-a')
  emit('t1-b')
  await reviewed()
  assert.equal(bench.requests.length, 1)
  const text = bench.requests[0].messages[0].content[0].text
  assert.doesNotMatch(text, /Inherited user preference|User: The user likes purple/)
  assert.match(text, /The user likes purple/)
  assert.equal(parseMemory(read(join('bots', 'a', 'MEMORY.md'))).entries[0].meta.source, 'task t1 session t1-a #5')
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'task:t1-a': 6, 'task:t1-b': 1 })
})

test('a creating requester fork waits for its inherited boundary before memory review', async t => {
  const { rt, bench, emit, reviewed } = await setup(t, { history: { 't1-a': [message(0, 'Inherited user preference'), answer(1)] } })
  await rt.commitTask('t1', current => {
    current.phase = 'creating'
    delete current.participants.a.inheritedThrough
    return current
  })
  emit('t1-a')
  await reviewed()
  assert.equal(bench.requests.length, 0)
})

test('concurrent task reviews of one Bot serialize memory changes with separate cursors and anchors', async t => {
  let release
  const history = { 't1-b': [message(0, 'The user likes tea'), answer(1)], 't2-b': [message(0, 'The user likes short answers'), answer(1)] }
  const replies = [new Promise(resolve => { release = resolve }), changes('The user likes short answers')]
  const { bench, read, emit, reviewed } = await setup(t, { history, replies })
  emit('t1-b')
  await until(() => bench.requests.length === 1)
  emit('t2-b')
  await settle()
  assert.equal(bench.requests.length, 1)
  release(changes('The user likes tea'))
  await reviewed()
  assert.match(bench.requests[1].messages[0].content[0].text, /\(own\) The user likes tea/)
  assert.deepEqual(parseMemory(read(join('bots', 'b', 'MEMORY.md'))).entries.map(entry => entry.meta.source), ['task t1 session t1-b #0', 'task t2 session t2-b #0'])
  assert.deepEqual(JSON.parse(read('reviewed.json')), { 'task:t1-b': 1, 'task:t2-b': 1 })
  emit('t1-b')
  emit('t2-b')
  await reviewed()
  assert.equal(bench.requests.length, 2)
})

test('HMR discards a late task review and resumes only its unreviewed cursor in the next generation', async t => {
  let release
  const history = { 't1-b': [message(0, 'The user likes tea'), answer(1)], 't2-b': [message(0, 'The user likes short answers'), answer(1)] }
  const first = await setup(t, { history, replies: [changes('The user likes tea'), new Promise(resolve => { release = resolve })] })
  first.emit('t1-b')
  await first.reviewed()
  first.emit('t2-b')
  await until(() => first.bench.requests.length === 2)
  await first.ctx.dispose()
  assert.equal(first.bench.requests[1].signal.aborted, true)
  release(changes('Old generation must not save this'))
  await until(() => first.rt.memoryReviews() === 0)
  assert.deepEqual(JSON.parse(first.read('reviewed.json')), { 'task:t1-b': 1 })
  const next = await setup(t, { home: first.home, history, replies: [changes('The user likes short answers')] })
  next.emit('t1-b')
  next.emit('t2-b')
  await next.reviewed()
  assert.equal(next.bench.requests.length, 1)
  assert.match(next.bench.requests[0].messages[0].content[0].text, /New in task t2/)
  assert.doesNotMatch(next.read(join('bots', 'b', 'MEMORY.md')), /Old generation/)
  assert.deepEqual(JSON.parse(next.read('reviewed.json')), { 'task:t1-b': 1, 'task:t2-b': 1 })
})
