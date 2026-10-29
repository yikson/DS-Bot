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
async function pendingConclusion(t) {
  const f = await opened(t)
  await f.settle()
  const deliver = f.rt.deliver
  f.rt.deliver = async (args, ...rest) => {
    if (args.role === 'task-conclusion') throw new Error('before conclusion attempt')
    return deliver(args, ...rest)
  }
  await assert.rejects(f.close(), /before conclusion attempt/)
  f.rt.deliver = deliver
  return f
}
function retryClock(rt) {
  const safe = asyncScope(rt)
  const set = safe.setTimeout, clear = safe.clearTimeout
  const timers = []
  safe.setTimeout = (callback, ms, ...args) => {
    if (![1000, 2000, 4000, 8000].includes(ms)) return set(callback, ms, ...args)
    const timer = { callback, ms, unref() {} }
    timers.push(timer)
    return timer
  }
  safe.clearTimeout = timer => {
    if (timers.includes(timer)) timer.cancelled = true
    else clear(timer)
  }
  return {
    timers,
    fire: async timer => { if (!timer.cancelled) await timer.callback() },
  }
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
test('the closing turn own request does not block done or produce a second late result', async t => {
  const f = await opened(t)
  await f.settle()
  f.rt.openWork('closing-work', { from: 'b', to: 'a', taskId: f.task.id })
  const source = { kind: SOURCE_KIND, taskId: f.task.id, role: 'request', exchangeId: 'closing-work',
    senderSessionId: 'b', replySessionId: f.task.sessions.b }
  f.handling(f.task.sessions.a, source)
  await f.close()
  await answerSender(f.rt, f.task.sessions.a, source, 'closing turn ended')
  assert.equal(f.rt.taskOf(f.task.id).lateReplies.count, 0)
  assert.equal(f.agentOf('a').calls.length, 1)
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
  await assert.rejects(f.close(), /endpoint changed/)
  await f.rt.recoverTasks()
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
for (const point of ['terminal', 'target', 'ack']) {
  test(`durable ${point} save failure recovers one conclusion without changing terminal identity`, async t => {
    const f = await opened(t)
    await f.settle()
    const save = f.rt.save
    let failed = false
    f.rt.save = async options => {
      const task = f.rt.state.tasks[f.task.id]
      const hit = task.state !== 'open' && (point === 'terminal' ? !task.delivery.targets.length
        : point === 'target' ? task.delivery.targets.length && task.delivery.state === 'pending'
          : task.delivery.state === 'delivered')
      if (!failed && hit) { failed = true; throw new Error(`fault ${point}`) }
      return save(options)
    }
    await assert.rejects(f.close(), new RegExp(`fault ${point}`))
    f.rt.save = save
    await f.rt.recoverTasks()
    await f.rt.recoverTasks()
    assert.equal(f.agentOf('a').calls.length, 1)
    const task = f.rt.taskOf(f.task.id)
    assert.equal(task.conclusion.text, closeArgs.conclusion)
    assert.equal(task.delivery.summaryId, `${task.id}:closed`)
    assert.equal(task.delivery.state, 'delivered')
  })
}
test('generation stops after enqueue and before flush acknowledgement; new generation adopts the durable copy', async t => {
  const f = await opened(t)
  await f.settle()
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.flush = async session => {
    await flush(session)
    if (session.id === 'a') asyncScope(f.rt).stop()
  }
  await assert.rejects(f.close(), /stopped/)
  assert.equal(f.agentOf('a').calls.length, 1)
  assert.notEqual(f.saved().tasks[f.task.id].delivery.state, 'delivered')
  const g = await setup(t, {}, f.saved())
  g.logs.set('a', structuredClone(f.logs.get('a')))
  await g.rt.recoverTasks()
  assert.equal(g.agentOf('a').calls.length, 0)
  assert.equal(g.rt.taskOf(f.task.id).delivery.state, 'delivered')
})
test('send blocked on attachment storage cannot create new work after a terminal commit', async t => {
  const f = await opened(t)
  await f.settle()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const attach = f.rt.attachLong
  f.rt.attachLong = async (...args) => { entered.resolve(); await release.promise; return attach(...args) }
  const sending = f.send(f.task.sessions.a)
  const refused = assert.rejects(sending, /not open/)
  await entered.promise
  await f.close({ status: 'cancelled', conclusion: 'cancel while preparing' })
  release.resolve()
  await refused
  assert.equal(Object.values(f.rt.state.works).filter(work => work.taskId === f.task.id).length, 0)
})
test('shared-trunk T2 remains active when T1 closes and its queued T1 reply becomes late', async t => {
  const f = await opened(t)
  await f.send('a', 'B', { message: 'T2' })
  const other = f.tasks().find(task => task.id !== f.task.id)
  await f.send(f.task.sessions.a, 'C')
  const t1 = f.incoming('c')
  await f.send(other.sessions.a, 'C')
  const t2 = f.incoming('c')
  f.handling('c', t2)
  await f.close({ status: 'cancelled', conclusion: 'cancel T1' })
  assert.equal(f.agentOf('c').cancelled, undefined)
  assert.ok(f.rt.state.works[t2.exchangeId])
  await answerSender(f.rt, 'c', t1, 'late T1')
  assert.equal(f.rt.taskOf(f.task.id).lateReplies.count, 1)
  assert.ok(f.rt.state.works[t2.exchangeId])
  assert.equal(f.rt.taskOf(other.id).state, 'open')
  await answerSender(f.rt, 'c', t2, 'T2 result')
  assert.equal(f.incoming(other.sessions.a).taskId, other.id)
})
test('terminal cancellation rechecks the actual turn after agent resolution', async t => {
  const f = await opened(t)
  f.handling(f.task.sessions.b, f.incoming(f.task.sessions.b))
  const resolve = f.ctx.sessionController.resolveAgent
  f.ctx.sessionController.resolveAgent = async id => {
    const result = await resolve(id)
    if (id === f.task.sessions.b) f.rt.live.set(id, { turn: 99, info: { kind: 'user' } })
    return result
  }
  await f.close({ status: 'cancelled', conclusion: 'cancel exact turn' })
  assert.equal(f.agentOf(f.task.sessions.b).cancelled, undefined)
})
test('recovery never cancels the permitted conclusion follow-up turn', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  f.handling('a', f.incoming('a'))
  await f.rt.recoverTasks()
  assert.equal(f.agentOf('a').cancelled, undefined)
})
test('forwarding target-save failure keeps the source and retries only its stable message id', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  f.rt.botOf('a').sessionId = 'a-next'
  await f.rt.save({ required: true })
  const save = f.rt.save
  let failed = false
  f.rt.save = async options => {
    if (!failed && f.rt.state.tasks[f.task.id].delivery.targetSessionId === 'a-next') {
      failed = true
      throw new Error('migration save')
    }
    return save(options)
  }
  await assert.rejects(f.rt.forwardTaskMessage({ botId: 'a' }, message), /migration save/)
  assert.equal(f.agentOf('a').inbox.nextTurn.length, 1)
  assert.equal(f.agentOf('a-next').calls.length, 0)
  f.rt.save = save
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  assert.equal(f.agentOf('a-next').calls.length, 1)
})
test('forward retry persists its dirty migration target before enqueue', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  f.rt.botOf('a').sessionId = 'a-1'
  await f.rt.save({ required: true })
  const save = f.rt.save
  f.rt.save = async options => {
    if (f.rt.state.tasks[f.task.id].delivery.targetSessionId === 'a-1') throw new Error('migration save')
    return save(options)
  }
  await assert.rejects(f.rt.forwardTaskMessage({ botId: 'a' }, message), /migration save/)
  assert.deepEqual(f.saved().tasks[f.task.id].delivery.targets.map(target => target.sessionId), ['a'])
  f.rt.save = save
  const target = f.agentOf('a-1')
  const followup = target.followup.bind(target)
  target.followup = message => {
    assert.ok(f.saved().tasks[f.task.id].delivery.targets.some(target => target.sessionId === 'a-1'),
      'the target must be on disk at the enqueue boundary')
    followup(message)
  }
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  assert.equal(target.calls.length, 1)
})
test('migration save failure, retry, consumption before ack and restart never redeliver at a newer part', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  f.rt.botOf('a').sessionId = 'a-1'
  await f.rt.save({ required: true })
  const save = f.rt.save
  f.rt.save = async options => {
    if (f.rt.state.tasks[f.task.id].delivery.targetSessionId === 'a-1') throw new Error('migration save')
    return save(options)
  }
  await assert.rejects(f.rt.forwardTaskMessage({ botId: 'a' }, message), /migration save/)
  f.rt.save = save
  f.ctx.sessions.flush = async session => {
    if (session.id !== 'a-1') return
    const agent = f.agentOf('a-1')
    const copy = agent.inbox.nextTurn.shift()
    f.logs.get('a-1').push({ type: 'user/message', data: copy })
    asyncScope(f.rt).stop()
  }
  await assert.rejects(f.rt.forwardTaskMessage({ botId: 'a' }, message), /stopped/)
  assert.equal(f.agentOf('a-1').calls.length, 1)
  const g = await setup(t, {}, f.saved())
  for (const [id, events] of f.logs) g.logs.set(id, structuredClone(events))
  g.rt.botOf('a').sessionId = 'a-2'
  await g.rt.save({ required: true })
  await g.rt.forwardTaskMessage({ botId: 'a' }, message)
  await g.rt.forwardTaskMessage({ botId: 'a' }, message)
  await g.rt.recoverTasks()
  assert.equal(g.agentOf('a-2').calls.length, 0, 'S1 consumed the summary before the crash')
  assert.equal(g.rt.taskOf(f.task.id).delivery.targets.find(target => target.sessionId === 'a-1')?.state, 'delivered')
})
for (const proof of ['consumed', 'splice', 'inbox']) {
  test(`forwarding checks every target's ${proof} even when an earlier source is still pending`, async t => {
    const f = await opened(t)
    await f.settle()
    await f.close()
    const message = f.agentOf('a').calls[0][1]
    f.rt.botOf('a').sessionId = 'a-1'
    await f.rt.save({ required: true })
    await f.rt.forwardTaskMessage({ botId: 'a' }, message)
    const copy = f.agentOf('a-1').inbox.nextTurn.shift()
    if (proof === 'consumed') f.logs.get('a-1').push({ type: 'user/message', data: copy })
    else if (proof === 'inbox') {
      f.logs.set('a-1', [])
      f.agentOf('a-1').inbox.nextTurn.push(copy)
    }
    f.rt.botOf('a').sessionId = 'a-2'
    await f.rt.save({ required: true })
    await f.rt.forwardTaskMessage({ botId: 'a' }, message)
    await f.rt.forwardTaskMessage({ botId: 'a' }, message)
    // A pending copy may migrate once; consumed or durably admitted input may not.
    assert.equal(f.agentOf('a-2').calls.length, proof === 'inbox' ? 1 : 0)
  })
}
test('an unreadable previous target prevents forwarding even when the current target is readable', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  f.rt.botOf('a').sessionId = 'a-next'
  await f.rt.save({ required: true })
  const inspect = f.ctx.sessionController.inspect
  f.ctx.sessionController.inspect = async id => id === 'a' ? { error: {} } : inspect(id)
  await assert.rejects(f.rt.forwardTaskMessage({ botId: 'a' }, message), /history/)
  assert.equal(f.agentOf('a-next').calls.length, 0)
  assert.equal(f.agentOf('a').inbox.nextTurn.length, 1)
})
test('forwarding persists each target again when the trunk rotates during its save', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  f.rt.botOf('a').sessionId = 'a-1'
  const save = f.rt.save
  let moved = false
  f.rt.save = async options => {
    await save(options)
    if (!moved && f.rt.taskOf(f.task.id).delivery.targetSessionId === 'a-1') {
      moved = true
      f.rt.botOf('a').sessionId = 'a-2'
      await save(options)
    }
  }
  const target = f.agentOf('a-2')
  const followup = target.followup.bind(target)
  target.followup = message => {
    assert.ok(f.saved().tasks[f.task.id].delivery.targets.some(target => target.sessionId === 'a-2'))
    followup(message)
  }
  await assert.rejects(f.rt.forwardTaskMessage({ botId: 'a' }, message), /endpoint changed/)
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  assert.equal(f.agentOf('a-1').calls.length, 0)
  assert.equal(target.calls.length, 1)
})
test('continuous conclusion rotation stops after five attempts and releases its lane during 1/2/4/8 second backoff', async t => {
  const f = await pendingConclusion(t)
  const clock = retryClock(f.rt), warnings = [], inspected = []
  f.rt.warn = (...args) => warnings.push(args.map(String).join(' '))
  const inspect = f.ctx.sessionController.inspect
  f.ctx.sessionController.inspect = async id => { inspected.push(id); return inspect(id) }
  const ensure = f.rt.ensureCapabilities
  let rotations = 0, laneTurns = 0
  f.rt.ensureCapabilities = async id => {
    await ensure(id)
    f.rt.botOf('a').sessionId = `rotated-${++rotations}`
    await f.rt.save({ required: true })
  }
  await f.rt.recoverTasks()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await f.rt.withTask(f.task.id, async () => { laneTurns += 1 })
    assert.equal(clock.timers.length, attempt + 1)
    assert.equal(clock.timers[attempt].ms, 1000 * 2 ** attempt)
    await clock.fire(clock.timers[attempt])
  }
  assert.equal(laneTurns, 4)
  assert.equal(rotations, 5)
  assert.equal(inspected.length, 15, 'at most one recorded-target scan per attempt')
  assert.equal(clock.timers.length, 4, 'no sixth automatic attempt')
  assert.equal([...f.logs.values()].flat().filter(event => event.data?.source?.role === 'task-conclusion').length, 0)
  assert.equal(f.saved().tasks[f.task.id].delivery.state, 'pending')
  await f.rt.recoverTasks()
  await f.rt.recoverTasks()
  assert.equal(rotations, 5, 'manual recovery shares the generation budget')
  assert.equal(inspected.length, 15)
  assert.equal(warnings.filter(warning => warning.includes('pending until next startup: retry limit')).length, 1)
  const g = await setup(t, {}, f.saved())
  await g.rt.recoverTasks()
  await g.rt.recoverTasks()
  assert.equal(g.agentOf('rotated-5').calls.length, 1, 'a new generation gets a fresh budget')
  assert.equal(g.rt.taskOf(f.task.id).delivery.state, 'delivered')
})
test('forwarded conclusions share the same attempt cap and never keep scanning a rotating trunk', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const message = f.agentOf('a').calls[0][1]
  const g = await setup(t, {}, f.saved())
  for (const [id, events] of f.logs) g.logs.set(id, structuredClone(events))
  g.agentOf('a').inbox.nextTurn.push(message)
  const clock = retryClock(g.rt), inspected = []
  const inspect = g.ctx.sessionController.inspect
  g.ctx.sessionController.inspect = async id => { inspected.push(id); return inspect(id) }
  const ensure = g.rt.ensureCapabilities
  let rotations = 0
  g.rt.botOf('a').sessionId = 'forward-0'
  await g.rt.save({ required: true })
  g.rt.ensureCapabilities = async id => {
    await ensure(id)
    g.rt.botOf('a').sessionId = `forward-${++rotations}`
    await g.rt.save({ required: true })
  }
  await assert.rejects(g.rt.forwardTaskMessage({ botId: 'a' }, message), /endpoint changed/)
  for (let attempt = 0; attempt < 4; attempt += 1) await clock.fire(clock.timers[attempt])
  assert.equal(rotations, 5)
  assert.equal(inspected.length, 20)
  assert.equal(clock.timers.length, 4)
  assert.equal(g.saved().tasks[f.task.id].delivery.state, 'pending')
  assert.equal(g.agentOf('a').inbox.nextTurn[0].id, message.id, 'the durable source is kept')
  for (let part = 0; part <= 5; part += 1) assert.equal(g.agentOf(`forward-${part}`).calls.length, 0)
  await assert.rejects(g.rt.forwardTaskMessage({ botId: 'a' }, message), /retry limit/)
  assert.equal(inspected.length, 20)
})
test('a stable eighteen-target conclusion scan checks each recorded target once and recognizes consumption', async t => {
  const f = await pendingConclusion(t)
  await f.rt.commitTask(f.task.id, task => {
    task.delivery.targets = Array.from({ length: 17 }, (_, index) => ({ sessionId: `old-${index}`, state: 'pending' }))
    task.delivery.targetSessionId = 'old-16'
    return task
  })
  const g = await setup(t, {}, f.saved())
  g.logs.set('old-8', [{ type: 'user/message', data: { source: { kind: SOURCE_KIND,
    taskId: f.task.id, exchangeId: `${f.task.id}:closed`, role: 'task-conclusion' } } }])
  const inspected = [], inspect = g.ctx.sessionController.inspect
  g.ctx.sessionController.inspect = async id => { inspected.push(id); return inspect(id) }
  await g.rt.recoverTasks()
  assert.equal(inspected.length, 18)
  assert.equal(new Set(inspected).size, 18)
  assert.equal(g.agentOf('a').calls.length, 0)
  assert.equal(g.rt.taskOf(f.task.id).delivery.state, 'delivered')
})
for (const count of [64, 65]) {
  test(`${count} recorded targets cannot bypass the scan limit or lose unverified history`, async t => {
    const f = await pendingConclusion(t)
    await f.rt.commitTask(f.task.id, task => {
      task.delivery.targets = Array.from({ length: count }, (_, index) => ({ sessionId: count === 65 && index === 0 ? 'a' : `old-${index}`, state: 'pending' }))
      task.delivery.targetSessionId = task.delivery.targets[0].sessionId
      return task
    })
    const clock = retryClock(f.rt)
    let reads = 0
    f.ctx.sessionController.inspect = async () => { reads += 1; return { events: [] } }
    await f.rt.recoverTasks()
    for (let attempt = 0; attempt < 4; attempt += 1) await clock.fire(clock.timers[attempt])
    assert.equal(reads, 0)
    assert.equal(f.agentOf('a').calls.length, 0)
    assert.equal(f.saved().tasks[f.task.id].delivery.targets.length, count)
    assert.equal(f.saved().tasks[f.task.id].delivery.state, 'pending')
    assert.equal(clock.timers.length, 4)
  })
}
for (const phase of ['resolve', 'inspect']) {
  test(`an attempt deadline releases a hung ${phase} and prevents its late continuation from enqueueing`, async t => {
    const f = await pendingConclusion(t)
    const clock = retryClock(f.rt)
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), expired = Promise.withResolvers()
    const method = phase === 'resolve' ? 'resolveAgent' : 'inspect'
    const original = f.ctx.sessionController[method], safe = asyncScope(f.rt), race = safe.race
    f.ctx.sessionController[method] = async id => {
      if (id === 'a') { entered.resolve(); await release.promise }
      return original(id)
    }
    safe.race = async (job, ms, value) => {
      assert.equal(ms, 20_000)
      job.catch(() => {})
      await entered.promise
      await expired.promise
      return value
    }
    const recovering = f.rt.recoverTasks()
    await entered.promise
    let passed = false
    const behind = f.rt.withTask(f.task.id, async () => { passed = true })
    expired.resolve()
    await recovering
    await behind
    assert.equal(passed, true)
    assert.equal(f.saved().tasks[f.task.id].delivery.state, 'pending')
    assert.equal(clock.timers.length, 1)
    release.resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.agentOf('a').calls.length, 0)
    f.ctx.sessionController[method] = original
    safe.race = race
    await clock.fire(clock.timers[0])
    assert.equal(f.agentOf('a').calls.length, 1)
  })
}
test('stopping a generation cancels its pending conclusion retry', async t => {
  const f = await pendingConclusion(t)
  const clock = retryClock(f.rt)
  let reads = 0
  f.ctx.sessionController.inspect = async () => { reads += 1; return { error: {} } }
  await f.rt.recoverTasks()
  assert.equal(clock.timers.length, 1)
  const before = reads
  asyncScope(f.rt).stop()
  await clock.fire(clock.timers[0])
  assert.equal(reads, before)
  assert.equal(f.agentOf('a').calls.length, 0)
})
test('removed source inboxes and their old splice records still permit two successive migrations', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  let message = f.agentOf('a').inbox.nextTurn.shift()
  for (const id of ['a-1', 'a-2']) {
    f.rt.botOf('a').sessionId = id
    await f.rt.save({ required: true })
    await f.rt.forwardTaskMessage({ botId: 'a' }, message)
    assert.equal(f.agentOf(id).calls.length, 1)
    message = f.agentOf(id).inbox.nextTurn.shift()
  }
  f.logs.get('a-2').push({ type: 'user/message', data: message })
  f.rt.botOf('a').sessionId = 'a-3'
  await f.rt.save({ required: true })
  await f.rt.forwardTaskMessage({ botId: 'a' }, message)
  assert.equal(f.agentOf('a-3').calls.length, 0)
})
test('an unreadable task stays pending while an independent conclusion and interrupted user turn recover', async t => {
  const f = await opened(t)
  await f.settle()
  await f.send('b', 'A')
  const other = f.tasks().find(task => task.id !== f.task.id)
  await answerSender(f.rt, other.sessions.a, f.incoming(other.sessions.a), 'Other result')
  const deliver = f.rt.deliver
  f.rt.deliver = async (...args) => {
    if (args[0].role === 'task-conclusion') throw new Error('before enqueue')
    return deliver(...args)
  }
  await assert.rejects(f.close(), /before enqueue/)
  await assert.rejects(f.rt.closeTask(other.sessions.b, closeArgs), /before enqueue/)
  const g = await setup(t, {}, f.saved(), { turns: { c: { botId: 'c', since: Date.now() } }, queued: {} })
  const warnings = []
  g.rt.warn = (...args) => warnings.push(args.map(String).join(' '))
  const inspect = g.ctx.sessionController.inspect
  g.ctx.sessionController.inspect = async id => id === 'a' ? { error: {} } : inspect(id)
  await g.rt.resumeAll()
  await g.rt.resumeAll()
  assert.equal(g.rt.taskOf(f.task.id).delivery.state, 'pending')
  assert.equal(g.agentOf('a').calls.length, 0)
  assert.equal(g.rt.taskOf(other.id).delivery.state, 'delivered')
  assert.equal(g.agentOf('b').calls.filter(([, message]) => message.source.role === 'task-conclusion').length, 1)
  assert.equal(g.agentOf('c').calls.filter(([, message]) => message.source.role === 'resume').length, 1)
  assert.ok(warnings.some(warning => warning.includes(f.task.id) && warning.includes('history')))
})
test('one unreadable saved send does not block another delivery in the same task', async t => {
  const f = await opened(t)
  await f.send(f.task.sessions.a, 'C')
  await f.send(f.task.sessions.a, 'D')
  const seed = f.saved()
  const sends = Object.values(seed.tasks[f.task.id].sends)
  for (const send of sends) if (['c', 'd'].includes(send.args.toId)) send.delivery.state = 'pending'
  const g = await setup(t, {}, seed)
  const warnings = []
  g.rt.warn = (...args) => warnings.push(args.map(String).join(' '))
  const inspect = g.ctx.sessionController.inspect
  g.ctx.sessionController.inspect = async id => id === 'c' ? { error: {} } : inspect(id)
  await g.rt.recoverTasks()
  const recovered = Object.values(g.rt.taskOf(f.task.id).sends)
  assert.equal(recovered.find(send => send.args.toId === 'c').delivery.state, 'pending')
  assert.equal(recovered.find(send => send.args.toId === 'd').delivery.state, 'delivered')
  assert.equal(g.agentOf('d').calls.length, 1)
  assert.ok(warnings.some(warning => warning.includes(f.task.id) && warning.includes('history')))
})
test('an unreadable pending send does not abort routing recovery before other sends and ordinary turns', async t => {
  const f = await opened(t)
  await f.send(f.task.sessions.a, 'C')
  await f.send(f.task.sessions.a, 'D')
  const seed = f.saved()
  const task = seed.tasks[f.task.id]
  for (const send of Object.values(task.sends)) {
    if (!['c', 'd'].includes(send.args.toId)) continue
    send.delivery.state = 'pending'
    task.pendingSends[send.args.exchangeId] = { ...send.args, state: 'pending' }
  }
  const g = await setup(t, {}, seed, { turns: { d: { botId: 'd', since: Date.now() } }, queued: {} })
  const inspect = g.ctx.sessionController.inspect
  g.ctx.sessionController.inspect = async id => id === 'c' ? { error: {} } : inspect(id)
  await g.rt.resumeAll()
  const recovered = g.rt.taskOf(task.id)
  assert.deepEqual(Object.values(recovered.pendingSends).map(send => send.toId), ['c'])
  assert.equal(Object.values(recovered.sends).find(send => send.args.toId === 'd').delivery.state, 'delivered')
  assert.equal(g.agentOf('d').calls.filter(([, message]) => message.source.role === 'resume').length, 1)
})
test('a failed creation recovery commit does not block independent interrupted work', async t => {
  const f = await opened(t)
  const seed = f.saved()
  seed.tasks[f.task.id].phase = 'creating'
  const g = await setup(t, {}, seed, { turns: { c: { botId: 'c', since: Date.now() } }, queued: {} })
  const warnings = []
  g.rt.warn = (...args) => warnings.push(args.map(String).join(' '))
  const commit = g.rt.commitTask
  g.rt.commitTask = (id, update) => {
    if (id === f.task.id) throw new Error('creation recovery save unavailable')
    return commit(id, update)
  }
  await g.rt.resumeAll()
  assert.equal(g.rt.taskOf(f.task.id).phase, 'creating')
  assert.equal(g.agentOf('c').calls.filter(([, message]) => message.source.role === 'resume').length, 1)
  assert.ok(warnings.some(warning => warning.includes(f.task.id) && warning.includes('creation recovery save')))
  assert.equal(g.forks.length + g.fresh.length, 0)
})
for (const global of ['stopped', 'read-only']) {
  test(`recovery still aborts for a global ${global} condition`, async t => {
    const f = await opened(t)
    await f.settle()
    const inspect = f.ctx.sessionController.inspect
    f.ctx.sessionController.inspect = async id => {
      if (id === 'a') throw new Error('history temporarily unavailable')
      return inspect(id)
    }
    await assert.rejects(f.close(), /unavailable/)
    f.ctx.sessionController.inspect = async id => {
      if (global === 'stopped') asyncScope(f.rt).stop()
      else f.rt.readOnly = () => 'read-only test host'
      throw new Error(`inspect ${id} failed`)
    }
    await assert.rejects(f.rt.recoverTasks(), global === 'stopped' ? /stopped/ : /read-only/)
    assert.equal(f.agentOf('a').calls.length, 0)
  })
}
test('a durably admitted conclusion removed from the inbox is never re-admitted on restart', async t => {
  const f = await opened(t)
  await f.settle()
  await f.close()
  const saved = f.saved()
  saved.tasks[f.task.id].delivery.state = 'pending'
  const g = await setup(t, {}, saved)
  g.logs.set('a', structuredClone(f.logs.get('a')))
  await g.rt.recoverTasks()
  assert.equal(g.agentOf('a').calls.length, 0)
})
test('ordinary task request forwarding preserves source, caller and task while deduping a consumed target', async t => {
  const f = await opened(t)
  await f.send(f.task.sessions.a, 'C')
  const message = f.agentOf('c').calls[0][1]
  f.rt.botOf('c').sessionId = 'c-next'
  await f.rt.save({ required: true })
  await f.rt.forwardTaskMessage({ botId: 'c' }, message)
  const forwarded = f.agentOf('c-next').calls[0][1]
  assert.deepEqual(forwarded.source, message.source)
  assert.equal(forwarded.source.replySessionId, f.task.sessions.a)
  f.agentOf('c-next').inbox.nextTurn.length = 0
  f.logs.get('c-next').push({ type: 'user/message', data: forwarded })
  await f.rt.forwardTaskMessage({ botId: 'c' }, message)
  assert.equal(f.agentOf('c-next').calls.length, 1)
})
test('named request receipts retain the selected task id without changing replay semantics', async t => {
  const f = await setup(t)
  await f.send('a', 'B', { request_id: 'root' })
  const task = f.tasks()[0]
  await f.send(task.sessions.a, 'B', { request_id: 'followup' })
  assert.deepEqual(Object.values(f.rt.state.requests).map(record => record.taskId), [task.id, task.id])
  const count = f.agentOf(task.sessions.b).calls.length
  await f.send(task.sessions.a, 'B', { request_id: 'followup' })
  assert.equal(f.agentOf(task.sessions.b).calls.length, count)
})
test('merged updates confirm both the operation and the stable original delivery id', async t => {
  const f = await opened(t)
  f.handling(f.task.sessions.b, f.incoming(f.task.sessions.b))
  await f.send(f.task.sessions.b, 'C', { message: 'first child' })
  await f.send(f.task.sessions.b, 'C', { message: 'update child' })
  const sends = Object.values(f.rt.taskOf(f.task.id).sends)
  assert.equal(sends.length, 3)
  assert.equal(sends.every(send => send.delivery.state === 'delivered'), true)
})
test('malformed send identities cannot claim a task or replace its recorded target history', async t => {
  const f = await opened(t)
  const id = Object.keys(f.rt.taskOf(f.task.id).sends)[0]
  await assert.rejects(f.rt.commitTask(f.task.id, task => {
    task.sends[id].args.exchangeId = 'another'
    return task
  }), /send identity/)
  await assert.rejects(f.rt.commitTask(f.task.id, task => {
    task.sends[id].delivery.targets.push({ sessionId: task.sessions.b, state: 'pending' })
    return task
  }), /unique/)
})
for (const removed of ['a', 'b', 'c']) {
  test(`removing participant ${removed} archives only that Bot's owned task Sessions`, async t => {
    const f = await opened(t)
    f.rt.config.taskSessions.push('C')
    await f.send(f.task.sessions.a, 'C')
    const saved = f.rt.taskOf(f.task.id)
    const archived = []
    f.ctx.workspaceRegistry.archiveSession = async id => archived.push(id)
    f.rt.archiveBotMemory = () => Promise.resolve()
    f.rt.forgetBotSecrets = async () => {}
    if (removed === 'a') await f.rt.setMain('d', true, { replace: 'a' })
    await f.rt.deleteBot(removed)
    assert.ok(archived.includes(saved.sessions[removed]))
    for (const [botId, sessionId] of Object.entries(saved.sessions)) if (botId !== removed) assert.equal(archived.includes(sessionId), false)
    assert.equal(f.rt.taskOf(f.task.id).state, 'failed')
  })
}
test('stop_bot includes the target Bot task Sessions', async t => {
  const f = await opened(t)
  f.handling(f.task.sessions.b, f.incoming(f.task.sessions.b))
  await f.tool('stop_bot', { bot: 'B', reason: 'stop task' }, 'a')
  assert.ok(f.agentOf(f.task.sessions.b).cancelled)
  assert.equal(f.agentOf(f.task.sessions.a).cancelled, undefined)
})
test('the complete conclusion includes header, evidence and link in its Unicode bound', async t => {
  const f = await opened(t)
  await f.settle()
  await assert.rejects(f.close({ ...closeArgs, conclusion: 'x'.repeat(1000) }), /at most 1000/)
  await f.close({ ...closeArgs, conclusion: 'Accepted \u{1f680}', link: 'https://example.test/evidence' })
  assert.ok(Array.from(f.agentOf('a').calls[0][1].content[0].text).length <= 1000)
})
test('close_task aliases explicit legacy closure without creating a v2 task', async t => {
  const f = await setup(t, { taskSessionsEnabled: false, taskSessions: [], workBranches: [['A', 'B']] })
  await f.send('a', 'B', { work: 'new' })
  const branch = Object.values(f.rt.botOf('a').workBranches)[0]
  await f.tool('close_task', { status: 'blocked', conclusion: 'legacy conclusion' }, branch.sessionId)
  assert.equal(f.tasks().length, 0)
  assert.equal(branch.state, 'closed')
})
