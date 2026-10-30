import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { fakeContext } from './fake-ctx.js'

// These peers are linked beside tools, rather than the base bundle in a checkout.
const toolPeers = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
const { PtcRuntime } = toolPeers('@deepseek-ai/dsh-ptc-runtime')
const { createScope } = toolPeers('@deepseek-ai/dsh-scope')

const REFUSAL = 'DSH Agent Sessions cannot use DS Bot team tools.'
const TEAM = {
  version: 1, revision: 1, mainBotIds: ['chief'],
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', instructions: '', createdAt: 1 } },
  rooms: {},
  agents: { dsh: { id: 'dsh', name: 'DSH Agent', sessions: ['owned'], createdAt: 1 } },
}

// Use the real PTC binding/scheduler with an in-process program runner.
class GateRuntime extends PtcRuntime {
  language = 'typescript'
  isolation = 'test'
  resolve(request) { return { ...request, cwd: process.cwd(), timeoutMs: 1000 } }
  async run(request) {
    await request.bindings[0].functions.list_bots({})
    return { logs: [] }
  }
}

async function setup(t, { team = TEAM, ptc = false, beforeStart } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agent-gate-'))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(team))
  beforeStart?.(statePath)
  const ctx = new Context()
  ctx.provide('workingDirectory', { ensure: async () => home })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: ptc ? 'ptc' : 'native' })
  if (ptc) await ctx.plugin(GateRuntime)
  const recordings = []
  const warnings = []
  const install = () => {
    const recorded = fakeContext()
    recorded.logger.warn = (...args) => warnings.push(args.join(' '))
    const rt = createRuntime(recorded, { home, github: false, diagnosticsFile: false })
    const stops = [
      ...(recorded.listeners.get('tools/pre-execute') ?? []).map(policy => ctx.on('tools/pre-execute', policy)),
      ...recorded.guards.map(guard => ctx.tools.guard(guard)),
    ]
    recordings.push(recorded)
    return { rt, recorded, dispose: async () => { stops.forEach(stop => stop()); await recorded.dispose() } }
  }
  const plugin = install()
  const ran = []
  const register = (owner, name) => owner.tools.register(defineTool({
    name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => { ran.push(name); return 'executed' },
  }))
  for (const name of [...TEAM_TOOLS, 'read']) register(ctx, name)
  // A later policy that allows the call cannot override the guard.
  ctx.on('tools/pre-execute', async (_exec, next) => { await next(); return { kind: 'allow' } })
  const agent = { id: 'owned', session: { id: 'owned', header: { cwd: home }, append() {} }, ctx }
  let scope
  await ctx.plugin(Object.assign((inner) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
  agent.ctx = scope.ctx
  const execute = (name = 'list_bots', caller = agent) => ctx.tools.execute({
    name, callId: ToolCallId('gate'), signal: new AbortController().signal,
    arguments: name === 'run_code' ? { code: 'return await tools.list_bots({})', description: 'Check the team-tool gate' } : {},
    ...(caller === undefined ? {} : { agent: caller }),
  })
  t.after(async () => {
    await ctx.fiber.dispose()
    for (const recorded of recordings) await recorded.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { ...plugin, ctx, home, statePath, warnings, agent, execute, ran, register, install }
}

function failRead(t, statePath) {
  const original = fsp.readFile
  let failing = true
  const restore = () => { fsp.readFile = original; syncBuiltinESMExports() }
  fsp.readFile = async (path, ...args) => {
    if (failing && path === statePath) throw Object.assign(new Error('synthetic read failure'), { code: 'EACCES' })
    return original(path, ...args)
  }
  syncBuiltinESMExports()
  t.after(restore)
  return () => { failing = false }
}

const denied = (result) => {
  assert.equal(result.isError, true)
  assert.equal(result.error.message, REFUSAL)
}

test('the first request denies every team tool before schema restriction lands', async (t) => {
  const { execute, ran, rt, agent } = await setup(t)
  // The asynchronous agent/created restriction is deliberately not run.
  assert.equal(rt.agentOf(agent.id), undefined)
  for (const name of TEAM_TOOLS) denied(await execute(name))
  assert.equal((await execute('read')).isError, false)
  assert.deepEqual(ran, ['read'])
})

test('creation and adoption deny team tools even while schema restriction keeps failing', async (t) => {
  const { rt, agent, execute, ran } = await setup(t, { team: { ...TEAM, agents: {} } })
  rt.ctx.tools.schemas = () => TEAM_TOOLS.map(name => ({ name }))
  agent.ctx.tools.restrict = () => { throw new Error('schema restriction is not ready') }
  rt.ctx.workspaceRegistry = { get: () => ({ id: 'workspace' }) }
  rt.ctx.sessionController = {
    create: async () => ({ sessionId: agent.id }),
    resolveAgent: async id => ({ agent: id === agent.id ? agent : { ...agent, id, session: { id } } }),
  }
  await rt.load()
  rt.state.agents.dsh = { id: 'dsh', sessions: [] }
  assert.equal(await rt.createAgentSession('dsh', 'workspace'), agent.id)
  denied(await execute())
  assert.equal(await rt.adoptAgentSession('dsh', 'adopted'), 'adopted')
  denied(await execute('list_bots', { ...agent, id: 'adopted', session: { id: 'adopted' } }))
  assert.deepEqual(ran, [])
})

test('cold resume and plugin HMR reload persisted ownership for the surviving Agent', async (t) => {
  const first = await setup(t)
  denied(await first.execute())
  const saved = readFileSync(join(first.home, 'state.json'), 'utf8')
  await first.dispose()
  const replacement = first.install()
  assert.equal(replacement.rt.agentOf(first.agent.id), undefined)
  denied(await first.execute())
  assert.equal(replacement.rt.agentOf(first.agent.id).id, 'dsh')
  assert.deepEqual(first.ran, [])
  assert.deepEqual(JSON.parse(readFileSync(join(first.home, 'state.json'), 'utf8')).agents, JSON.parse(saved).agents)
})

test('indexed ownership still denies a missing Agent record', async (t) => {
  const { rt, execute, ran, agent } = await setup(t)
  await rt.load()
  delete rt.state.agents.dsh
  assert.equal(rt.agentOf(agent.id), undefined)
  denied(await execute())
  assert.equal((await execute('list_bots', { ...agent, id: 'ordinary', session: { id: 'ordinary' } })).isError, false)
  assert.deepEqual(ran, ['list_bots'])
})

test('unloaded ownership fails closed on a skipped pre-execute policy', async (t) => {
  const { recorded, agent } = await setup(t)
  const guard = recorded.guards[0]
  assert.equal(guard({ name: 'list_bots', agent }), REFUSAL)
})

for (const failure of ['EACCES', 'EISDIR', 'incompatible version']) {
  test(`real storage ${failure} denies unknown Sessions and recovers after a successful read`, async (t) => {
    let recover
    let original
    const { rt, execute, ran, agent, warnings, statePath } = await setup(t, {
      beforeStart(path) {
        original = readFileSync(path, 'utf8')
        if (failure === 'EACCES') {
          recover = failRead(t, path)
        } else {
          if (failure === 'EISDIR') {
            rmSync(path)
            mkdirSync(path)
          } else {
            writeFileSync(path, JSON.stringify({ ...TEAM, version: 2 }))
          }
          recover = () => {
            if (failure === 'EISDIR') rmSync(path, { recursive: true })
            writeFileSync(path, original)
          }
        }
      },
    })
    for (const name of TEAM_TOOLS) denied(await execute(name))
    denied(await execute('list_bots', { ...agent, id: 'ordinary', session: { id: 'ordinary' } }))
    assert.ok(rt.readOnly())
    assert.deepEqual(ran, [])
    assert.equal(warnings.filter(line => line.includes('unreadable state')).length, 1)
    if (failure === 'EACCES') assert.equal(readFileSync(statePath, 'utf8'), original)
    if (failure === 'incompatible version') assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).version, 2)
    recover()
    assert.equal((await execute('list_bots', { ...agent, id: 'ordinary', session: { id: 'ordinary' } })).isError, false)
    denied(await execute())
    assert.equal(rt.stateReadError(), undefined)
    assert.equal(rt.agentOf(agent.id).id, 'dsh')
    assert.deepEqual(ran, ['list_bots'])
  })
}

test('a failed refresh preserves known Bot, group and task ownership without trusting unknown Sessions', async (t) => {
  const team = {
    ...TEAM,
    bots: { ...TEAM.bots, peer: { id: 'peer', sessionId: 'peer', name: 'Peer', createdAt: 1 } },
    rooms: { room: { id: 'room', name: 'Desk', named: true, members: ['chief'], sessions: { chief: 'group-chief' } } },
    tasks: { task: {
      id: 'task', mode: 'v2', title: 'Check', brief: 'Check the gate.',
      requester: 'chief', assignee: 'peer', state: 'open', phase: 'ready',
      capabilityAtCreation: { requester: true, initialAssignee: true },
      sessions: { chief: 'task-chief', peer: 'task-peer' },
      participants: { chief: { role: 'requester', kind: 'fork', inheritedThrough: 0 }, peer: { role: 'assignee', kind: 'fresh' } },
      openedAt: 1, updatedAt: 1, closedAt: null, conclusion: null,
      creationIntents: {}, pendingSends: {}, lateReplies: { count: 0, ids: [] },
    } },
  }
  const { rt, execute, ran, agent, statePath, home, warnings } = await setup(t, { team })
  await rt.load()
  assert.equal(rt.selfOf('task-chief'), 'chief')
  const recover = failRead(t, statePath)
  // Another host takes the lock and changes the file: refresh must reread it.
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'test-other-owner' }))
  writeFileSync(statePath, JSON.stringify({ ...team, revision: 123456 }))
  await rt.refresh()
  assert.equal(rt.agentOf(agent.id).id, 'dsh')
  assert.equal(rt.selfOf('group-chief'), 'chief')
  assert.equal(rt.selfOf('task-chief'), 'chief')
  for (const id of ['chief', 'room', 'group-chief', 'task-chief', 'task-peer']) {
    assert.equal((await execute('list_bots', { ...agent, id, session: { id } })).isError, false)
  }
  denied(await execute())
  denied(await execute('list_bots', { ...agent, id: 'ordinary', session: { id: 'ordinary' } }))
  assert.equal(warnings.filter(line => line.includes('unreadable state')).length, 1)
  recover()
  assert.equal((await execute('list_bots', { ...agent, id: 'ordinary', session: { id: 'ordinary' } })).isError, false)
  assert.match(rt.readOnly(), /another dsh/)
  assert.equal(rt.stateReadError(), undefined)
  denied(await execute())
  assert.equal(ran.length, 6)
})

test('Bot, group, task, plain Sessions and agentless calls retain team tools', async (t) => {
  const { execute, ran, agent } = await setup(t)
  for (const id of ['chief', 'group', 'task', 'ordinary']) {
    for (const name of TEAM_TOOLS) assert.equal((await execute(name, { ...agent, id, session: { id } })).isError, false)
  }
  const { ctx } = await setup(t)
  assert.equal((await ctx.tools.execute({
    name: 'list_bots', arguments: {}, callId: ToolCallId('agentless'), signal: new AbortController().signal,
  })).isError, false)
  assert.equal(ran.length, TEAM_TOOLS.length * 4)
})

test('scoped and re-registered team tools remain denied by name', async (t) => {
  const { execute, ran, register, agent, ctx } = await setup(t)
  const stop = register(agent.ctx, 'list_bots')
  denied(await execute())
  stop()
  register(agent.ctx, 'list_bots')
  // Scoped registrations remain visible despite inherited schema masks.
  agent.ctx.tools.restrict({ deny: TEAM_TOOLS })
  assert.ok(ctx.tools.schemas(agent).some(schema => schema.name === 'list_bots'))
  denied(await execute())
  assert.deepEqual(ran, [])
})

test('the PTC transport cannot execute a denied team-tool sub-call', async (t) => {
  const { execute, ran } = await setup(t, { ptc: true })
  const result = await execute('run_code')
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /DSH Agent Sessions cannot use DS Bot team tools/)
  assert.deepEqual(ran, [])
})
