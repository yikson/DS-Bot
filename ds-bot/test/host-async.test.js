import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { asyncScope } from '../src/host/async.js'
import { install as installAgents } from '../src/host/agents.js'
import { appBrowserEndpoint } from '../src/host/browser-plugins.js'
import { install as installModels } from '../src/host/models.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const warnings = []
  const ctx = fakeContext()
  const rt = { ctx, warn: (...args) => warnings.push(args) }
  return { ctx, rt, safe: asyncScope(rt), warnings }
}

const flush = async () => { await setImmediate(); await setImmediate() }

test('emitted listener throws and detached rejections are handled and logged', async (t) => {
  const ctx = new Context()
  const warnings = []
  const safe = asyncScope({ ctx, warn: (...args) => warnings.push(args) })
  t.after(() => ctx.fiber.dispose())
  const unhandled = []
  const capture = error => unhandled.push(error)
  process.on('unhandledRejection', capture)
  t.after(() => process.off('unhandledRejection', capture))
  safe.on('sync-failure', () => { throw new Error('listener threw') })
  safe.on('async-failure', async () => { throw new Error('listener rejected') })
  ctx.emit('sync-failure')
  ctx.emit('async-failure')
  safe.run('detached job', async () => { throw new Error('job rejected') })
  await flush()
  assert.deepEqual(unhandled, [])
  assert.deepEqual(warnings.map(args => args.at(-1).message), ['listener threw', 'listener rejected', 'job rejected'])
})

test('listeners keep their receiver, synchronous results and awaited refusal', async (t) => {
  const { ctx, safe, warnings } = start()
  t.after(() => ctx.dispose())
  const result = {}
  const receiver = {}
  safe.on('middleware', function example(payload, next) {
    assert.equal(this, receiver)
    assert.equal(payload, 'input')
    return next()
  }, { prepend: true })
  const [listener] = ctx.listeners.get('middleware')
  assert.equal(listener.name, 'example')
  assert.equal(listener.length, 2)
  assert.equal(listener.call(receiver, 'input', () => result), result)
  const refused = new Error('tool refused')
  await assert.rejects(listener.call(receiver, 'input', () => { throw refused }), error => error === refused)
  const rejected = Promise.reject(refused)
  assert.equal(listener.call(receiver, 'input', () => rejected), rejected)
  await assert.rejects(rejected, error => error === refused)
  assert.equal(warnings.length, 2)
})

test('timer faults are logged and disposal clears timers, settles waits and stops rescheduling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { ctx, safe, warnings } = start()
  t.after(() => ctx.dispose())
  safe.setTimeout(() => { throw new Error('timeout threw') }, 1)
  safe.setTimeout(async () => { throw new Error('timeout rejected') }, 1)
  const interval = safe.setInterval(async () => {
    safe.clearInterval(interval)
    throw new Error('interval rejected')
  }, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(warnings.length, 3)
  let called = 0
  const clear = t.mock.method(globalThis, 'clearTimeout')
  const clearNow = t.mock.method(globalThis, 'clearImmediate')
  const immediate = safe.setImmediate(() => called++)
  const timeout = safe.setTimeout(() => called++, 100)
  const repeating = safe.setInterval(() => called++, 100)
  const waiting = safe.delay(1000)
  const racing = safe.race(new Promise(() => {}), 1000, 'stopped')
  await ctx.dispose()
  assert.ok(clear.mock.calls.some(call => call.arguments[0] === timeout))
  assert.ok(clear.mock.calls.some(call => call.arguments[0] === repeating))
  assert.ok(clearNow.mock.calls.some(call => call.arguments[0] === immediate))
  assert.equal(await waiting, false)
  assert.equal(await racing, 'stopped')
  assert.equal(safe.stopped, true)
  assert.equal(safe.setTimeout(() => called++, 1), undefined)
  safe.run('stopped job', () => called++)
  t.mock.timers.tick(2000)
  assert.equal(called, 0)
  const next = start()
  next.safe.setTimeout(() => called++, 1)
  t.mock.timers.tick(1)
  assert.equal(called, 1)
  await next.ctx.dispose()
})

test('effect failures cannot skip subsequent cleanup or escape as rejections', async () => {
  const { ctx, safe, warnings } = start()
  let cleaned = false
  safe.effect(() => () => { cleaned = true }, 'kept cleanup')
  safe.effect(() => async () => { throw new Error('cleanup rejected') }, 'broken cleanup')
  safe.effect(() => { throw new Error('setup threw') }, 'broken setup')
  await ctx.dispose()
  assert.equal(cleaned, true)
  assert.deepEqual(warnings.map(args => args.at(-1).message), ['setup threw', 'cleanup rejected'])
})

test('an Agent restriction retry handles a rejected job and does not rearm after dispose', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { ctx, rt, warnings } = start()
  Object.assign(rt, { state: { agents: { a: { id: 'a', sessions: ['s'] } } }, load: async () => {} })
  installAgents(rt)
  rt.indexAgents()
  ctx.emit('agent/created', { agent: { session: { id: 's' } } })
  await flush()
  let attempts = 0
  ctx.tools.schemas = () => { attempts++; throw new Error('schemas rejected') }
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(attempts, 1)
  assert.equal(warnings.at(-1).at(-1).message, 'schemas rejected')
  await ctx.dispose()
  t.mock.timers.tick(10000)
  assert.equal(attempts, 1)
})

test('a provider wait ends when its plugin generation is disposed', async () => {
  const { ctx, rt } = start()
  rt.state = { bots: {} }
  ctx.llm.listModels = async () => []
  installModels(rt)
  const waiting = rt.waitForModel({ model: 'missing/model' })
  await flush()
  await ctx.dispose()
  assert.equal(await waiting, undefined)
})

test('the app browser relay clears its timeout and IPC subscription on dispose', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
  Object.defineProperty(process, 'send', { configurable: true, value: () => {} })
  t.after(() => {
    if (descriptor) Object.defineProperty(process, 'send', descriptor)
    else delete process.send
  })
  const { ctx, safe } = start()
  const before = process.listenerCount('message')
  const waiting = appBrowserEndpoint('bot', [], safe.signal)
  const rejected = assert.rejects(waiting, /DS Bot stopped/)
  assert.equal(process.listenerCount('message'), before + 1)
  await ctx.dispose()
  await rejected
  assert.equal(process.listenerCount('message'), before)
})
