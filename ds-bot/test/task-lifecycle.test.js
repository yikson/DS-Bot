import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setup } from './task-fixture.js'
import { answerSender } from '../src/host/turns.js'
import { asyncScope } from '../src/host/async.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const closeArgs = { status: 'done', conclusion: 'Checked and accepted', evidence: 'commit abc123; tests passed' }
async function opened(t) {
  const f = await setup(t)
  await f.send()
  const task = f.tasks()[0]
  return { ...f, task, close: (args = closeArgs, sessionId = task.sessions.a) => f.rt.closeTask(sessionId, { task: task.id, ...args }),
    settle: async () => answerSender(f.rt, task.sessions.b, f.incoming(task.sessions.b), 'Result with evidence') }
}
test('only the requester task endpoint can close; done requires evidence and settled work', async t => {
  const f = await opened(t)
  for (const id of ['a', 'b', f.task.sessions.b, 'c']) await assert.rejects(f.close(closeArgs, id), /root requester/)
  await assert.rejects(f.close({ status: 'done', conclusion: 'done' }), /evidence/)
  await assert.rejects(f.close(), /dependencies/)
  await f.settle()
  f.handling(f.task.sessions.a, f.incoming(f.task.sessions.a))
  await f.close()
  assert.equal(f.rt.taskOf(f.task.id).state, 'done')
  assert.equal(f.agentOf('a').calls.length, 1)
  assert.equal(f.agentOf('a').calls[0][1].source.role, 'task-conclusion')
  assert.ok(Array.from(f.agentOf('a').calls[0][1].content[0].text).length <= 1000)
  assert.equal(f.agentOf('b').calls.length, 0)
  await f.close()
  assert.equal(f.agentOf('a').calls.length, 1)
  await assert.rejects(f.send(f.task.sessions.a), /not open/)
})
for (const status of ['blocked', 'cancelled', 'failed', 'done']) {
  test(`${status}: late results are idempotent, never reach a trunk or revive the task`, async t => {
    const f = await opened(t)
    const source = f.incoming(f.task.sessions.b)
    if (status === 'done') await f.settle()
    await f.close({ ...closeArgs, status })
    const count = f.agentOf('a').calls.length
    await answerSender(f.rt, f.task.sessions.b, source, 'late one')
    await answerSender(f.rt, f.task.sessions.b, source, 'late replay')
    assert.equal(f.rt.taskOf(f.task.id).lateReplies.count, 1)
    assert.equal(f.rt.taskOf(f.task.id).state, status)
    assert.equal(f.agentOf('a').calls.length, count)
    assert.equal(f.agentOf(f.task.sessions.a).calls.length, status === 'done' ? 1 : 0)
  })
}
test('concurrent close calls enqueue one conclusion and exclude the closing turn', async t => {
  const f = await opened(t)
  await f.settle()
  f.handling(f.task.sessions.a, f.incoming(f.task.sessions.a))
  await Promise.all([f.close(), f.close(), f.close()])
  assert.equal(f.agentOf('a').calls.length, 1)
  assert.equal(f.rt.taskOf(f.task.id).delivery.state, 'delivered')
})
test('another active task turn blocks done, while unrelated shared-trunk work is not cancelled', async t => {
  const f = await opened(t)
  const source = f.incoming(f.task.sessions.b)
  f.handling(f.task.sessions.b, source)
  await f.settle()
  await assert.rejects(f.close(), /dependencies/)
  f.handling('c', { kind: SOURCE_KIND, taskId: 'other', role: 'request', exchangeId: 'other' })
  await f.close({ status: 'cancelled', conclusion: 'stop' })
  assert.ok(f.agentOf(f.task.sessions.b).cancelled)
  assert.equal(f.agentOf('c').cancelled, undefined)
})
test('task pending retries block done and cancellation only removes that task retry', async t => {
  const f = await opened(t)
  await f.settle()
  f.rt.scheduleFailureResume({ args: { taskId: f.task.id, exchangeId: 'retry1', toId: 'a', sessionId: f.task.sessions.a } })
  f.rt.scheduleFailureResume({ args: { exchangeId: 'other', toId: 'c', sessionId: 'c' } })
  await assert.rejects(f.close(), /dependencies/)
  await f.close({ status: 'blocked', conclusion: 'needs input' })
  assert.equal(f.rt.taskFailureResumes(f.task.id), false)
})
test('flush failure after conclusion enqueue recovers without admitting a second copy', async t => {
  const f = await opened(t)
  await f.settle()
  let fail = true
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.flush = async session => {
    if (session.id === 'a' && fail) { fail = false; throw new Error('flush lost') }
    return flush(session)
  }
  await assert.rejects(f.close(), /flush lost/)
  assert.equal(f.rt.taskOf(f.task.id).delivery.state, 'pending')
  await f.rt.recoverTasks()
  assert.equal(f.agentOf('a').calls.length, 1)
  assert.equal(f.rt.taskOf(f.task.id).delivery.state, 'delivered')
})
test('restart observes a consumed conclusion and does not enqueue it again', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const saved = f.saved()
  saved.tasks[f.task.id].delivery.state = 'pending'
  const g = await setup(t, {}, saved)
  const message = f.agentOf('a').calls[0][1]
  g.logs.set('a', [{ type: 'user/message', data: message }])
  await g.rt.recoverTasks()
  await g.rt.recoverTasks()
  assert.equal(g.agentOf('a').calls.length, 0)
  assert.equal(g.rt.taskOf(f.task.id).delivery.state, 'delivered')
})
test('conclusion target rotates while saving; only the final current part is enqueued', async t => {
  const f = await opened(t)
  await f.settle()
  const save = f.rt.save
  let moved = false
  f.rt.save = async options => {
    const result = await save(options)
    if (!moved && f.rt.taskOf(f.task.id)?.delivery?.targetSessionId === 'a') {
      moved = true
      f.rt.botOf('a').sessionId = 'a-next'
      await save(options)
    }
    return result
  }
  await f.close()
  assert.equal(f.agentOf('a').calls.length, 0)
  assert.equal(f.agentOf('a-next').calls.length, 1)
  assert.deepEqual(f.rt.taskOf(f.task.id).delivery.targets.map(target => target.sessionId), ['a', 'a-next'])
})
test('forwarding S0 -> S1 -> S2 dedupes the consumed destination across repeated recovery', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  f.rt.botOf('a').sessionId = 'a-1'
  await f.rt.save({ required: true })
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  f.rt.botOf('a').sessionId = 'a-2'
  await f.rt.save({ required: true })
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  f.agentOf('a-2').inbox.nextTurn.length = 0
  f.logs.get('a-2').push({ type: 'user/message', data: message })
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  assert.equal(f.agentOf('a-2').calls.length, 1)
  assert.deepEqual(f.rt.taskOf(f.task.id).delivery.targets.map(target => target.sessionId), ['a', 'a-1', 'a-2'])
})
test('unreadable recorded conclusion history fails closed without a fresh enqueue', async t => {
  const f = await opened(t)
  await f.settle()
  const inspect = f.ctx.sessionController.inspect
  f.ctx.sessionController.inspect = async id => id === 'a' ? { error: {} } : inspect(id)
  await assert.rejects(f.close(), /history/)
  assert.equal(f.agentOf('a').calls.length, 0)
  assert.equal(f.rt.taskOf(f.task.id).delivery.state, 'pending')
})
test('stopped generation cannot enqueue or acknowledge a conclusion after resolve awaits', async t => {
  const f = await opened(t)
  await f.settle()
  const resolve = f.ctx.sessionController.resolveAgent
  f.ctx.sessionController.resolveAgent = async id => {
    const result = await resolve(id)
    if (id === 'a') asyncScope(f.rt).stop()
    return result
  }
  await assert.rejects(f.close(), /stopped/)
  assert.equal(f.agentOf('a').calls.length, 0)
  assert.notEqual(f.saved().tasks[f.task.id].delivery.state, 'delivered')
})
test('failure to durably save terminal state never enqueues a conclusion', async t => {
  const f = await opened(t)
  await f.settle()
  const save = f.rt.save
  f.rt.save = async options => {
    if (f.rt.taskOf(f.task.id)?.state !== 'open') throw new Error('disk full')
    return save(options)
  }
  await assert.rejects(f.close(), /disk full/)
  assert.equal(f.agentOf('a').calls.length, 0)
})
test('close tool is offered only to the root task endpoint and legacy branch alias', async t => {
  const f = await opened(t)
  await f.settle()
  await f.tool('list_bots', {}, f.task.sessions.a)
  await f.tool('list_bots', {}, f.task.sessions.b)
  assert.equal(f.ctx.registeredTools.has('close_task'), false)
  assert.ok(f.agentOf(f.task.sessions.a).ctx.registeredTools.has('close_task'))
  assert.equal(f.agentOf(f.task.sessions.b).ctx.registeredTools.has('close_task'), false)
  await f.tool('close_task', { ...closeArgs, task: f.task.id }, f.task.sessions.a)
})
