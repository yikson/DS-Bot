import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { indexRoster, conversationTarget } from '../src/client/sources.js'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({
  stdin: { contents: "export { BranchDock } from './src/client/branch-dock.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
} : {} })
const { BranchDock } = module.exports
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
})
test('participant trunk docks open their own endpoint and label a shared trunk explicitly', () => {
  const tasks = [record('t1'), record('t2', 'done')]
  const roster = indexRoster({ bots: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase() })), rooms: [], tasks })
  for (const botId of ['a', 'b', 'c']) {
    const opened = []
    const tree = BranchDock({ sessionId: botId, useRoster: pick => pick(roster), useWork: pick => pick({}),
      actions: { openBranch: id => opened.push(id) } })
    const buttons = tree.props.children.flat().filter(child => child?.type === 'button')
    assert.equal(buttons.length, 2)
    buttons[0].props.onClick()
    assert.equal(opened[0], tasks[0].sessions[botId])
    assert.match(buttons[0].props['aria-label'], /Open task: Task t1/)
    if (botId === 'c') assert.ok(JSON.stringify(buttons[0]).includes('Main chat'))
    assert.ok(JSON.stringify(buttons[1]).includes('Late results'))
  }
  assert.equal(BranchDock({ sessionId: 't1-a', useRoster: pick => pick(roster), useWork: pick => pick({}), actions: {} }), null)
})
