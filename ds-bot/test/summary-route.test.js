import assert from 'node:assert/strict'
import { format } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { install as installModels } from '../src/host/models.js'
import { install as installParts } from '../src/host/parts.js'
import { fakeContext } from './fake-ctx.js'

const OWN = { provider: 'opus', model: 'main', reasoningEffort: 'high', maxTokens: 64_000 }
const NOTE = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
  .map(name => `## ${name}\n- Saved work`).join('\n\n')
const say = text => ({ role: 'user', content: [{ type: 'text', text }] })

function bench(t, { summaryModel, tokens = 406_000, summaryWindow = 1_000_000, summaryMax = 32_000 } = {}) {
  const requests = []
  const warnings = []
  const selections = []
  const carried = []
  const archived = []
  const bot = { id: 'bot', name: 'Chief', model: 'opus/main', effort: 'high', sessionId: 'current', createdAt: 1,
    segments: [{ sessionId: 'earlier', endedAt: 2, note: 'Earlier saved note' }] }
  const header = { config: { ...OWN }, tools: [{ name: 'read', description: 'Read', parameters: { type: 'object' } }] }
  const messages = [say('Keep this request')]
  const history = { calls: [] }
  const agent = {
    id: 'current',
    session: { id: 'current', requestHeader: () => header, deriveMessages: () => messages, toolHistory: () => history },
    inbox: { nextStep: [], nextTurn: [] },
    whenIdle: async () => {},
    runMaintenance: async run => run(new AbortController().signal),
  }
  const fresh = { id: 'fresh', session: { id: 'fresh' }, inbox: { nextStep: [], nextTurn: [] }, followup: message => carried.push(message) }
  const engine = {
    compactIfNeeded: async () => engine.summarize({ messages, tools: header.tools }, agent),
    compactNow: async () => engine.summarize({ messages, tools: header.tools }, agent),
    compactRegion() {},
    summarize() { throw new Error('The Bot must use its checkpoint hook') },
  }
  const ctx = fakeContext({ services: {
    compaction: engine,
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
  } })
  ctx.llm = {
    listProviders: () => [{ id: 'opus' }, { id: 'deepseek' }],
    listModels: async provider => [{ id: provider === 'opus' ? 'main' : 'long', name: provider === 'opus' ? 'Main' : 'Long Summary' }],
    resolveModelInfo: async provider => ({
      context: { contextWindow: provider === 'opus' ? 400_000 : summaryWindow },
      defaultMaxTokens: provider === 'opus' ? 64_000 : summaryMax,
      reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
    }),
    async* stream(options) {
      requests.push(options)
      const prompt = options.messages.at(-1).content[0].text
      const text = options.system ? '{"action":"compact"}' : prompt.includes('handoff note') ? NOTE : 'Checkpoint saved work'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  ctx.sessionController = { selectModel: async route => { selections.push(route) } }
  ctx.workspaceRegistry = { archiveSession: async id => { archived.push(id) } }
  ctx.sessions = { flush: async () => {} }
  const rt = {
    ctx, config: summaryModel === undefined ? {} : { summaryModel },
    state: { bots: { bot }, switching: {}, questions: {}, exchangeTurns: {} },
    warn: (...args) => warnings.push(format(...args)),
    chatOwners: new Map([['current', 'bot']]), groupOwners: new Map(), pastOwners: new Map(),
    botOf: id => id === 'bot' ? bot : undefined,
    selfOf: id => id === 'current' ? bot : undefined,
    roomOf: () => undefined, chatOf: () => bot.sessionId,
    isBotSession: id => id === bot.sessionId,
    taskSessionsOf: () => [], groupSessionsOf: () => [],
    load: async () => {}, save: async () => {}, readOnly: () => undefined,
    liveOf: () => ({}), tagUsage: messages => messages, ownRequest: () => undefined,
    async* eventsBackwards() {
      yield { type: 'user/message', seq: 1, time: 1, data: { content: messages[0].content, source: { kind: 'user' } } }
    },
    workDirOf: () => undefined, teamFolder: () => undefined,
    createSession: async () => 'fresh', resolveAgent: async id => id === 'current' ? agent : fresh,
    applyPermission: async () => {}, ensureCapabilities: async () => {},
    renewMemory() {}, moveSchedules: async () => {},
  }
  installModels(rt)
  installParts(rt)
  t.after(() => ctx.dispose())
  ctx.emit('agent/created', { agent })
  const summaries = () => requests.filter(request => request.system === undefined)
  const checkpoint = () => engine.summarize({ messages, tools: header.tools }, agent)
  const step = () => ctx.listeners.get('agent/pre-step')[0]({
    agent, step: 1, messages: [], signal: new AbortController().signal,
  }, () => 'normal step')
  const switched = async () => {
    assert.deepEqual(await step(), { kind: 'reject' })
    for (let i = 0; i < 100 && (bot.sessionId !== 'fresh' || [...rt.switchJobs()].length > 0); i += 1) await delay(5)
    assert.equal(bot.sessionId, 'fresh', warnings.join('\n'))
    assert.equal([...rt.switchJobs()].length, 0)
  }
  return { rt, ctx, agent, bot, header, messages, history, requests, warnings, selections, carried, archived, summaries, checkpoint, step, switched }
}

test('summaryModel routes both checkpoints and handoff notes with its own limits and effort', async t => {
  const b = bench(t, { summaryModel: { provider: 'deepseek', model: 'long', effort: 'off' } })
  const result = await b.checkpoint()
  assert.equal(result.provider, 'deepseek')
  assert.equal(result.model, 'long')
  assert.equal(result.maxTokens, 32_000)
  await b.switched()
  assert.equal(b.summaries().length, 3)
  assert.deepEqual(b.summaries().map(request => [request.provider, request.model, request.reasoningEffort, request.maxTokens]),
    [['deepseek', 'long', 'off', 32_000], ['deepseek', 'long', 'off', 32_000], ['deepseek', 'long', 'off', 8_192]])
  for (const request of b.summaries()) {
    assert.equal(request.sessionId, 'current')
    assert.equal(request.purpose, 'compaction')
    assert.deepEqual(request.messages.slice(0, -1), b.messages)
    assert.deepEqual(request.tools, b.header.tools)
    assert.equal(request.toolHistory, b.history)
  }
  assert.equal(b.bot.segments.at(-1).note, NOTE)
  assert.deepEqual(b.archived, ['current'])
  assert.deepEqual(b.header.config, OWN)
  assert.ok(b.selections.every(route => route.provider === OWN.provider && route.model === OWN.model && route.reasoningEffort === OWN.reasoningEffort))
  assert.equal(b.requests.find(request => request.system)?.provider, 'opus')
  assert.equal(b.warnings.length, 0)
})

for (const summaryModel of ['deepseek/long', 'Long Summary']) {
  test(`summaryModel accepts the existing model string form: ${summaryModel}`, async t => {
    const b = bench(t, { summaryModel, tokens: 100_000 })
    await b.checkpoint()
    assert.equal(b.summaries()[0].model, 'long')
    assert.equal(b.summaries()[0].reasoningEffort, undefined)
    assert.equal(b.summaries()[0].maxTokens, 32_000)
  })
}

test('an unknown summaryModel warns at startup and both summaries fall back to the Session route', async t => {
  const b = bench(t, { summaryModel: 'missing/model', tokens: 350_000 })
  for (let i = 0; i < 100 && b.warnings.length === 0; i += 1) await delay(5)
  assert.equal(b.requests.length, 0)
  assert.match(b.warnings[0], /summaryModel is unavailable; using the Session route.*not available/)
  await b.switched()
  assert.equal(b.warnings.length, 1)
  assert.deepEqual(b.summaries().map(request => [request.provider, request.model, request.reasoningEffort]),
    [['opus', 'main', 'high'], ['opus', 'main', 'high']])
  assert.equal(b.bot.segments.at(-1).note, NOTE)
})

test('an invalid summary effort warns and falls back without changing the Session selection', async t => {
  const b = bench(t, { summaryModel: { provider: 'deepseek', model: 'long', effort: 'unknown' }, tokens: 100_000 })
  await b.checkpoint()
  assert.equal(b.summaries()[0].provider, 'opus')
  assert.match(b.warnings[0], /summaryModel is unavailable.*Thinking level unknown/)
  assert.deepEqual(b.header.config, OWN)
})

test('without summaryModel, fitting summaries retain the Session route and its output limit', async t => {
  const b = bench(t, { tokens: 100_000 })
  const result = await b.checkpoint()
  assert.equal(result.maxTokens, OWN.maxTokens)
  assert.deepEqual(b.summaries().map(request => [request.provider, request.model, request.reasoningEffort, request.maxTokens]),
    [['opus', 'main', 'high', OWN.maxTokens]])
  assert.equal(b.warnings.length, 0)
})

test('an oversized Session without summaryModel skips both requests and carries the earlier note', async t => {
  const b = bench(t)
  await assert.rejects(b.checkpoint(), { code: 'bot/summary-overflow' })
  await b.switched()
  assert.equal(b.summaries().length, 0)
  assert.equal(b.warnings.length, 1)
  assert.match(b.warnings[0], /skipping summaries.*opus\/main.*400000-token window/)
  const segment = b.bot.segments.at(-1)
  assert.equal(segment.fallback, 'failed')
  assert.equal(segment.note, 'Earlier saved note')
  assert.equal(segment.noteFrom, 1)
  assert.match(b.carried[0].content[0].text, /Earlier saved note/)
  assert.deepEqual(b.archived, ['current'])
})

test('an unavailable summaryModel also skips an oversized Session fallback route', async t => {
  const b = bench(t, { summaryModel: 'missing/model' })
  await b.switched()
  assert.equal(b.summaries().length, 0)
  assert.equal(b.warnings.filter(warning => warning.includes('summaryModel is unavailable')).length, 1)
  assert.equal(b.warnings.filter(warning => warning.includes('skipping summaries')).length, 1)
  assert.equal(b.bot.segments.at(-1).note, 'Earlier saved note')
})

test('summary requests reserve output within their own window, including the appended prompt', async t => {
  const b = bench(t, { summaryModel: 'deepseek/long', summaryWindow: 410_000 })
  await b.switched()
  assert.equal(b.summaries().length, 2)
  for (const request of b.summaries()) {
    assert.ok(request.maxTokens > 0 && request.maxTokens < 4_000)
  }
  const small = bench(t, { summaryModel: 'deepseek/long', summaryWindow: 400_000 })
  await small.switched()
  assert.equal(small.summaries().length, 0)
  assert.equal(small.bot.segments.at(-1).note, 'Earlier saved note')
})

test('summaryModel leaves normal steps, normal requests and Bot model selection alone', async t => {
  const b = bench(t, { summaryModel: 'deepseek/long', tokens: 100_000 })
  assert.equal(await b.step(), 'normal step')
  const options = { ...OWN, messages: [say('Normal turn')], sessionId: 'current' }
  for (const listener of b.ctx.listeners.get('llm/stream')) {
    assert.equal(listener(options, () => 'normal request'), 'normal request')
  }
  await b.rt.applyModel(b.bot, { force: true })
  assert.deepEqual(options, { ...OWN, messages: [say('Normal turn')], sessionId: 'current' })
  assert.deepEqual(b.selections, [{ sessionId: 'current', provider: 'opus', model: 'main', reasoningEffort: 'high' }])
  assert.equal(b.requests.length, 0)
})
