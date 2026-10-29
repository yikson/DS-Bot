import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { asyncScope } from '../../src/host/async.js'
import { mountBrowserPlugin } from '../../src/host/browser/mount.js'
import { createSession } from '../../src/host/browser/session.js'
import { fakeContext } from '../fake-ctx.js'

const scenario = process.argv[2]
const flush = async () => { await yieldTurn(); await yieldTurn() }
const timeouts = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

class Page extends EventEmitter {
  closed = false
  action = null
  perform = async () => {}
  waitForLoadState = async () => {}
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  isClosed() { return this.closed }
  url() { return 'https://example.test/' }
  title = async () => 'Test'
  ariaSnapshot = async () => 'button "Post" [ref=e1]'
  goto = async () => {}
  locator() {
    return {
      count: async () => 1,
      evaluate: async () => this.action,
      click: () => this.perform(),
    }
  }
}

function start() {
  const page = new Page()
  const context = new EventEmitter()
  const pages = [page]
  context.pages = () => pages
  let closes = 0
  const browser = {
    async close() {
      closes++
      for (const page of pages) { page.closed = true; page.emit('close') }
    },
  }
  const warnings = []
  const options = { context, browser, page, actionTimeout: 5000, warn: (...args) => warnings.push(args) }
  return { page, context, pages, options, warnings, closes: () => closes, session: createSession(options) }
}

const env = start()
if (scenario === 'popup-rejection') {
  const popup = new Page()
  const error = new Error('synthetic popup load failure')
  popup.waitForLoadState = async () => { throw error }
  env.pages.push(popup)
  env.context.emit('page', popup)
  // No tool consumes the event's promise until a later event-loop turn.
  await flush()
  await assert.rejects(env.session.tabs(), failure => failure === error)
  assert.equal(env.warnings.at(-1).at(-1), error)
} else if (['request-rejection', 'perform-rejection', 'request-close'].includes(scenario)) {
  env.page.action = { kind: 'post', label: 'Post', origin: 'https://example.test', host: 'example.test' }
  const performed = deferred()
  env.page.perform = async () => {
    const request = {
      url: () => 'https://example.test/post',
      method: () => 'POST',
      failure: () => ({ errorText: 'synthetic request failure' }),
    }
    env.page.emit('request', request)
    if (scenario !== 'request-close') env.page.emit('requestfailed', request)
    performed.resolve()
    await flush()
    if (scenario === 'perform-rejection') throw new Error('synthetic click failure')
  }
  const action = env.session.clickWithOptions('e1')
  await performed.promise
  if (scenario === 'request-close') {
    await flush()
    assert.equal(timeouts(), 1)
    await env.session.close()
  }
  const result = await action
  assert.match(result, /result is unknown/)
  assert.match(result, scenario === 'perform-rejection' ? /synthetic click failure/
    : scenario === 'request-close' ? /abort/i : /synthetic request failure/)
  assert.equal(env.page.listenerCount('request'), 0)
  assert.equal(env.page.listenerCount('requestfailed'), 0)
} else if (scenario === 'script-success') {
  assert.equal(await env.session.runScript('done("ok")'), 'ok')
  env.session.handoff('login', 'Sign in')
  assert.equal(await env.session.runScript('done(resume())'), 'The browser is yours again.')
  assert.equal(timeouts(), 0)
} else if (scenario === 'script-rejection') {
  await assert.rejects(env.session.runScript('throw new Error("script failed")'), /script failed/)
  assert.equal(timeouts(), 0)
} else if (scenario === 'script-dispose') {
  const ctx = fakeContext()
  const lifecycle = asyncScope({ ctx })
  const started = deferred()
  mountBrowserPlugin(ctx, {
    lifecycle,
    toolDefs: [{
      name: 'probe',
      needsBrowser: true,
      execute(_args, { session }) {
        started.resolve()
        return session.runScript('await new Promise(() => {})')
      },
    }],
    defineTool: value => value,
    keyOf: async () => 'bot',
    profileRoot: 'unused',
    openSession: async ({ signal, warn }) => createSession({ ...env.options, signal, warn }),
  })
  ctx.effect(() => lifecycle.stop)
  const running = ctx.registeredTools.get('probe').execute({}, {})
  const rejected = assert.rejects(running, /abort/i)
  await started.promise
  assert.equal(timeouts(), 1)
  await ctx.dispose()
  await rejected
  assert.equal(lifecycle.stopped, true)
  assert.equal(env.closes(), 1)
  assert.equal(timeouts(), 0)
} else if (scenario === 'settle-close') {
  const running = env.session.open('https://example.test/')
  const rejected = assert.rejects(running, /abort/i)
  await flush()
  assert.equal(timeouts(), 1)
  await env.session.close()
  await rejected
} else if (scenario === 'download-close') {
  const performed = deferred()
  env.page.perform = async () => {
    performed.resolve()
    throw new Error('Download is starting')
  }
  const running = env.session.clickWithOptions('e1')
  const rejected = assert.rejects(running, /abort/i)
  await performed.promise
  await flush()
  assert.equal(timeouts(), 1)
  await env.session.close()
  await rejected
} else {
  throw new Error(`Unknown scenario: ${scenario}`)
}
await env.session.close()
assert.equal(env.context.listenerCount('page'), 0)
assert.equal(timeouts(), 0)
console.log(scenario)
