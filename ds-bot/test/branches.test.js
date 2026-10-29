import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { answerSender } from '../src/host/turns.js'
import { sourcesIn } from '../src/host/branches.js'
import { answeredIn, install as installResume, LOG_RETRY_MS, RESUME_DELAY_MS } from '../src/host/resume.js'
import { indexRoster } from '../src/client/sources.js'
import { fakeContext } from './fake-ctx.js'

async function setup(t, { enabled = true, seed, logs = new Map(), notes } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-branches-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed ?? {
    version: 1, mainBotIds: ['a'], bots: {
      a: { id: 'a', name: 'ADA', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Cardpack', sessionId: 'b', createdAt: 1 },
      c: { id: 'c', name: 'Other', sessionId: 'c', createdAt: 1 },
    }, rooms: {}, exchanges: [],
  }))
  if (notes) writeFileSync(join(home, 'inflight.json'), JSON.stringify(notes))
  const agents = new Map()
  const forks = []
  const selections = []
  const ctx = fakeContext()
  let api
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = route => { api = route; return register(route) }
  const agentOf = id => {
    if (agents.has(id)) return agents.get(id)
    const events = logs.get(id) ?? []
    logs.set(id, events)
    const agent = { id, status: 'idle', calls: [],
      session: { id, inheritedEventCount: 8, requestHeader: () => ({ config: { provider: 'mock', model: 'test', reasoningEffort: 'high' } }) },
      inbox: { nextStep: [], nextTurn: [], remove(messageId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const at = list.findIndex(message => message.id === messageId)
          if (at !== -1) { list.splice(at, 1); return true }
        }
        return false
      } },
      followup(message) { this.calls.push(message); this.inbox.nextTurn.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) },
      steer(message) { this.calls.push(message); this.inbox.nextStep.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) },
    }
    agents.set(id, agent)
    return agent
  }
  Object.assign(ctx, {
    sessionController: {
      fork: async args => { forks.push(args); return { sessionId: `fork-${forks.length}` } },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async args => { selections.push(args) },
      inspect: async id => ({ events: logs.get(id) ?? [] }),
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, memory: false, workBranches: enabled ? [['ADA', 'Cardpack']] : [] })
  await rt.load()
  const tool = (name, args, id = 'a') => ctx.registeredTools.get(name).execute(args, { agent: agentOf(id) })
  const send = (message = 'Check the pack', id = 'a', extra = {}) => tool('message_bot', { to: id === 'b' ? 'ADA' : 'Cardpack', message, ...extra }, id)
  const branches = () => Object.values(rt.state.bots.a.workBranches ?? {})
  const status = async () => {
    const response = await api.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint: 'state' }),
    }))
    return response.json()
  }
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, data, seq: 20, time: Date.now() })
    }
  }
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, home, logs, agentOf, tool, send, branches, forks, selections, emit, status }
}

test('branch fork failure is retained and never dispatches a task', async t => {
  const f = await setup(t)
  f.ctx.sessionController.fork = async () => { throw new Error('fork failed') }
  await assert.rejects(f.send(), /fork failed/)
  assert.equal(f.branches()[0].state, 'failed')
  assert.equal(f.agentOf('b').calls.length, 0)
})

test('branch creation refuses a Harness without fork', async t => {
  const f = await setup(t)
  delete f.ctx.sessionController.fork
  await assert.rejects(f.send(), /require sessionController.fork/)
  assert.equal(f.branches().length, 0)
})

test('outbound task forks ADA with model and identity and routes the answer to its branch', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  assert.deepEqual(f.forks, [{ sessionId: 'a', allowMigration: false }])
  assert.equal(f.rt.selfOf(branch.sessionId), 'a')
  assert.equal(f.rt.chatOf('a'), 'a')
  assert.equal(branch.inheritedThrough, 7)
  assert.deepEqual(f.selections[0], { sessionId: branch.sessionId, provider: 'mock', model: 'test', reasoningEffort: 'high' })
  const source = f.agentOf('b').calls[0].source
  await answerSender(f.rt, 'b', source, 'Ready')
  assert.equal(f.agentOf(branch.sessionId).calls[0].source.replyTo, source.exchangeId)
  assert.equal(f.agentOf('a').calls.length, 0)
  assert.equal(f.rt.state.works[source.exchangeId], undefined)
})

test('owner selects an existing branch and receives its answer there without another fork', async t => {
  const f = await setup(t)
  await f.send('Task one')
  const branch = f.branches()[0]
  await answerSender(f.rt, 'b', f.agentOf('b').calls[0].source, 'First result')
  // Cardpack's turn took the first request out of its inbox
  f.agentOf('b').inbox.nextStep.length = 0
  f.agentOf('b').inbox.nextTurn.length = 0
  await f.send('Follow up', 'a', { work: branch.id })
  assert.equal(f.forks.length, 1)
  const source = f.agentOf('b').calls.at(-1).source
  assert.equal(source.replySessionId, branch.sessionId)
  await answerSender(f.rt, 'b', source, 'Follow-up result')
  assert.match(f.agentOf(branch.sessionId).calls.at(-1).content[0].text, /Follow-up result$/)
  assert.equal(f.agentOf('a').calls.length, 0)
})

test('owner forks per new task and rejects a work id that is not open', async t => {
  const f = await setup(t)
  await assert.rejects(f.send('Lost', 'a', { work: 'missing' }), /No open work branch "missing"/)
  assert.equal(f.forks.length, 0)
  await f.send('Task one')
  await f.send('Task two')
  assert.equal(f.forks.length, 2)
  await assert.rejects(f.send('Lost', 'a', { work: 'missing' }), /Specify message_bot work/)
  assert.equal(f.forks.length, 2)
})

test('inbound Cardpack request runs in an ADA branch and its answer returns to Cardpack', async t => {
  const f = await setup(t)
  await f.send('Review my work', 'b')
  const branch = f.branches()[0]
  const source = f.agentOf(branch.sessionId).calls[0].source
  assert.equal(f.rt.branchForWork(source.exchangeId), undefined)
  assert.equal(f.agentOf('a').calls.length, 0)
  await answerSender(f.rt, branch.sessionId, source, 'Please clarify')
  const reply = f.agentOf('b').calls[0]
  assert.equal(reply.source.replySessionId, branch.sessionId)
  f.rt.live.set('b', { info: reply.source })
  await f.send('Here is the clarification', 'b')
  assert.equal(f.forks.length, 1)
  assert.equal(f.agentOf(branch.sessionId).calls.length, 2)
})

test('follow-up inside a branch reuses its Session and isolates request receipts', async t => {
  const f = await setup(t)
  await f.send('first')
  const first = f.branches()[0]
  await f.send('details', first.sessionId, { request_id: 'check' })
  await f.send('second')
  const second = f.branches()[1]
  await f.send('details', second.sessionId, { request_id: 'check' })
  assert.equal(f.forks.length, 2)
  assert.equal(Object.keys(f.rt.state.requests).length, 2)
  const count = f.agentOf('b').calls.length
  await f.send('details', first.sessionId, { request_id: 'check' })
  assert.equal(f.agentOf('b').calls.length, count)
})

test('concurrent branches do not merge unread work or cross their answers', async t => {
  const f = await setup(t)
  await Promise.all([f.send('one'), f.send('two')])
  const requests = f.agentOf('b').calls
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0].source.replySessionId, requests[1].source.replySessionId)
  await Promise.all(requests.map((request, i) => answerSender(f.rt, 'b', request.source, `result-${i}`)))
  for (const [i, request] of requests.entries()) {
    const messages = f.agentOf(request.source.replySessionId).calls
    assert.equal(messages.length, 1)
    assert.match(messages[0].content[0].text, new RegExp(`result-${i}$`))
  }
})

test('request_id replay admits one fork including concurrent calls', async t => {
  const f = await setup(t)
  const results = await Promise.all([f.send('same', 'a', { request_id: 'one' }), f.send('same', 'a', { request_id: 'one' })])
  assert.equal(results[0], results[1])
  assert.equal(f.forks.length, 1)
})

test('close delivers exactly one conclusion of at most 1000 Unicode code points', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  const close = () => f.tool('close_work_branch', { status: 'done', conclusion: 'Accepted ✅', link: 'https://example.test/result' }, branch.sessionId)
  await Promise.all([close(), close()])
  const summaries = f.agentOf('a').calls
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].source.role, 'branch-summary')
  assert.ok(Array.from(branch.conclusion.text).length <= 1000)
  assert.ok(Array.from(summaries[0].content[0].text).length <= 1000)
  assert.equal(f.rt.state.exchanges.filter(item => item.role === 'branch-summary').length, 0)
  await assert.rejects(f.tool('close_work_branch', { status: 'done', conclusion: 'x'.repeat(1000) }, branch.sessionId), /at most 1000/)
  await assert.rejects(f.tool('close_work_branch', { status: 'done', conclusion: 'no' }, 'a'), /Only a work branch/)
})

test('closed but undelivered summary is recovered once on restart', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  const deliver = f.rt.deliver
  f.rt.deliver = async args => { if (args.role === 'branch-summary') throw new Error('offline'); return deliver(args) }
  await assert.rejects(f.rt.closeBranch(branch.sessionId, { status: 'done', conclusion: 'accepted' }), /offline/)
  const seed = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
  const restarted = await setup(t, { enabled: false, seed, logs: f.logs })
  await restarted.rt.resumeAll()
  await restarted.rt.resumeAll()
  assert.equal(restarted.agentOf('a').calls.length, 1)
  assert.equal(restarted.branches()[0].summaryDelivered, true)
})

test('summary persisted in inbox before its flag is recovered without a second delivery', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  await f.rt.closeBranch(branch.sessionId, { status: 'done', conclusion: 'accepted' })
  branch.summaryDelivered = false
  const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs })
  await restarted.rt.resumeAll()
  assert.equal(restarted.agentOf('a').calls.length, 0)
  assert.equal(restarted.branches()[0].summaryDelivered, true)
})

test('turn answer is persisted before delivery and closed only after flush, with restart recovery', async t => {
  const f = await setup(t)
  await f.send()
  const source = f.agentOf('b').calls[0].source
  f.ctx.sessions.flush = async () => { throw new Error('flush failed') }
  await assert.rejects(f.rt.sendAnswer('b', source, 'result'), /flush failed/)
  assert.ok(f.rt.state.works[source.exchangeId].pendingAnswer)
  const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs })
  await restarted.rt.resumeAll()
  assert.equal(restarted.rt.state.works[source.exchangeId], undefined)
  assert.equal(restarted.agentOf(f.branches()[0].sessionId).calls.length, 0)
})

test('disabling creation preserves existing branch routing and closure', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  f.rt.config.workBranches = []
  await f.send('follow up', branch.sessionId)
  assert.equal(f.forks.length, 1)
  await f.rt.closeBranch(branch.sessionId, { status: 'blocked', conclusion: 'Need evidence' })
  assert.equal(f.agentOf('a').calls.length, 1)
  await f.send('normal task')
  assert.equal(f.forks.length, 1)
})

test('unconfigured pairs and reply_to user retain the original path', async t => {
  const f = await setup(t)
  await f.tool('message_bot', { to: 'Other', message: 'normal' })
  await f.send('say hello', 'a', { reply_to: 'user' })
  assert.equal(f.forks.length, 0)
  assert.equal(f.agentOf('c').calls[0].source.replySessionId, undefined)
  assert.equal(f.agentOf('b').calls[0].source.audience, 'user')
})

test('branch identity enables read_own_chat, ask_user and show_view', async t => {
  const f = await setup(t)
  await f.send()
  const id = f.branches()[0].sessionId
  assert.doesNotMatch(await f.tool('read_own_chat', {}, id), /Only Bots/)
  await f.tool('ask_user', { question: 'Accept?', options: [{ label: 'Yes' }, { label: 'No' }] }, id)
  assert.equal(f.rt.state.questions[id].question, 'Accept?')
  assert.equal(await f.tool('show_view', { view: { type: 'text', text: 'Result' } }, id), 'The view is on screen.')
  assert.match(f.ctx.sections.get('bot-identity').text({ agent: { id } }), /Work branch/)
})

test('client indexes branch Sessions without treating them as conversation parts', async t => {
  const f = await setup(t)
  await f.send()
  const bot = f.rt.state.bots.a
  const roster = indexRoster({ bots: [bot], rooms: [] })
  assert.equal(roster.byId[f.branches()[0].sessionId], bot)
  assert.equal(bot.parts, undefined)
  assert.equal(sourcesIn([{ type: 'agent/inbox/spliced', data: { inserted: [{ source: { exchangeId: 'x' } }] } }])[0].exchangeId, 'x')
})

test('a pending outbound dispatch is recovered without creating another fork', async t => {
  const f = await setup(t)
  f.rt.deliver = async () => { throw new Error('offline') }
  await assert.rejects(f.send(), /offline/)
  const branch = f.branches()[0]
  assert.ok(branch.pendingDelivery)
  const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs })
  await restarted.rt.resumeAll()
  await restarted.rt.resumeAll()
  assert.equal(restarted.forks.length, 0)
  assert.equal(restarted.agentOf('b').calls.length, 1)
  assert.equal(restarted.branches()[0].pendingDelivery, undefined)
})

test('a restart recovers a pending branch task through the Session controller service', async t => {
  const f = await setup(t)
  f.rt.deliver = async () => { throw new Error('offline') }
  await assert.rejects(f.send(), /offline/)
  const branch = f.branches()[0]
  assert.ok(branch.pendingDelivery)
  const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs })
  // DSH's Session controller is a service: inspect() reads its own ctx, so a host that
  // calls it detached from the service loses `this` instead of getting a rejection.
  const controller = restarted.ctx.sessionController
  controller.ctx = { sessions: { get: id => ({ events: f.logs.get(id) ?? [] }) } }
  controller.inspect = function (id) { return Promise.resolve({ events: this.ctx.sessions.get(id).events }) }
  const warnings = []
  restarted.rt.warn = (format, ...args) => warnings.push([format, ...args].join(' '))
  await restarted.rt.resumeAll()
  assert.deepEqual(warnings.filter(line => /recovering branch/.test(line)), [])
  assert.equal(restarted.branches()[0].state, 'open')
  assert.equal(restarted.branches()[0].pendingDelivery, undefined)
  assert.equal(restarted.agentOf('b').calls.length, 1)
})

test('resuming an interrupted inbound branch preserves execution Session and reply identity', async t => {
  const f = await setup(t)
  await f.send('review', 'b')
  const branch = f.branches()[0]
  const trigger = f.agentOf(branch.sessionId).calls[0].source
  const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs,
    notes: { turns: { [branch.sessionId]: { botId: 'a', trigger, since: Date.now() } }, queued: {} } })
  await restarted.rt.resumeAll()
  const messages = restarted.agentOf(branch.sessionId).calls
  assert.equal(messages.length, 1)
  assert.equal(messages[0].source.resumed, true)
  assert.equal(messages[0].source.senderSessionId, 'b')
  assert.equal(restarted.agentOf('a').calls.length, 0)
  await answerSender(restarted.rt, branch.sessionId, messages[0].source, 'accepted')
  assert.equal(restarted.agentOf('b').calls[0].source.replyTo, trigger.exchangeId)
})

test('steered requests and deferred results stay in the executing branch', async t => {
  const f = await setup(t)
  await f.send('review', 'b')
  const branch = f.branches()[0]
  const id = branch.sessionId
  f.emit(id, 'turn/start', { turn: 1 })
  f.emit(id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] })
  f.emit(id, 'user/message', { source: { kind: 'bot', role: 'request', exchangeId: 'follow', senderSessionId: 'b', replySessionId: 'b' }, content: [{ type: 'text', text: 'clarify' }] })
  f.emit(id, 'user/message', { source: { kind: 'bot', role: 'reply', exchangeId: 'later', senderSessionId: 'b', work: 'different' }, content: [{ type: 'text', text: 'later result' }] })
  f.emit(id, 'turn/end', { reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  const deferred = f.agentOf(id).calls.filter(message => message.source.deferred)
  assert.equal(deferred.length, 2)
  assert.equal(deferred.find(message => message.source.exchangeId === 'follow').source.replySessionId, 'b')
  assert.equal(f.agentOf('a').calls.length, 0)
})

test('a written-tool retry keeps the branch request and its reply target', async t => {
  const f = await setup(t)
  await f.send('review', 'b')
  const branch = f.branches()[0]
  const request = f.agentOf(branch.sessionId).calls[0]
  f.emit(branch.sessionId, 'turn/start', { turn: 1 })
  f.emit(branch.sessionId, 'user/message', request)
  f.emit(branch.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '<tool_call><function=read_file><parameter=path>x</parameter></function></tool_call>' }] } })
  f.emit(branch.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))
  const retry = f.agentOf(branch.sessionId).calls.find(message => message.source.retried)
  assert.ok(retry)
  assert.equal(retry.source.exchangeId, request.source.exchangeId)
  assert.equal(retry.source.senderSessionId, 'b')
  assert.equal(f.agentOf('a').calls.length, 0)
})

test('branch Sessions bypass folder, overflow and idle part switching', async t => {
  const f = await setup(t)
  await f.send()
  const agent = f.agentOf(f.branches()[0].sessionId)
  const before = f.ctx.sessionController.fork
  for (const name of ['agent/pre-step', 'agent/request-error']) {
    for (const listener of f.ctx.listeners.get(name) ?? []) {
      if (listener.length >= 2) await listener({ agent, failure: { code: 'CONTEXT_OVERFLOW' }, signal: AbortSignal.timeout(1000) }, async () => ({ kind: 'reject' }))
    }
  }
  f.ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(f.ctx.sessionController.fork, before)
  assert.deepEqual([...f.rt.switchJobs()], [])
  assert.equal(f.rt.chatOf('a'), 'a')
})

test('permission updates cover existing branches after creation is disabled', async t => {
  const f = await setup(t)
  await f.send()
  const applied = []
  f.ctx.get = name => name === 'permissionPresets' ? {
    resolve: () => ({}), set: session => applied.push(session.id),
  } : undefined
  f.rt.config.workBranches = []
  await f.rt.setPermission(f.rt.state.bots.a, 'full')
  assert.deepEqual(applied, ['a', f.branches()[0].sessionId])
})

test('startup recovery serializes with an in-flight branch dispatch', async t => {
  const f = await setup(t)
  let entered
  let release
  const waiting = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  f.ctx.sessions.flush = async session => {
    if (session.id === 'b') { entered(); await gate }
  }
  const sending = f.send()
  await waiting
  const recovering = f.rt.resumeAll()
  release()
  await Promise.all([sending, recovering])
  assert.equal(f.agentOf('b').calls.length, 1)
  assert.equal(f.branches()[0].pendingDelivery, undefined)
})

test('trunk: close once', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  f.rt.state.bots.a.sessionId = 'a-next'
  f.rt.indexSessions()
  assert.equal(f.rt.chatOf('a'), 'a-next')
  const close = () => f.rt.closeBranch(branch.sessionId, { status: 'done', conclusion: 'Accepted' })
  await Promise.all([close(), close()])
  await close()
  assert.equal(f.agentOf('a').calls.length, 0)
  assert.equal(f.agentOf('a-next').calls.length, 1)
  assert.equal(f.agentOf('a-next').calls[0].source.exchangeId, branch.summaryId)
})

test('trunk: recover once', async t => {
  const f = await setup(t)
  await f.send()
  f.rt.deliver = async () => { throw new Error('offline') }
  await assert.rejects(f.rt.closeBranch(f.branches()[0].sessionId, { status: 'done', conclusion: 'Accepted' }), /offline/)
  const seed = structuredClone(f.rt.state)
  seed.bots.a.sessionId = 'a-next'
  const restarted = await setup(t, { enabled: false, seed, logs: f.logs })
  await restarted.rt.resumeAll()
  await restarted.rt.resumeAll()
  assert.equal(restarted.agentOf('a').calls.length, 0)
  assert.equal(restarted.agentOf('a-next').calls.length, 1)
})

test('trunks: deduplicate', async t => {
  for (const sessionId of ['a', 'a-next']) {
    await t.test(sessionId, async t => {
      const f = await setup(t)
      await f.send()
      const branch = f.branches()[0]
      f.rt.state.bots.a.sessionId = 'a-next'
      f.rt.indexSessions()
      branch.summaryId = `${branch.id}:closed`
      f.logs.set(sessionId, [{ type: 'agent/inbox/spliced', data: { inserted: [{ source: { exchangeId: branch.summaryId } }] } }])
      const inspect = f.ctx.sessionController.inspect
      f.ctx.sessionController.inspect = async id => {
        if (id !== sessionId) throw new Error('other trunk unavailable')
        return inspect(id)
      }
      await f.rt.closeBranch(branch.sessionId, { status: 'done', conclusion: 'Accepted' })
      assert.equal(f.agentOf('a').calls.length + f.agentOf('a-next').calls.length, 0)
      branch.summaryDelivered = false
      const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs })
      await restarted.rt.resumeAll()
      assert.equal(restarted.agentOf('a').calls.length + restarted.agentOf('a-next').calls.length, 0)
      assert.equal(restarted.branches()[0].summaryDelivered, true)
    })
  }
})

test('inbound: reuse one', async t => {
  const f = await setup(t)
  await f.send('Task one')
  const branch = f.branches()[0]
  f.rt.live.set('b', { info: { role: 'request', senderSessionId: 'c', exchangeId: 'unrelated' } })
  await f.send('Clarify the requirement', 'b')
  assert.equal(f.forks.length, 1)
  assert.equal(f.agentOf(branch.sessionId).calls.length, 1)
  assert.equal(f.agentOf('a').calls.length, 0)
  await answerSender(f.rt, branch.sessionId, f.agentOf(branch.sessionId).calls[0].source, 'Details')
  assert.match(f.agentOf('b').calls.at(-1).content[0].text, /Details$/)
})

test('inbound: require work', async t => {
  const f = await setup(t)
  await f.send('Task one')
  await f.send('Task two')
  await assert.rejects(f.send('Clarify', 'b'), error => {
    for (const branch of f.branches()) {
      assert.ok(error.message.includes(branch.id))
      assert.ok(error.message.includes(branch.title))
    }
    return /Specify message_bot work/.test(error.message)
  })
  assert.equal(f.forks.length, 2)
  for (const branch of f.branches()) assert.equal(f.agentOf(branch.sessionId).calls.length, 0)
})

test('work new: fork/replay', async t => {
  const f = await setup(t)
  await f.send('Task one')
  await f.send('Separate task', 'b', { work: 'new', request_id: 'separate' })
  const receipt = await f.send('Separate task', 'b', { work: 'new', request_id: 'separate' })
  assert.equal(f.forks.length, 2)
  assert.ok(receipt.includes(f.branches()[1].id))
  assert.equal(f.agentOf(f.branches()[1].sessionId).calls.length, 1)
  assert.equal(f.agentOf(f.branches()[0].sessionId).calls.length, 0)
})

test('work id: select/replay', async t => {
  const f = await setup(t)
  await f.send('Task one')
  await f.send('Task two')
  const [first, second] = f.branches()
  await f.send('Clarify', 'b', { work: second.id, request_id: 'clarify' })
  await f.send('Clarify', 'b', { work: second.id, request_id: 'clarify' })
  await assert.rejects(f.send('Clarify', 'b', { work: first.id, request_id: 'clarify' }), /different request/)
  assert.equal(f.forks.length, 2)
  assert.equal(f.agentOf(first.sessionId).calls.length, 0)
  assert.equal(f.agentOf(second.sessionId).calls.length, 1)
  await assert.rejects(f.send('Clarify', 'b', { work: 'missing' }), /Specify message_bot work/)
})

test('work: ignored if off', async t => {
  const f = await setup(t, { enabled: false })
  const receipt = await f.send('Normal request', 'b', { work: 'new', request_id: 'normal' })
  assert.equal(await f.send('Normal request', 'b', { work: 'ignored-id', request_id: 'normal' }), receipt)
  assert.equal(f.agentOf('a').calls.length, 1)
  assert.equal(f.agentOf('a').calls[0].source.replySessionId, undefined)
  assert.equal(f.forks.length, 0)
})

test('prompt: open choices', async t => {
  const f = await setup(t)
  await f.send('Task one')
  await f.send('Task two')
  const prompt = id => f.ctx.sections.get('bot-identity').text({ agent: { id } })
  const listed = await f.tool('list_bots', {}, 'b')
  for (const branch of f.branches()) {
    for (const text of [prompt('b'), listed]) {
      assert.ok(text.includes(branch.id))
      assert.ok(text.includes(branch.title))
    }
    assert.ok(!prompt('c').includes(branch.id))
  }
  const closed = f.branches()[0]
  await f.rt.closeBranch(closed.sessionId, { status: 'done', conclusion: 'Accepted' })
  assert.ok(!prompt('b').includes(closed.id))
  assert.ok(!(await f.tool('list_bots', {}, 'b')).includes(closed.id))
})

test('tools: baseline/branch', async t => {
  const f = await setup(t, { enabled: false })
  const baseline = [...f.ctx.registeredTools.keys()].filter(name => name !== 'close_work_branch')
  const served = [...baseline, 'close_work_branch', 'ask_user_question', 'create_goal', 'update_goal', 'get_goal']
  f.ctx.tools.schemas = () => served.map(name => ({ name }))
  const visible = id => {
    const denied = new Set()
    const agent = { id, session: { id }, ctx: { tools: { restrict: ({ deny }) => deny.forEach(name => denied.add(name)) } } }
    f.rt.hideBotUnusedTools(agent)
    return served.filter(name => !denied.has(name))
  }
  assert.deepEqual(visible('a'), baseline)
  assert.deepEqual(visible('b'), baseline)
  f.rt.config.workBranches = [['ADA', 'Cardpack']]
  await f.send()
  f.rt.config.workBranches = []
  assert.deepEqual(visible(f.branches()[0].sessionId), [...baseline, 'close_work_branch'])
  assert.deepEqual(visible('a'), baseline)
})

test('splice: branch only', () => {
  const splice = { type: 'agent/inbox/spliced', data: { inserted: [{ source: { replyTo: 'task' } }] } }
  assert.equal(answeredIn([splice], 'task'), false)
  assert.equal(answeredIn([splice], 'task', true), true)
  assert.equal(answeredIn([{ type: 'user/message', data: { source: { replyTo: 'task' } } }], 'task'), true)
})

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}

function controlledTimers(t, delays = [1000, 2000, 4000]) {
  const timers = []
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  t.mock.method(globalThis, 'setTimeout', (run, delay, ...args) => {
    if (!delays.includes(delay)) return originalSet(run, delay, ...args)
    const timer = { run, delay, unreferenced: false, unref() { this.unreferenced = true } }
    timers.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (timers.includes(timer)) timer.cleared = true
    else originalClear(timer)
  })
  return timers
}

test('a branch log that fails to read once is read again before the branch is closed', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  assert.equal(branch.state, 'open')
  const restarted = await setup(t, { enabled: false, seed: structuredClone(f.rt.state), logs: f.logs })
  const inspect = restarted.ctx.sessionController.inspect
  let reads = 0
  restarted.ctx.sessionController.inspect = async id => {
    if (++reads === 1) throw new Error('the session is still opening')
    return inspect(id)
  }
  const timers = controlledTimers(t, [LOG_RETRY_MS])
  const recovering = restarted.rt.resumeAll()
  await settle(() => timers.some(timer => timer.delay === LOG_RETRY_MS))
  await timers.find(timer => timer.delay === LOG_RETRY_MS).run()
  await recovering
  // Two reads, and the second one is the branch's log: it stays open.
  assert.equal(reads, 2)
  const recovered = restarted.branches()[0]
  assert.deepEqual([recovered.state, recovered.conclusion, recovered.closedAt], ['open', undefined, undefined])
})

test('resume: baseline/disabled', async t => {
  for (const [hasNotes, hasBranches] of [[false, false], [true, false], [false, true]]) {
    await t.test(`${hasNotes}/${hasBranches}`, async t => {
      const home = mkdtempSync(join(tmpdir(), 'ds-bot-resume-timing-'))
      writeFileSync(join(home, 'state.json'), JSON.stringify({ bots: hasBranches ? { a: { workBranches: { task: { state: 'open' } } } } : {} }))
      if (hasNotes) writeFileSync(join(home, 'inflight.json'), JSON.stringify({ turns: { a: { botId: 'a' } } }))
      const ctx = fakeContext()
      t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
      const timers = controlledTimers(t, [RESUME_DELAY_MS])
      let loads = 0
      installResume({ ctx, home, statePath: join(home, 'state.json'), state: { bots: {} },
        load: async () => { loads++ }, deliver: async () => {}, warn() {} })
      assert.equal(loads, 0)
      assert.equal(timers.length, hasNotes || hasBranches ? 1 : 0)
      if (hasNotes || hasBranches) assert.equal(timers[0].unreferenced, true)
    })
  }
})

test('answer: retry/dock', async t => {
  const f = await setup(t)
  await f.send()
  const branch = f.branches()[0]
  const source = f.agentOf('b').calls[0].source
  const timers = controlledTimers(t)
  const deliver = f.rt.deliver
  let attempts = 0
  f.rt.deliver = async args => { if (++attempts === 1) throw new Error('offline'); return deliver(args) }
  await answerSender(f.rt, 'b', source, 'Result')
  assert.ok(f.rt.state.works[source.exchangeId].pendingAnswer.failed)
  assert.equal((await f.status()).value.work.branches[branch.sessionId], 'Delivery failed; retry pending')
  assert.equal(timers[0].delay, 1000)
  assert.equal(timers[0].unreferenced, true)
  await timers[0].run()
  assert.equal(attempts, 2)
  assert.equal(f.agentOf(branch.sessionId).calls.length, 1)
  assert.equal(f.rt.state.works[source.exchangeId], undefined)
  assert.equal((await f.status()).value.work.branches[branch.sessionId], 'Needs close')
})

test('answer: exhaust/restart', async t => {
  const f = await setup(t)
  await f.send()
  const source = f.agentOf('b').calls[0].source
  const timers = controlledTimers(t)
  let attempts = 0
  f.rt.deliver = async () => { attempts++; throw new Error('offline') }
  await answerSender(f.rt, 'b', source, 'Result')
  for (let at = 0; at < 3; at++) await timers[at].run()
  assert.equal(attempts, 4)
  assert.deepEqual(timers.map(timer => timer.delay), [1000, 2000, 4000])
  assert.ok(timers.every(timer => timer.unreferenced))
  const seed = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
  assert.ok(seed.works[source.exchangeId].pendingAnswer.failed)
  const restarted = await setup(t, { enabled: false, seed, logs: f.logs })
  await restarted.rt.resumeAll()
  await restarted.rt.resumeAll()
  assert.equal(restarted.agentOf(f.branches()[0].sessionId).calls.length, 1)
  assert.equal(restarted.rt.state.works[source.exchangeId], undefined)
})

test('answer: reflush once', async t => {
  const f = await setup(t)
  await f.send()
  const source = f.agentOf('b').calls[0].source
  const timers = controlledTimers(t)
  let flushes = 0
  f.ctx.sessions.flush = async () => { if (++flushes === 1) throw new Error('flush failed') }
  await answerSender(f.rt, 'b', source, 'Result')
  assert.ok(f.rt.state.works[source.exchangeId].pendingAnswer)
  await timers[0].run()
  assert.equal(flushes, 2)
  assert.equal(f.agentOf(f.branches()[0].sessionId).calls.length, 1)
  assert.equal(f.rt.state.works[source.exchangeId], undefined)
})

test('answer: dispose', async t => {
  const f = await setup(t)
  await f.send()
  const timers = controlledTimers(t)
  f.rt.deliver = async () => { throw new Error('offline') }
  await answerSender(f.rt, 'b', f.agentOf('b').calls[0].source, 'Result')
  await f.ctx.dispose()
  assert.equal(timers[0].cleared, true)
})
