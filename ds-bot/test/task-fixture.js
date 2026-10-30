import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

export async function setup(t, config = {}, seed, notes, existingAgentOf) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-task-routing-'))
  const statePath = join(home, 'state.json')
  writeFileSync(statePath, JSON.stringify(seed ?? {
    version: 1, mainBotIds: ['a'], bots: Object.fromEntries(['a', 'b', 'c', 'd'].map(id =>
      [id, { id, name: id.toUpperCase(), sessionId: id, createdAt: 1, permission: 'full' }])),
    rooms: {}, exchanges: [],
  }))
  if (notes) writeFileSync(join(home, 'inflight.json'), JSON.stringify(notes))
  const agents = new Map(), logs = new Map()
  const forks = [], fresh = [], selections = [], permissions = [], capabilities = [], restores = [], titles = []
  const profile = { provider: 'profile', model: 'default', reasoningEffort: 'low' }
  const ctx = fakeContext({ services: {
    agentPresets: { list: async () => [{ id: 'standard' }], serviceFor: () => undefined },
    agentDefaultModel: { currentSelection: () => profile, saveSelection: async value => restores.push(value) },
    permissionPresets: { resolve: value => value, set: (session, preset) => permissions.push([session.id, preset]) },
  } })
  const agentOf = id => {
    if (existingAgentOf) return existingAgentOf(id)
    if (agents.has(id)) return agents.get(id)
    const events = logs.get(id) ?? (/^[a-d]$/.test(id) ? [{ type: 'turn/end', seq: 13, data: { reason: { kind: 'completed' } } }] : [])
    logs.set(id, events)
    const scope = fakeContext()
    scope.tools.register = tool => {
      scope.registeredTools.set(tool.name, tool)
      return () => scope.registeredTools.delete(tool.name)
    }
    const agent = {
      id, status: 'idle', calls: [], ctx: scope,
      cancel(cause) { this.cancelled = cause },
      session: { id, inheritedEventCount: 14, requestHeader: () => ({ config: profile }) },
      inbox: { nextStep: [], nextTurn: [], remove(messageId) {
        for (const list of [this.nextStep, this.nextTurn]) {
          const i = list.findIndex(message => message.id === messageId)
          if (i >= 0) { list.splice(i, 1); return true }
        }
        return false
      }, clear() { this.nextStep.length = 0; this.nextTurn.length = 0 } },
      followup(message) { this.calls.push(['followup', message]); this.inbox.nextTurn.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) },
      steer(message) { this.calls.push(['steer', message]); this.inbox.nextStep.push(message); events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) },
    }
    agents.set(id, agent)
    t.after(() => scope.dispose())
    return agent
  }
  Object.assign(ctx, {
    sessionController: {
      fork: async args => { forks.push(args); return { sessionId: `fork-${forks.length}` } },
      create: async args => { fresh.push(args); return { sessionId: `fresh-${fresh.length}` } },
      resolveAgent: async id => ({ agent: agentOf(id) }),
      selectModel: async args => { selections.push(args); return { selected: args } },
      inspect: async id => { agentOf(id); return { events: structuredClone(logs.get(id)) } },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async (session, title) => titles.push([session.id, title]) },
    sessions: { flush: async () => {} },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'workspace' }), archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, memory: false, taskSessionsEnabled: true, taskSessions: ['A', 'B'], ...config })
  await rt.load()
  await rt.taskToolsReady
  rt.ensureCapabilities = async sessionId => {
    assert.ok(rt.isBotSession(sessionId))
    capabilities.push(sessionId)
  }
  const announced = new Set()
  const tool = async (name, args, id = 'a') => {
    const agent = agentOf(id)
    if (!announced.has(id)) {
      announced.add(id)
      for (const listener of ctx.listeners.get('agent/created') ?? []) await listener({ agent })
    }
    return (agent.ctx.registeredTools.get(name) ?? ctx.registeredTools.get(name)).execute(args, { agent })
  }
  const send = (id = 'a', to = 'B', extra = {}) => tool('message_bot', { to, message: 'Current delegation missing from the fork prefix', ...extra }, id)
  const tasks = () => Object.values(rt.state.tasks)
  const incoming = sessionId => agentOf(sessionId).calls.at(-1)?.[1].source
  const handling = (sessionId, source) => rt.live.set(sessionId, { turn: 7, info: source })
  const saved = () => JSON.parse(readFileSync(statePath, 'utf8'))
  let seq = 100
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, data, seq: ++seq, time: Date.now() })
    }
  }
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt, ctx, home, statePath, agentOf, logs, forks, fresh, selections, restores, permissions, capabilities, titles, tool, send, tasks, incoming, handling, saved, emit }
}
