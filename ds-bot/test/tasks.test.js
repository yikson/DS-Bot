import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { validateTask } from '../src/host/tasks.js'
import { fakeContext } from './fake-ctx.js'

const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/legacy-work-branches.json', import.meta.url), 'utf8'))
const task = (id = 't1') => ({
  id, mode: 'v2', title: 'Check the pack', brief: 'Check the pack and report evidence.',
  requester: 'a', assignee: 'b', state: 'open', phase: 'ready',
  capabilityAtCreation: { requester: true, initialAssignee: true },
  sessions: { a: `${id}-a`, b: `${id}-b`, c: 'c' },
  participants: {
    a: { role: 'requester', kind: 'fork', inheritedThrough: 127 },
    b: { role: 'assignee', kind: 'fresh', initialWorkdir: '/workspace/pack' },
    c: { role: 'participant', kind: 'trunk' },
  },
  workdir: '/workspace/pack', openedAt: 1000, updatedAt: 1000, closedAt: null,
  conclusion: null, creationIntents: {}, pendingSends: {}, lateReplies: { count: 0, ids: [] },
})
const intent = (id, state = 'creating') => ({
  requestId: id, taskId: 't1', botId: 'a', operation: 'fork',
  sourceSessionId: 'a', marker: `t1:a:${id}`, state,
})

async function setup(t, { seed = legacy(), config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-tasks-'))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(seed))
  const ctx = fakeContext()
  const warnings = []
  ctx.logger.warn = (...args) => warnings.push(args)
  const rt = createRuntime(ctx, { home, memory: false, ...config })
  rt.warn = (...args) => warnings.push(args)
  await rt.load()
  const tool = (id = 'a') => ctx.registeredTools.get('list_tasks').execute({}, { agent: { id } })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, home, statePath, warnings, tool }
}

test('legacy main-shaped records stay separate, unchanged and routable without config', async t => {
  const seed = legacy()
  const original = structuredClone(seed.bots.a.workBranches)
  const { rt, tool, statePath } = await setup(t, { seed })
  assert.deepEqual(rt.state.tasks, {})
  assert.deepEqual(rt.state.bots.a.workBranches, original)
  assert.equal(rt.branchOf('sess-open').id, 'br-open')
  assert.equal(rt.branchForWork('br-other').id, 'br-other')
  assert.equal(rt.selfOf('sess-closed'), 'a')
  assert.equal(rt.chatOwners.get('b'), 'b')
  assert.equal(rt.taskBySession.size, 0)
  assert.equal(rt.taskOwners.size, 0)
  assert.equal(rt.taskById.size, 0)
  assert.equal(await tool(), 'No open tasks.')
  const route = await rt.routeBranch(rt.botOf('b'), rt.botOf('a'), 'sess-open', 'follow up', false)
  assert.equal(route.branch.id, 'br-open')
  await rt.save({ required: true })
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).bots.a.workBranches, original)
  // A reverse-direction work never changes the legacy owner into its peer.
  assert.equal(rt.branchOwners.get('sess-open').botId, 'a')
})

test('task records and indexes round-trip, including shared trunks across two tasks', async t => {
  const seed = legacy()
  seed.tasks = { t1: task(), t2: task('t2') }
  const { rt, ctx, statePath, tool } = await setup(t, { seed })
  assert.deepEqual(rt.taskOf('t1'), seed.tasks.t1)
  assert.equal(rt.taskForSession('t1-a').id, 't1')
  assert.deepEqual(rt.taskOwners.get('t2-b'), { taskId: 't2', botId: 'b' })
  assert.equal(rt.taskBySession.get('t2-b'), 't2')
  assert.equal(rt.taskBySession.has('c'), false)
  assert.equal(rt.taskOwners.has('b'), false)
  assert.equal(rt.chatOwners.get('c'), 'c')
  assert.equal(rt.selfOf('t1-a'), 'a')
  assert.match(await tool('t1-a'), /t1.*Check the pack/)
  assert.equal(rt.openTasksOf('c').length, 2)
  await rt.save({ required: true })
  await ctx.dispose()
  const reloaded = await setup(t, { seed: JSON.parse(readFileSync(statePath, 'utf8')) })
  assert.deepEqual(reloaded.rt.state.tasks, seed.tasks)
  assert.equal(reloaded.rt.taskForSession('t2-b').id, 't2')
})

test('list_tasks shows only caller membership and open records, even after config removal', async t => {
  const seed = legacy()
  seed.tasks = { t1: task(), closed: { ...task('closed'), state: 'done', closedAt: 2000 } }
  delete seed.tasks.t1.participants.c
  delete seed.tasks.t1.sessions.c
  const { rt, tool } = await setup(t, { seed, config: { taskSessionsEnabled: true, taskSessions: ['ADA', 'Cardpack'] } })
  rt.config.taskSessionsEnabled = false
  rt.config.taskSessions = []
  assert.match(await tool('a'), /t1/)
  assert.match(await tool('t1-b'), /ADA: requester, fork, t1-a/)
  assert.doesNotMatch(await tool('b'), /closed/)
  assert.equal(await tool('c'), 'No open tasks.')
  assert.equal(await tool('unmanaged'), 'No open tasks.')
  assert.equal(rt.taskOf('closed').state, 'done')
  assert.deepEqual(rt.taskOf('t1').capabilityAtCreation, { requester: true, initialAssignee: true })
})

for (const enabled of [false, true]) {
  for (const [a, b] of [[false, false], [true, false], [false, true], [true, true]]) {
    test(`capability matrix: gate=${enabled}, pair=${Number(a)}${Number(b)}`, async t => {
      const { rt } = await setup(t, { config: { taskSessionsEnabled: enabled, taskSessions: [a && 'ADA', b && 'Cardpack'].filter(Boolean) } })
      assert.deepEqual(rt.taskCapabilitySnapshot('a', 'b'), { requester: a, initialAssignee: b })
      assert.equal(rt.canStartTask('a', 'b'), enabled && a && b)
      assert.equal(rt.canStartTask('a', 'a'), false)
      assert.deepEqual(rt.state.tasks, {})
    })
  }
}

test('task capability defaults off and legacy alias never bypasses the explicit boolean gate', async t => {
  const { rt, warnings } = await setup(t, { config: { workBranches: [['ADA', 'Cardpack']] } })
  assert.deepEqual([...rt.taskCapabilities()].sort(), ['a', 'b'])
  assert.equal(rt.canStartTask('a', 'b'), false)
  rt.config.taskSessionsEnabled = 'true'
  assert.equal(rt.canStartTask('a', 'b'), false)
  rt.config.taskSessionsEnabled = true
  assert.equal(rt.canStartTask('a', 'b'), true)
  assert.equal(warnings.filter(args => String(args[0]).includes('deprecated')).length, 1)
  rt.config.taskSessions = []
  assert.equal(rt.canStartTask('b', 'a'), true)
  rt.config.workBranches = []
  assert.equal(rt.canStartTask('a', 'b'), false)
  assert.deepEqual(rt.state.tasks, {})
})

test('names resolve exactly and uniquely; malformed lists and pairs produce bounded diagnostics', async t => {
  const seed = legacy()
  seed.bots.duplicate = { id: 'duplicate', name: 'Other', sessionId: 'duplicate' }
  const { rt, warnings } = await setup(t, { seed, config: {
    taskSessions: ['ADA', 'ADA', 'ada', 'Missing', 'Other', null, 42],
    workBranches: [['Cardpack', 'ADA'], ['ADA', 'ADA'], ['ADA', 'Missing'], ['Other', 'ADA'], ['ADA'], 'ADA'],
  } })
  assert.deepEqual([...rt.taskCapabilities()].sort(), ['a', 'b'])
  const count = warnings.length
  rt.taskCapabilities()
  assert.equal(warnings.length, count)
  assert.ok(warnings.some(args => String(args[0]).includes('ambiguous')))
  assert.ok(warnings.some(args => String(args[0]).includes('invalid work branch pair')))
  rt.config.taskSessions = 'ADA'
  rt.config.workBranches = {}
  assert.equal(rt.taskCapabilities().size, 0)
  assert.ok(warnings.some(args => String(args[0]).includes('invalid taskSessions list')))
  rt.config.taskSessions = ['ADA']
  rt.botOf('a').name = 'Renamed'
  assert.equal(rt.taskCapabilities().size, 0)
})

test('creation intents persist unknown outcomes and provenance without any Session side effects', async t => {
  const { rt, statePath } = await setup(t)
  const creating = { ...task(), phase: 'creating', sessions: {}, creationIntents: { req: intent('req') } }
  const saved = await rt.commitTask('t1', () => creating)
  saved.title = 'Detached return value'
  assert.equal(rt.taskOf('t1').title, 'Check the pack')
  await rt.commitTask('t1', current => {
    current.creationIntents.req.state = 'unknown'
    current.creationIntents.req.diagnostic = 'Transport stopped after fork'
    return current
  })
  const persisted = JSON.parse(readFileSync(statePath, 'utf8')).tasks.t1
  assert.equal(persisted.creationIntents.req.state, 'unknown')
  assert.equal(persisted.creationIntents.req.sourceSessionId, 'a')
  assert.equal(persisted.creationIntents.req.marker, 't1:a:req')
  const reloaded = await setup(t, { seed: { ...legacy(), tasks: { t1: persisted } } })
  assert.deepEqual(reloaded.rt.taskOf('t1'), persisted)
  await assert.rejects(rt.commitTask('t1', current => {
    current.creationIntents.req.state = 'creating'
    return current
  }), /reconciliation/)
  await assert.rejects(rt.commitTask('t1', current => {
    current.creationIntents.retry = intent('retry')
    return current
  }), /unresolved creation/)
  // Reconciliation may adopt the unique verified Session, but does not create or prompt it.
  await rt.commitTask('t1', current => {
    current.sessions.a = 'adopted-session'
    Object.assign(current.creationIntents.req, { state: 'created', sessionId: 'adopted-session' })
    return current
  })
  assert.equal(rt.taskForSession('adopted-session').id, 't1')
})

test('confirmed failure and fresh fallback are distinct persisted operation identities', async t => {
  const { rt } = await setup(t)
  const value = { ...task(), phase: 'creating', sessions: {},
    creationIntents: { fork: intent('fork', 'failed'), fresh: {
      requestId: 'fresh', taskId: 't1', botId: 'a', operation: 'fresh', marker: 't1:a:fresh', state: 'creating',
    } } }
  value.participants.a = { role: 'requester', kind: 'fresh', inheritedThrough: null }
  await rt.commitTask('t1', () => value)
  assert.equal(rt.taskOf('t1').creationIntents.fork.state, 'failed')
  assert.equal(rt.taskOf('t1').creationIntents.fresh.state, 'creating')
  await assert.rejects(rt.commitTask('t1', current => {
    current.creationIntents.fresh.marker = 'another-marker'
    return current
  }), /identity is immutable/)
})

test('store commits serialize from the latest record and preserve creation identity', async t => {
  const { rt } = await setup(t)
  await rt.commitTask('t1', () => task())
  await Promise.all(Array.from({ length: 3 }, () => rt.commitTask('t1', current => {
    current.updatedAt++
    return current
  })))
  assert.equal(rt.taskOf('t1').updatedAt, 1003)
  await assert.rejects(rt.commitTask('t1', current => {
    current.requester = 'b'
    current.assignee = 'a'
    current.participants.a = { role: 'assignee', kind: 'fresh' }
    current.participants.b = { role: 'requester', kind: 'fresh' }
    return current
  }), /identity is immutable/)
  await assert.rejects(rt.commitTask('t1', current => {
    current.sessions.a = 'replacement'
    return current
  }), /endpoints are immutable/)
  await assert.rejects(rt.commitTask('t1', current => {
    current.participants.c.kind = 'fresh'
    return current
  }), /endpoints are immutable/)
  await rt.commitTask('t1', current => {
    current.sessions.c = 'c-next-part'
    return current
  })
  assert.equal(rt.taskBySession.has('c-next-part'), false)
})

test('failed durable commits reject, retain dirty intent and recover on the next save', async t => {
  const { rt, statePath } = await setup(t)
  await rt.commitTask('t1', () => task())
  const original = readFileSync(statePath, 'utf8')
  const temp = `${statePath}.${process.pid}.tmp`
  mkdirSync(temp)
  await assert.rejects(rt.commitTask('new', () => task('new')), { code: 'EISDIR' })
  assert.equal(rt.taskOf('new').id, 'new')
  assert.equal(rt.taskForSession('new-a').id, 'new')
  await assert.rejects(rt.commitTask('t1', current => ({ ...current, title: 'unsaved' })), { code: 'EISDIR' })
  assert.equal(rt.taskOf('t1').title, 'unsaved')
  assert.equal(readFileSync(statePath, 'utf8'), original)
  rmSync(temp, { recursive: true })
  await rt.commitTask('t1', current => ({ ...current, title: 'saved' }))
  assert.equal(rt.taskOf('t1').title, 'saved')
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).tasks.new.id, 'new')
})

test('stopped generations cannot commit queued mutations or start a new save', async t => {
  const { rt, ctx, statePath } = await setup(t)
  await rt.commitTask('t1', () => task())
  const original = readFileSync(statePath, 'utf8')
  const pending = rt.commitTask('t1', current => ({ ...current, title: 'old generation' }))
  await ctx.dispose()
  await assert.rejects(pending, /stopped/)
  await assert.rejects(rt.commitTask('t2', () => task('t2')), /stopped/)
  assert.equal(readFileSync(statePath, 'utf8'), original)
})

for (const state of ['done', 'blocked', 'cancelled', 'failed']) {
  test(`terminal ${state} stays persisted and cannot reopen`, async t => {
    const { rt } = await setup(t, { seed: { ...legacy(), tasks: { t1: { ...task(), state, closedAt: 2000,
      conclusion: { status: state, text: 'Recorded outcome' },
      delivery: { summaryId: 't1:closed', state: 'pending', targets: [] },
    } } } })
    await assert.rejects(rt.commitTask('t1', current => ({ ...current, state: 'open' })), /terminal task/)
    assert.equal(rt.openTasksOf('a').length, 0)
    assert.equal(rt.taskOf('t1').delivery.summaryId, 't1:closed')
  })
}

test('invalid records are preserved for diagnosis and excluded from indexes', async t => {
  const bad = { ...task('bad'), state: 'waiting' }
  const { rt, statePath } = await setup(t, { seed: { ...legacy(), tasks: { bad } } })
  assert.equal(rt.taskOf('bad'), undefined)
  assert.equal(rt.taskForSession('bad-a'), undefined)
  assert.match(rt.taskDiagnostics.get('bad'), /state or phase/)
  await assert.rejects(rt.commitTask('bad', () => task('bad')), /Invalid task/)
  await rt.save({ required: true })
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).tasks.bad, bad)
})

test('store commits reject async updaters without an unhandled rejection or mutation', async t => {
  const { rt } = await setup(t)
  await assert.rejects(rt.commitTask('t1', async () => { throw new Error('async updater') }), /must be synchronous/)
  assert.equal(rt.taskOf('t1'), undefined)
})

test('a read-only host cannot commit tasks while the writer owns the store', async t => {
  const { rt, home, statePath } = await setup(t)
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other-host' }))
  await rt.refresh()
  const original = readFileSync(statePath, 'utf8')
  assert.match(rt.readOnly(), /another dsh/)
  await assert.rejects(rt.commitTask('t1', () => task()), /another dsh/)
  assert.equal(rt.taskOf('t1'), undefined)
  assert.equal(readFileSync(statePath, 'utf8'), original)
})

test('durable send, conclusion target history and late-result data round-trip verbatim', async t => {
  const value = { ...task(), state: 'cancelled', phase: 'closing', closedAt: 2000,
    conclusion: { status: 'cancelled', text: 'Stopped', link: 'session:t1-a' },
    pendingSends: { send: { exchangeId: 'send', taskId: 't1', callerSessionId: 't1-a', targetSessionId: 'c', state: 'terminal' } },
    delivery: { summaryId: 't1:closed', targetSessionId: 'a-next', state: 'pending',
      targets: [{ sessionId: 'a', state: 'enqueued' }, { sessionId: 'a-next', state: 'pending' }] },
    lateReplies: { count: 1, ids: ['send:reply'], results: [{ exchangeId: 'send', resultId: 'send:reply', sessionId: 'c', at: 2100 }] },
  }
  const { rt, statePath } = await setup(t, { seed: { ...legacy(), tasks: { t1: value } } })
  await rt.save({ required: true })
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).tasks.t1, value)
})

test('invalid task tables are retained and refuse new commits', async t => {
  const { rt, statePath } = await setup(t, { seed: { ...legacy(), tasks: [] } })
  assert.equal(rt.taskById.size, 0)
  assert.match(rt.taskDiagnostics.get('tasks'), /expected a map/)
  await assert.rejects(rt.commitTask('t1', () => task()), /expected a map/)
  await rt.save({ required: true })
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).tasks, [])
})

test('exclusive indexes reject legacy, trunk, group, archived and cross-task collisions', async t => {
  const seed = legacy()
  seed.bots.a.segments = [{ sessionId: 'past-a' }]
  seed.rooms.room = { id: 'room', name: 'Group', named: true, members: ['a'], mode: 'admin', admin: 'a', sessions: { a: 'group-a' } }
  const { rt } = await setup(t, { seed })
  for (const endpoint of ['a', 'b', 'sess-open', 'group-a', 'past-a']) {
    await assert.rejects(rt.commitTask('t1', () => ({ ...task(), sessions: { ...task().sessions, a: endpoint } })), /already owned/)
  }
  rt.botOf('c').sessionId = 'new-trunk-before-save'
  await assert.rejects(rt.commitTask('t1', () => ({ ...task(), sessions: { ...task().sessions, a: 'new-trunk-before-save' } })), /already owned/)
  rt.botOf('c').sessionId = 'c'
  await rt.commitTask('t1', () => task())
  for (const endpoint of ['b', 'sess-open', 'group-a', 'past-a']) {
    const mistakenTrunk = task('mistaken')
    mistakenTrunk.sessions.c = endpoint
    await assert.rejects(rt.commitTask('mistaken', () => mistakenTrunk), /not this Bot's trunk/)
  }
  await assert.rejects(rt.commitTask('t2', () => ({ ...task('t2'), sessions: { ...task('t2').sessions, a: 't1-a' } })), /already owned/)
  const second = task('t2')
  second.sessions.c = 't1-a'
  await assert.rejects(rt.commitTask('t2', () => second), /already owned/)
})

test('conflicting saved task endpoints fail closed regardless of record order', async t => {
  const first = task()
  const second = task('t2')
  second.sessions.c = first.sessions.a
  for (const tasks of [{ t1: first, t2: second }, { t2: second, t1: first }]) {
    const { rt } = await setup(t, { seed: { ...legacy(), tasks } })
    assert.equal(rt.taskBySession.size, 0)
    assert.equal(rt.taskById.size, 0)
    assert.equal(rt.taskDiagnostics.size, 2)
  }
})

test('v2 record validation enforces model invariants without repairing input', () => {
  const changes = [
    value => { value.mode = 'legacy' },
    value => { value.capabilityAtCreation.initialAssignee = false },
    value => { value.assignee = value.requester },
    value => { value.participants.c.role = 'requester' },
    value => { value.participants.a.kind = 'trunk' },
    value => { value.participants.b.kind = 'fork' },
    value => { delete value.sessions.b },
    value => { value.sessions.b = value.sessions.a },
    value => { value.sessions.stranger = 'stranger-session' },
    value => { delete value.participants.a.inheritedThrough },
    value => { value.participants.b.inheritedThrough = 99 },
    value => { value.lateReplies.count = 1 },
    value => { value.lateReplies = { count: 2, ids: ['same', 'same'] } },
    value => { value.creationIntents.req = { ...intent('req'), taskId: 'other' } },
    value => { value.creationIntents.req = { ...intent('req'), sourceSessionId: undefined } },
    value => { value.creationIntents.req = { ...intent('req'), state: 'retry' } },
    value => { value.creationIntents.req = { ...intent('req'), marker: '' } },
    value => { value.creationIntents.req = { ...intent('req'), state: 'created' } },
    value => { value.creationIntents.req = { ...intent('req'), botId: 'c', operation: 'fresh' } },
  ]
  for (const change of changes) {
    const value = task()
    change(value)
    const original = structuredClone(value)
    assert.throws(() => validateTask(value, value.id), /Invalid task/)
    assert.deepEqual(value, original)
  }
})
