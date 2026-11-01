import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setup } from './task-fixture.js'

const textOf = message => message.content.map(block => block.text ?? '').join('')
const reports = (f, sessionId = 'a') => f.agentOf(sessionId).calls.filter(([, message]) => message.source?.role === 'worker-report')
  .map(([, message]) => textOf(message))
async function started(t, config = {}) {
  const f = await setup(t, config)
  const workdir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-dir-'))
  t.after(() => rmSync(workdir, { recursive: true, force: true }))
  const out = await f.tool('start_worker', { title: 'Fix the build', brief: 'Make npm test pass.', workdir })
  const worker = Object.values(Object.values(f.rt.state.agents)[0].workers)[0]
  return { ...f, out, worker }
}

test('a Bot starts a worker: a DSH Agent Session in its folder, with the brief as its first message', async t => {
  const f = await started(t, { workerPreset: 'worker' })
  const { worker } = f
  assert.match(f.out, new RegExp(`Worker ${worker.id} started`))
  assert.deepEqual([worker.state, worker.botId, worker.dispatcherSessionId], ['running', 'a', 'a'])
  assert.equal(f.rt.agentOf(worker.sessionId)?.workers[worker.id], worker)
  assert.equal(f.saved().agents[Object.keys(f.rt.state.agents)[0]].workers[worker.id].title, 'Fix the build')
  assert.equal(f.titles.at(-1)[1], 'worker · Fix the build')
  const brief = f.agentOf(worker.sessionId).calls.at(-1)[1]
  assert.match(textOf(brief), /^\[Worker brief from A\]\nTitle: Fix the build\n\nMake npm test pass\./)
  assert.match(textOf(brief), /call worker_report once/)
  assert.equal(f.agentOf(worker.sessionId).ctx.registeredTools.has('worker_report'), true)
  assert.equal(f.agentOf('a').ctx.registeredTools.has('worker_report'), false)
})

test('the report goes once to the dispatching Session as a card, and ends the job', async t => {
  const f = await started(t)
  const { worker } = f
  const out = await f.tool('worker_report', { state: 'ready', summary: 'Tests pass now.', evidence: 'npm test: 0 failures' }, worker.sessionId)
  assert.match(out, /Reported ready to A/)
  assert.deepEqual(reports(f), [[
    '[Worker report]', `worker · Fix the build — ready`, `Worker: ${worker.id} · Session: ${worker.sessionId}`,
    'Summary: Tests pass now.', 'Evidence: npm test: 0 failures',
  ].join('\n')])
  assert.equal(worker.state, 'ready')
  assert.equal(worker.delivered, true)
  await assert.rejects(f.tool('worker_report', { state: 'ready', summary: 'again' }, worker.sessionId), /already ended/)
  await assert.rejects(f.tool('message_worker', { worker: worker.id, message: 'more' }), /has ended/)
})

test('a blocked worker asks one question, and the dispatcher answers with message_worker', async t => {
  const f = await started(t)
  const { worker } = f
  await assert.rejects(f.tool('worker_report', { state: 'blocked', summary: 'Stuck' }, worker.sessionId), /needs the question/)
  await f.tool('worker_report', { state: 'blocked', summary: 'Two fixes possible.', question: 'Pin the old version or upgrade?' }, worker.sessionId)
  assert.match(reports(f)[0], /— blocked\n[\s\S]*Question: Pin the old version or upgrade\?/)
  assert.equal(worker.state, 'blocked')
  await f.tool('message_worker', { worker: worker.id, message: 'Upgrade.' })
  assert.equal(textOf(f.agentOf(worker.sessionId).calls.at(-1)[1]), '[Message from A]\nUpgrade.')
  assert.equal(worker.state, 'running')
})

test('list_workers shows only the caller\'s workers, and stop_worker cancels and ends one', async t => {
  const f = await started(t)
  const { worker } = f
  assert.match(await f.tool('list_workers', {}), new RegExp(`${worker.id} — Fix the build \\(running`))
  assert.equal(await f.tool('list_workers', {}, 'b'), 'No workers.')
  await assert.rejects(f.tool('stop_worker', { worker: worker.id }, 'b'), /No worker/)
  f.agentOf(worker.sessionId).status = 'running'
  assert.match(await f.tool('stop_worker', { worker: worker.id }), /stopped/)
  assert.deepEqual(f.agentOf(worker.sessionId).cancelled, { kind: 'hook', reason: 'ds-bot/worker-stopped' })
  assert.equal(worker.state, 'stopped')
})

test('a worker turn that ends without a report sends its last words to the dispatcher', async t => {
  const f = await started(t)
  const { worker } = f
  f.emit(worker.sessionId, 'turn/start', { turn: 1 })
  f.emit(worker.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'I think it is done.' }] } })
  f.emit(worker.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(reports(f)[0], /— waiting\n[\s\S]*Ended its turn without a report\. Last words: I think it is done\./)
  assert.equal(worker.state, 'running')
  // A turn that reported sends nothing more when it ends.
  f.emit(worker.sessionId, 'turn/start', { turn: 2 })
  await f.tool('worker_report', { state: 'dropped', summary: 'Already fixed upstream.' }, worker.sessionId)
  f.emit(worker.sessionId, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(reports(f).length, 2)
})

test('a transient model failure is retried before the worker is reported failed', async t => {
  const f = await started(t)
  const { worker } = f
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fail = turn => {
    f.emit(worker.sessionId, 'turn/start', { turn })
    f.emit(worker.sessionId, 'turn/end', { turn, reason: { kind: 'error', error: { code: 'TRANSPORT', message: 'offline' } } })
  }
  const before = f.agentOf(worker.sessionId).calls.length
  fail(1)
  t.mock.timers.tick(15_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.match(textOf(f.agentOf(worker.sessionId).calls.at(-1)[1]), /model connection failed \(TRANSPORT\)/)
  assert.equal(f.agentOf(worker.sessionId).calls.length, before + 1)
  t.mock.timers.reset()
  for (const turn of [2, 3, 4]) fail(turn)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.match(reports(f).at(-1), /— failed\n[\s\S]*model call failed \(TRANSPORT: offline\)/)
  assert.equal(worker.state, 'failed')
})

test('only Bots manage workers, and a restart delivers a missed report and nudges running workers', async t => {
  const f = await started(t)
  const { worker } = f
  await assert.rejects(f.tool('start_worker', { title: 'x', brief: 'y' }, worker.sessionId), /Only Bots/)
  const saved = f.saved()
  const host = Object.values(saved.agents)[0]
  host.workers[worker.id].report = { state: 'ready', summary: 'Done before the restart.' }
  host.workers[worker.id].reports = 1
  host.workers[worker.id].delivered = false
  host.workers.w2 = { ...host.workers[worker.id], id: 'w2', sessionId: 'agent-w2', state: 'running', report: undefined, delivered: undefined }
  const restarted = await setup(t, {}, saved)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.match(reports(restarted)[0], /Done before the restart\./)
  assert.match(textOf(restarted.agentOf('agent-w2').calls.at(-1)[1]), /DeepSeek Harness restarted/)
})
