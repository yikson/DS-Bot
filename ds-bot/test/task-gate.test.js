import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { setup } from './task-fixture.js'
import { answerSender } from '../src/host/turns.js'
import { asyncScope } from '../src/host/async.js'
import { deliveryId } from '../src/host/delivery-id.js'

async function opened(t) {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  return { ...f, task, session: task.sessions.b }
}
async function until(check) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return
    await delay(10)
  }
  assert.fail('task operation did not settle')
}
function consume(f) {
  const agent = f.agentOf(f.session)
  const message = agent.inbox.nextTurn.shift()
  f.logs.get(f.session).push({ type: 'user/message', data: message })
  return message
}
for (const flags of [{ retried: true }, { failureResumes: 1 }, { resumed: true }, { deferred: true }]) {
  test(`consumed original task request admits one distinct continuation ${JSON.stringify(flags)}`, async t => {
    const f = await opened(t)
    const original = consume(f)
    const args = { ...Object.values(f.rt.taskOf(f.task.id).sends)[0].args, ...flags }
    await f.rt.deliver(args)
    await f.rt.deliver(args)
    assert.equal(f.agentOf(f.session).calls.length, 2)
    assert.equal(f.incoming(f.session).exchangeId, original.source.exchangeId)
    assert.equal(f.incoming(f.session).replySessionId, f.task.sessions.a)
    assert.notEqual(deliveryId(f.incoming(f.session)), deliveryId(original.source))
    assert.ok(f.rt.state.works[original.source.exchangeId], 'the same work still waits for its result')
  })
}
for (const kind of ['written', 'failure']) {
  test(`real turn settlement delivers ${kind} continuation through task dedupe once`, async t => {
    const f = await opened(t)
    const original = consume(f)
    const timers = [], safe = asyncScope(f.rt), schedule = safe.setTimeout
    safe.setTimeout = (callback, ms, ...args) => {
      if (ms < 59_000 || ms > 60_000) return schedule(callback, ms, ...args)
      timers.push(callback)
      return { unref() {} }
    }
    f.emit(f.session, 'turn/start', { turn: 7 })
    f.emit(f.session, 'user/message', original)
    if (kind === 'written') f.emit(f.session, 'assistant/message', { message: { content: [
      { type: 'text', text: '<tool_call><function=read_file><parameter=path>x</parameter></function></tool_call>' },
    ] } })
    f.emit(f.session, 'turn/end', { turn: 7, reason: kind === 'written' ? { kind: 'completed' }
      : { kind: 'error', error: { code: 'TRANSPORT', message: 'mock offline' } } })
    if (kind === 'failure') { assert.equal(timers.length, 1); timers[0]() }
    await until(() => f.agentOf(f.session).calls.length === 2)
    await f.rt.withTask(f.task.id, async () => {})
    const retry = Object.values(f.rt.taskOf(f.task.id).sends).find(send => send.args.continuationId)
    assert.ok(retry)
    await f.rt.deliver({ ...retry.args })
    assert.equal(f.agentOf(f.session).calls.length, 2)
    assert.equal(f.incoming(f.session).exchangeId, original.source.exchangeId)
    assert.equal(f.incoming(f.session).replySessionId, f.task.sessions.a)
  })
}
test('cold restart continuation executes once and replay of the same interrupted notes is idempotent', async t => {
  const f = await opened(t)
  const original = consume(f)
  const notes = { turns: { [f.session]: { botId: 'b', since: 123, trigger: original.source } }, queued: {} }
  const g = await setup(t, {}, f.saved(), notes)
  g.logs.get(f.session).push(...structuredClone(f.logs.get(f.session)))
  await g.rt.resumeAll()
  await g.rt.resumeAll()
  assert.equal(g.agentOf(f.session).calls.length, 1)
  assert.ok(g.agentOf(f.session).ctx.registeredTools.has('list_tasks'), 'cold resume restores tools before enqueue')
  assert.equal(g.incoming(f.session).exchangeId, original.source.exchangeId)
  const h = await setup(t, {}, g.saved(), notes)
  h.logs.get(f.session).push(...structuredClone(g.logs.get(f.session)))
  await h.rt.resumeAll()
  assert.equal(h.agentOf(f.session).calls.length, 0)
})
test('a new task update cannot replace an unread continuation under the original exchange', async t => {
  const f = await opened(t)
  f.handling(f.session, f.incoming(f.session))
  await f.send(f.session, 'C')
  consume({ ...f, session: 'c' })
  const initial = Object.values(f.rt.taskOf(f.task.id).sends).find(send => send.args.toId === 'c').args
  await f.rt.deliver({ ...initial, retried: true, continuationId: 'written:c:7' })
  const continuation = f.agentOf('c').inbox.nextTurn[0]
  await f.send(f.session, 'C', { message: 'new update' })
  assert.equal(f.agentOf('c').calls.length, 3)
  assert.equal(f.agentOf('c').inbox.nextTurn.length, 2)
  assert.equal(f.agentOf('c').inbox.nextTurn[0].id, continuation.id)
})
test('an old original consumption event cannot discard a queued task continuation on restart', async t => {
  const f = await opened(t)
  const original = consume(f)
  const args = { ...Object.values(f.rt.taskOf(f.task.id).sends)[0].args,
    failureResumes: 1, continuationId: `failure:${f.session}:7` }
  const notes = { turns: {}, queued: { [f.session]: [{ at: Date.now(), args }] } }
  const g = await setup(t, {}, f.saved(), notes)
  g.logs.get(f.session).push(...structuredClone(f.logs.get(f.session)))
  g.emit(f.session, 'user/message', original)
  await g.rt.resumeAll()
  await g.rt.resumeAll()
  assert.equal(g.agentOf(f.session).calls.length, 1)
  assert.equal(g.incoming(f.session).continuationId, args.continuationId)
})
test('a task user-turn continuation without an original exchange keeps its admission id across restart replay', async t => {
  const f = await opened(t)
  const notes = { turns: { [f.task.sessions.a]: { botId: 'a', since: 789 } }, queued: {} }
  const g = await setup(t, {}, f.saved(), notes)
  await g.rt.resumeAll()
  assert.equal(g.agentOf(f.task.sessions.a).calls.length, 1)
  const h = await setup(t, {}, g.saved(), notes)
  h.logs.get(f.task.sessions.a).push(...structuredClone(g.logs.get(f.task.sessions.a)))
  await h.rt.resumeAll()
  assert.equal(h.agentOf(f.task.sessions.a).calls.length, 0)
})
test('HMR restores task tools on the same live Agents without another created event', async t => {
  const f = await opened(t)
  const requester = f.agentOf(f.task.sessions.a), recipient = f.agentOf(f.session)
  const original = consume(f)
  const seed = f.saved()
  const notes = { turns: { [f.session]: { botId: 'b', since: 456, trigger: original.source } }, queued: {} }
  await f.ctx.dispose()
  assert.equal(requester.ctx.registeredTools.has('close_task'), false)
  const g = await setup(t, { taskSessionsEnabled: false, taskSessions: [] }, seed, notes, f.agentOf)
  g.ctx.sessionController.inspect = async id => ({ events: structuredClone(f.logs.get(id) ?? []) })
  assert.equal(g.agentOf(f.task.sessions.a), requester)
  assert.ok(requester.ctx.registeredTools.has('close_task'))
  assert.ok(requester.ctx.registeredTools.has('list_tasks'))
  assert.ok(recipient.ctx.registeredTools.has('list_tasks'))
  assert.equal(recipient.ctx.registeredTools.has('close_task'), false)
  await g.rt.resumeAll()
  await g.rt.resumeAll()
  assert.equal(recipient.calls.length, 2, 'the live Agent receives its HMR continuation once')
  await answerSender(g.rt, f.session, g.incoming(f.session), 'checked')
  await requester.ctx.registeredTools.get('close_task').execute({
    status: 'done', conclusion: 'HMR completed', evidence: 'gate regression',
  }, { agent: requester })
  assert.equal(g.rt.taskOf(f.task.id).state, 'done')
  assert.equal(g.agentOf('a').calls.length, 1)
})
test('permission tightening reaches both Bots owned endpoints across tasks after gate removal', async t => {
  const f = await opened(t)
  await f.send('b', 'A')
  await f.send(f.task.sessions.a, 'C')
  f.rt.config.taskSessionsEnabled = false
  f.rt.config.taskSessions = []
  for (const botId of ['a', 'b']) {
    f.permissions.length = 0
    await f.rt.setPermission(f.rt.botOf(botId), 'read-only')
    assert.deepEqual(new Set(f.permissions.map(([id]) => id)), new Set([botId, ...f.rt.taskSessionsOf(botId)]))
    assert.ok(f.permissions.every(([, preset]) => preset === 'read-only'))
    assert.equal(f.permissions.some(([id]) => id === 'c'), false, 'another participant shared trunk is not changed')
  }
})
test('model and effort changes reach each participant owned endpoint and preserve profile default', async t => {
  const f = await opened(t)
  await f.send('b', 'A')
  f.rt.config.taskSessionsEnabled = false
  f.rt.config.taskSessions = []
  f.ctx.llm = { listProviders: () => [{ id: 'test' }], listModels: async () => [{ id: 'next' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }) }
  for (const botId of ['a', 'b']) for (const effort of ['low', 'high']) {
    const bot = f.rt.botOf(botId)
    bot.model = 'test/next'
    bot.effort = effort
    f.selections.length = 0
    await f.rt.applyModel(bot)
    assert.deepEqual(new Set(f.selections.map(selection => selection.sessionId)), new Set([botId, ...f.rt.taskSessionsOf(botId)]))
    assert.ok(f.selections.every(selection => selection.model === 'next' && selection.reasoningEffort === effort))
    assert.equal(bot.appliedEffort, effort)
    assert.deepEqual(f.restores.at(-1), { provider: 'profile', model: 'default', reasoningEffort: 'low' })
  }
})
for (const invalid of ['relative/folder', '']) {
  test(`opening workdir ${JSON.stringify(invalid)} is rejected before Session creation`, async t => {
    const f = await setup(t)
    await assert.rejects(f.send('a', 'B', { workdir: invalid }), /folder|path/)
    assert.equal(f.forks.length + f.fresh.length, 0)
    assert.equal(f.tasks().length, 0)
  })
}
test('opening workdir uses per-endpoint approval and stops before prompting a denied recipient', async t => {
  const f = await setup(t)
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-gate-project-')))
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 5 }))
  f.rt.dshHome = join(f.home, 'dsh')
  const get = f.ctx.get, approvals = [], moved = []
  f.ctx.get = name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) }
    : name === 'approval' ? { request: async ({ agent }) => { approvals.push(agent.id); return approvals.length === 1 ? 'allowed-once' : 'rejected' } }
      : get(name)
  f.ctx.workingDirectory = { set: async (agent, cwd) => { moved.push([agent.id, cwd]); return cwd } }
  await assert.rejects(f.send('a', 'B', { workdir: path }), /not allowed/)
  assert.equal(approvals.length, 2)
  assert.equal(moved.length, 1)
  assert.equal(f.tasks()[0].workdir, path)
  assert.equal(f.agentOf(f.tasks()[0].sessions.b).calls.length, 0)
  assert.equal(f.rt.botOf('a').workDir, undefined)
  assert.equal(f.rt.botOf('b').workDir, undefined)
})
test('a named opening request includes its workdir in replay/conflict identity', async t => {
  const f = await setup(t)
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-gate-named-')))
  const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-gate-other-')))
  t.after(() => { rmSync(path, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) })
  f.rt.dshHome = join(f.home, 'dsh')
  f.ctx.workingDirectory = { set: async (_agent, cwd) => cwd }
  await f.send('a', 'B', { request_id: 'dir', workdir: path })
  await f.send('a', 'B', { request_id: 'dir', workdir: path })
  assert.equal(f.tasks().length, 1)
  await assert.rejects(f.send('a', 'B', { request_id: 'dir', workdir: other }), /different request/)
  assert.equal(f.forks.length, 1)
  assert.equal(f.tasks()[0].workdir, path)
})
test('guarded opening workdir is refused before any fork or task intent', async t => {
  const f = await setup(t)
  f.rt.dshHome = join(f.home, 'dsh')
  await assert.rejects(f.send('a', 'B', { workdir: f.home }), /DeepSeek Harness data/)
  assert.equal(f.tasks().length, 0)
  assert.equal(f.forks.length + f.fresh.length, 0)
})
