import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Synthetic data in the shape of a team saved by the builds before this one:
// closed work branches on a Bot, closed and failed v2 tasks with their delivery
// bookkeeping, a DSH Agent and the other top-level tables.
const bot = (id, name, extra = {}) => ({
  id, name, role: '', color: 'ink', avatar: 'a1', instructions: '', createdAt: 1, createdBy: 'user',
  capabilities: [], model: 'mock/mock', appliedModel: 'mock/mock', segments: [], sessionId: id, ...extra,
})
const branch = id => ({
  id, trunkSessionId: 'ada', targetBotId: 'card', title: `Branch ${id}`, brief: `Brief ${id}`, workIds: [id],
  state: 'closed', openedAt: 10, sessionId: `branch-${id}`, inheritedThrough: 3, closedAt: 20,
  conclusion: { status: 'done', text: `[Work branch closed] Branch ${id}` }, summaryId: `${id}:closed`, summaryDelivered: true,
})
const delivered = (summaryId, sessionId) => ({
  summaryId, targets: [{ sessionId, state: 'delivered' }], state: 'delivered',
  targetSessionId: sessionId, enqueuedAt: 30, deliveredAt: 31,
})
const doneTask = id => ({
  id, mode: 'v2', title: `Task ${id}`, brief: `Brief ${id}`, requester: 'ada', assignee: 'card',
  state: 'done', phase: 'ready', capabilityAtCreation: { requester: true, initialAssignee: true },
  participants: { ada: { role: 'requester', kind: 'fork', sourceSessionId: 'ada', forkAtSeq: 5, inheritedThrough: 5 },
    card: { role: 'assignee', kind: 'fresh', inheritedThrough: null } },
  sessions: { ada: `${id}-ada`, card: `${id}-card` },
  creationIntents: {
    [`${id}-r1`]: { taskId: id, requestId: `${id}-r1`, botId: 'ada', operation: 'fork', marker: `task:${id}:ada`, state: 'created', sourceSessionId: 'ada', atSeq: 5, sessionId: `${id}-ada` },
    [`${id}-r2`]: { taskId: id, requestId: `${id}-r2`, botId: 'card', operation: 'fresh', marker: `task:${id}:card`, state: 'created', sessionId: `${id}-card` },
  },
  pendingSends: {}, lateReplies: { count: 0, ids: [] }, openedAt: 10, updatedAt: 40, closedAt: 40,
  conclusion: { status: 'done', text: 'Shipped', evidence: 'PR 1' },
  sends: { [`${id}-x`]: { args: { taskId: id, exchangeId: `${id}-x`, fromId: 'ada', toId: 'card', role: 'request', text: 'Do it', sessionId: `${id}-card` },
    delivery: delivered(`${id}-x`, `${id}-card`) } },
  delivery: delivered(`${id}:closed`, 'ada'), closedBy: { sessionId: `${id}-ada`, turn: 2 },
})
const failedTask = {
  id: 'tf', mode: 'v2', title: 'Task tf', brief: 'Brief tf', requester: 'ada', assignee: 'card',
  state: 'failed', phase: 'creating', capabilityAtCreation: { requester: true, initialAssignee: true },
  participants: { ada: { role: 'requester', kind: 'fork', sourceSessionId: 'ada', forkAtSeq: 5 }, card: { role: 'assignee', kind: 'fresh' } },
  sessions: { ada: 'tf-ada' },
  creationIntents: {
    r1: { taskId: 'tf', requestId: 'r1', botId: 'ada', operation: 'fork', marker: 'task:tf:ada', state: 'created', sourceSessionId: 'ada', sessionId: 'tf-ada' },
    r2: { taskId: 'tf', requestId: 'r2', botId: 'card', operation: 'fresh', marker: 'task:tf:card', state: 'unknown', diagnostic: 'interrupted' },
  },
  pendingSends: {}, lateReplies: { count: 0, ids: [] }, openedAt: 10, updatedAt: 12, closedAt: 12,
  conclusion: { status: 'blocked', text: 'Setup failed' }, diagnostic: 'Setup failed', delivery: delivered('tf:closed', 'ada'),
}
const seed = () => ({
  version: 1, revision: 7, workspaceId: 'ws', whaleStored: true, mainBotIds: ['ada'],
  bots: {
    ada: bot('ada', 'ADA', { workBranches: { b1: branch('b1'), b2: branch('b2'), b3: branch('b3') } }),
    card: bot('card', 'Cardpack'), pm1: bot('pm1', 'PM One'), pm2: bot('pm2', 'PM Two'),
  },
  rooms: {}, agents: { ag: { id: 'ag', name: 'DSH Agent', sessions: ['agent-1'], createdAt: 1, pinned: false } },
  capabilities: { items: {} }, exchanges: [{ id: 'e1', from: 'ada', to: 'card', text: 'hi', role: 'request', time: 1 }],
  exchangeTurns: { card: [1] }, works: {}, requests: {}, questions: {}, views: {}, prefs: {}, switching: {}, secretRequests: {},
  tasks: { t1: doneTask('t1'), t2: doneTask('t2'), t3: doneTask('t3'), tf: failedTask },
})

test('a team saved by earlier builds loads, indexes and saves without losing fields', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-retired-data-'))
  const statePath = join(home, 'state.json')
  const original = seed()
  writeFileSync(statePath, JSON.stringify(original))
  const ctx = fakeContext()
  const warnings = []
  const rt = createRuntime(ctx, { home, memory: false, taskSessionsEnabled: true, taskSessions: ['ADA', 'Cardpack', 'PM One', 'PM Two'] })
  rt.warn = (...args) => warnings.push(args)
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()

  assert.equal(rt.readOnly(), undefined)
  assert.deepEqual(Object.keys(rt.state.bots).sort(), ['ada', 'card', 'pm1', 'pm2'])
  assert.equal(rt.taskById.size, 4)
  assert.deepEqual([...rt.taskById.values()].map(task => task.state).sort(), ['done', 'done', 'done', 'failed'])
  assert.equal(rt.taskForSession('t1-card').id, 't1')
  assert.equal(rt.selfOf('t2-ada'), 'ada')
  assert.deepEqual(rt.openTasksOf('ada'), [])
  // Retired branch Sessions read as archived Sessions of their Bot.
  assert.equal(rt.selfOf('branch-b1'), 'ada')
  assert.equal(rt.isBotSession('branch-b1'), false)
  assert.equal(rt.agentOf('agent-1')?.id, 'ag')

  await rt.save({ required: true })
  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.deepEqual(saved.bots.ada.workBranches, original.bots.ada.workBranches)
  assert.deepEqual(saved.tasks, original.tasks)
  assert.deepEqual(saved.agents, original.agents)
  assert.deepEqual(warnings.filter(([message]) => /invalid|unreadable/i.test(String(message))), [])
})
