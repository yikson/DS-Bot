import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOURCE_KIND } from '../src/host/constants.js'
import { setup } from './task-fixture.js'

const ABC = { taskSessions: ['A', 'B', 'C'] }
const taskOf = f => f.tasks().at(-1)
const close = (f, task, args = {}) => f.tool('close_task', Object.fromEntries(Object.entries({ status: 'done', conclusion: 'Shipped', evidence: 'PR 1', ...args }).filter(([, value]) => value !== undefined)), task.sessions.a)
const conclusions = (f, sessionId = 'a') => f.agentOf(sessionId).calls.filter(([, message]) => message.source?.role === 'task-conclusion')

test('a delegation between task-enabled Bots opens a task: fork for the requester, fresh for the assignee', async t => {
  const f = await setup(t)
  const out = await f.send('a', 'B')
  const task = taskOf(f)
  assert.equal(task.state, 'open')
  assert.equal(task.phase, 'ready')
  assert.deepEqual(f.forks.map(fork => [fork.sessionId, fork.atSeq]), [['a', 13]])
  assert.equal(f.fresh.length, 1)
  assert.equal(task.sessions.a, 'fork-1')
  assert.equal(task.sessions.b, 'fresh-1')
  assert.equal(task.participants.a.inheritedThrough, 13)
  const incoming = f.incoming('fresh-1')
  assert.equal(incoming.taskId, task.id)
  assert.equal(incoming.replySessionId, 'fork-1')
  assert.match(f.agentOf('fresh-1').calls.at(-1)[1].content[0].text, new RegExp(`\\[Task: ${task.id}\\]`))
  assert.match(out, new RegExp(`Task: ${task.id}`))
  // Nothing of the task reaches either trunk.
  assert.equal(f.agentOf('b').calls.length, 0)
})

test('a requester trunk with no finished turn starts its task Session fresh', async t => {
  const f = await setup(t)
  f.logs.set('a', [])
  await f.send('a', 'B')
  assert.equal(f.forks.length, 0)
  assert.equal(f.fresh.length, 2)
  assert.equal(taskOf(f).participants.a.kind, 'fresh')
})

test('a Bot outside the task list, a reply to the user and a disabled gate all stay in the trunks', async t => {
  const f = await setup(t)
  await f.send('a', 'C')
  assert.equal(f.tasks().length, 0)
  assert.equal(f.incoming('c').taskId, undefined)
  await f.send('a', 'B', { reply_to: 'user', message: 'tell the user' })
  assert.equal(f.tasks().length, 0)
  f.rt.config.taskSessionsEnabled = false
  await f.send('a', 'B', { message: 'plain delegation' })
  assert.equal(f.tasks().length, 0)
})

test('the assignee reply lands in the requester task Session, not in its trunk', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  const source = f.incoming(task.sessions.b)
  await f.rt.sendTaskAnswer(task.sessions.b, source, 'Done: pack checked')
  const reply = f.incoming(task.sessions.a)
  assert.deepEqual([reply.role, reply.taskId, reply.replyTo], ['reply', task.id, source.exchangeId])
  assert.equal(f.agentOf('a').calls.length, 0)
  assert.equal(f.rt.state.works[source.exchangeId], undefined)
})

test('two open tasks keep their messages apart', async t => {
  const f = await setup(t, ABC)
  await f.send('a', 'B', { message: 'first task' })
  await f.send('a', 'C', { message: 'second task' })
  const [first, second] = f.tasks()
  assert.notEqual(first.sessions.a, second.sessions.a)
  const toB = f.incoming(first.sessions.b)
  const toC = f.incoming(second.sessions.c)
  assert.equal(toB.taskId, first.id)
  assert.equal(toC.taskId, second.id)
  await f.rt.sendTaskAnswer(second.sessions.c, toC, 'second answer')
  await f.rt.sendTaskAnswer(first.sessions.b, toB, 'first answer')
  assert.equal(f.incoming(first.sessions.a).taskId, first.id)
  assert.equal(f.incoming(second.sessions.a).taskId, second.id)
  // A follow-up from inside a task stays in that task.
  f.handling(first.sessions.a, { kind: SOURCE_KIND, role: 'reply', taskId: first.id })
  await f.send(first.sessions.a, 'B', { message: 'one more thing' })
  assert.equal(f.incoming(first.sessions.b).taskId, first.id)
  assert.equal(f.tasks().length, 2)
  await assert.rejects(f.send(first.sessions.a, 'C', { message: 'not in this task' }), /not a task participant/)
})

test('only the requester task Session closes, and done needs evidence', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  assert.equal(f.agentOf(task.sessions.b).ctx.registeredTools.has('close_task'), false)
  await assert.rejects(f.rt.closeTask(task.sessions.b, { task: task.id, status: 'done', conclusion: 'x', evidence: 'y' }), /requester task Session/)
  await assert.rejects(close(f, task, { evidence: undefined }), /evidence/)
  await assert.rejects(close(f, task, { conclusion: 'x'.repeat(1000) }), /at most 1000/)
  await assert.rejects(close(f, task, { link: 'not a link' }), /Link/)
})

test('closing sends one conclusion to the requester trunk, and a restart does not send it again', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  const source = f.incoming(task.sessions.b)
  await f.rt.sendTaskAnswer(task.sessions.b, source, 'checked')
  const out = await close(f, task)
  assert.match(out, /closed as done/)
  const saved = f.rt.taskOf(task.id)
  assert.deepEqual([saved.state, saved.delivery.state], ['done', 'delivered'])
  assert.equal(conclusions(f).length, 1)
  assert.match(conclusions(f)[0][1].content[0].text, /^\[Task closed\]\n/)
  assert.match(conclusions(f)[0][1].content[0].text, /Evidence: PR 1/)
  await f.rt.recoverTasks()
  assert.equal(conclusions(f).length, 1)
  assert.equal(f.saved().tasks[task.id].delivery.state, 'delivered')
  // A new host over the saved team sends nothing again.
  const restarted = await setup(t, {}, f.saved())
  await restarted.rt.resumeAll()
  assert.equal(conclusions(restarted).length, 0)
  assert.equal(restarted.rt.taskOf(task.id).state, 'done')
})

test('a conclusion still pending after a restart is sent once, unless the trunk already holds it', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  Object.assign(f.rt.state.tasks[task.id], { state: 'blocked', closedAt: 1,
    conclusion: { status: 'blocked', text: 'Waiting on access' }, delivery: { summaryId: `${task.id}:closed`, targets: [], state: 'pending' } })
  f.rt.indexSessions()
  await f.rt.recoverTasks()
  assert.equal(conclusions(f).length, 1)
  assert.equal(f.rt.taskOf(task.id).delivery.state, 'delivered')
  // The copy arrived but the delivered mark was lost: nothing is sent twice.
  f.rt.state.tasks[task.id].delivery = { summaryId: `${task.id}:closed`, targets: [], state: 'pending' }
  f.rt.indexSessions()
  await f.rt.recoverTasks()
  assert.equal(conclusions(f).length, 1)
  assert.equal(f.rt.taskOf(task.id).delivery.state, 'delivered')
})

test('a task cut off during setup fails on restart and reports it to the trunk', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  Object.assign(f.rt.state.tasks[task.id], { phase: 'creating' })
  f.rt.indexSessions()
  await f.rt.recoverTasks()
  assert.equal(f.rt.taskOf(task.id).state, 'failed')
  assert.equal(conclusions(f).length, 1)
})

test('removing a participant fails its open task', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  await f.rt.removeTaskBot('b')
  assert.equal(f.rt.taskOf(task.id).state, 'failed')
  assert.match(f.rt.taskOf(task.id).conclusion.text, /was removed/)
  assert.equal(conclusions(f).length, 1)
})

test('a reply that arrives after the task closed is dropped without reaching anyone', async t => {
  const f = await setup(t)
  await f.send('a', 'B')
  const task = taskOf(f)
  const source = f.incoming(task.sessions.b)
  await close(f, task, { status: 'cancelled', evidence: undefined })
  const before = f.agentOf(task.sessions.a).calls.length
  await f.rt.sendTaskAnswer(task.sessions.b, source, 'too late')
  assert.equal(f.agentOf(task.sessions.a).calls.length, before)
})
