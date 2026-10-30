import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { indexRoster, conversationTarget } from '../src/client/sources.js'
import { fileURLToPath } from 'node:url'
import { isHiddenTurn } from '../src/client/text.js'

const { outputFiles } = await build({
  stdin: { contents: "export { BranchDock, TaskHeader } from './src/client/branch-dock.js'\nexport { ComposerPlus } from './src/client/composer.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
const hooks = []
let stateValue
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: value => { hooks.push('state'); return [stateValue ?? value, next => { stateValue = typeof next === 'function' ? next(stateValue ?? value) : next }] },
  useRef: current => { hooks.push('ref'); return { current } },
  useEffect: () => { hooks.push('effect') },
  useMemo: make => { hooks.push('memo'); return make() },
} : {} })
const { BranchDock, TaskHeader, ComposerPlus } = module.exports
const descendants = node => {
  if (Array.isArray(node)) return node.flatMap(descendants)
  if (!node || typeof node !== 'object') return []
  return [node, ...descendants(node.props?.children)]
}
const record = (id, state = 'open') => ({
  id, title: `Task ${id}`, requester: 'a', assignee: 'b', state, phase: 'ready', openedAt: 1,
  sessions: { a: `${id}-a`, b: `${id}-b`, c: 'c' },
  participants: { a: { kind: 'fork' }, b: { kind: 'fresh' }, c: { kind: 'trunk' } },
  lateReplies: { count: state === 'open' ? 0 : 2 },
})
test('task-owned endpoints index as Bots without claiming shared trunks or conversation parts', () => {
  const a = { id: 'a', sessionId: 'a-now', parts: ['a'] }, b = { id: 'b' }, c = { id: 'c' }
  const roster = indexRoster({ bots: [a, b, c], rooms: [], tasks: [record('t1'), record('t2', 'done')] })
  assert.equal(roster.byId['t1-a'], a)
  assert.equal(roster.byId['t2-b'], b)
  assert.equal(roster.byId.c, c)
  assert.equal(roster.taskSessions.c, undefined)
  assert.deepEqual(a.parts, ['a'])
  assert.equal(conversationTarget(roster, 'a'), 'a-now')
  assert.equal(conversationTarget(roster, 't1-a'), 't1-a')
  assert.equal(conversationTarget(roster, 't2-a'), 't2-a')
  roster.exchangeTurns = { 't1-a': [1], a: [1] }
  assert.equal(isHiddenTurn(roster, 't1-a', 1), false)
  assert.equal(isHiddenTurn(roster, 'a', 1), true)
})
test('participant trunk docks open their own endpoint and label a shared trunk explicitly', () => {
  const tasks = [record('t1'), record('t2', 'done')]
  const roster = indexRoster({ bots: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase() })), rooms: [], tasks })
  for (const botId of ['a', 'b', 'c']) {
    const opened = []
    const tree = BranchDock({ sessionId: botId, useRoster: pick => pick(roster), useWork: pick => pick({}),
      actions: { openBranch: id => opened.push(id) } })
    const buttons = descendants(tree).filter(child => child.type === 'button')
    assert.equal(buttons.length, 2)
    buttons[0].props.onClick()
    assert.equal(opened[0], tasks[0].sessions[botId])
    assert.match(buttons[0].props['aria-label'], /Open task: Task t1/)
    if (botId === 'c') assert.ok(JSON.stringify(buttons[0]).includes('Main chat'))
    assert.ok(JSON.stringify(buttons[1]).includes('Late results'))
  }
  assert.equal(BranchDock({ sessionId: 't1-a', useRoster: pick => pick(roster), useWork: pick => pick({}), actions: {} }).type, TaskHeader)
})
test('closed task history includes every participant, newest first, with bounded navigation only', () => {
  const tasks = Array.from({ length: 23 }, (_, index) => ({
    ...record(`t${index}`, index % 2 ? 'cancelled' : 'done'), closedAt: index + 1, lateReplies: { count: 0 },
  }))
  const roster = indexRoster({ bots: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase() })), rooms: [], tasks })
  for (const botId of ['a', 'b', 'c']) {
    const opened = []
    const tree = BranchDock({ sessionId: botId, useRoster: pick => pick(roster), useWork: pick => pick({}),
      actions: { openBranch: id => opened.push(id) } })
    const nodes = descendants(tree)
    assert.ok(nodes.some(node => node.type === 'summary' && node.props.children[0] === 'Closed tasks (23)'))
    const buttons = nodes.filter(node => node.type === 'button')
    assert.equal(buttons.length, 21)
    assert.equal(buttons[0].props['aria-label'], 'Open task: Task t22')
    assert.equal(buttons[19].props['aria-label'], 'Open task: Task t3')
    assert.equal(buttons[20].props.children[0], 'More tasks')
    buttons[0].props.onClick()
    assert.deepEqual(opened, [tasks[22].sessions[botId]])
    buttons[20].props.onClick()
    const expanded = BranchDock({ sessionId: botId, useRoster: pick => pick(roster), useWork: pick => pick({}), actions: {} })
    assert.equal(descendants(expanded).filter(node => node.type === 'button').length, 23)
    stateValue = undefined
  }
})
test('an empty requester task shows its brief and live peers without prompting any Session', () => {
  const task = { ...record('t1'), brief: 'Check **the original request** <script>unsafe()</script>' }
  const roster = indexRoster({ bots: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase() })), rooms: [], tasks: [task] })
  const opened = []
  const render = turns => TaskHeader({ task, sessionId: 't1-a', roster, work: { turns },
    actions: { openBranch: id => opened.push(id) } })
  const tree = render({ 't1-b': 10 })
  assert.ok(JSON.stringify(tree).includes(task.brief))
  const peers = tree.props.children[2].props.children.flat()
  const worker = peers[1].props.children
  assert.equal(worker[0].props.children[0], 'B · Working')
  assert.equal(worker[1].props.at, 10)
  worker[0].props.onClick()
  assert.deepEqual(opened, ['t1-b'])
  assert.ok(JSON.stringify(render({})).includes('B · Idle'))
  assert.equal(peers[2].props.children[0].props['aria-label'], 'Open task: C')
})
test('creating task endpoints are not opened before setup is ready', () => {
  const task = { ...record('t1'), phase: 'creating' }
  const roster = indexRoster({ bots: [{ id: 'a', name: 'A' }], rooms: [], tasks: [task] })
  const tree = BranchDock({ sessionId: 'a', useRoster: pick => pick(roster), useWork: pick => pick({}), actions: {} })
  assert.equal(tree.props.children.flat().find(child => child?.type === 'button').props.disabled, true)
  const failed = indexRoster({ bots: [{ id: 'a', name: 'A' }], rooms: [], tasks: [{ ...task, state: 'failed' }] })
  const history = BranchDock({ sessionId: 'a', useRoster: pick => pick(failed), useWork: pick => pick({}), actions: {} })
  assert.equal(descendants(history).find(child => child.type === 'button').props.disabled, false)
})
test('composer hook order stays stable when a Task Session appears in the roster', () => {
  const render = byId => {
    hooks.length = 0
    ComposerPlus({ sessionId: 'task-a', useRoster: pick => pick({ byId, roomsById: {} }), actions: {}, inputActions: {} })
    return [...hooks]
  }
  assert.deepEqual(render({}), render({ 'task-a': { id: 'a' } }))
})
