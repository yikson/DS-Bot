import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createRuntime } from '../index.js'
import { SELF_UPDATE_REFUSAL } from '../src/host/update.js'
import { fakeContext } from './fake-ctx.js'

const OWN = [
  ['set_plugin', 'entry-bot'], ['set_plugin', 'entry-search'],
  ['set_bundle', 'ds-bot'], ['remove_bundle', 'ds-bot'],
  ['install_bundle', 'ds-bot@0.2.3'], ['install_bundle', 'ds-bot@latest'],
  ['install_bundle', 'alias@npm:ds-bot@0.2.3'],
  ['set_bundle', 'alias'], ['remove_bundle', 'alias'], ['install_bundle', 'alias@latest'],
  ['set_version_exemption', 'ds-bot@0.2.3'],
]
const SESSIONS = ['chief', 'past-chief', 'room-chief', 'past-room', 'work-chief', 'dsh-agent']

async function setup(t, { manager, skipPolicy = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-self-maintenance-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: ['chief'],
    bots: {
      chief: {
        id: 'chief', sessionId: 'chief', name: 'Chief', instructions: '', createdAt: 1,
        segments: [{ sessionId: 'past-chief' }],
        workBranches: { work: { state: 'open', sessionId: 'work-chief', workIds: [] } },
      },
    },
    rooms: {
      room: {
        id: 'room', name: 'Desk', named: true, members: ['chief'], sessions: { chief: 'room-chief' },
        segments: { chief: [{ sessionId: 'past-room' }] },
      },
    },
    agents: { dsh: { id: 'dsh', name: 'DSH Agent', sessions: ['dsh-agent'], createdAt: 1 } },
  }))
  const pluginManager = manager ?? {
    listPlugins: async () => [
      { entryId: 'entry-bot', moduleName: 'ds-bot', patchId: 'bot' },
      { entryId: 'entry-search', moduleName: 'ds-bot/web-search', patchId: 'web-search-auto' },
      { entryId: 'entry-other', moduleName: 'other-plugin', patchId: 'other' },
    ],
    listBundles: async () => [
      { name: 'alias', rows: [{ moduleName: 'ds-bot' }] },
      { name: 'override', overrides: ['bot'], rows: [] },
      { name: 'other-plugin', rows: [{ moduleName: 'other-plugin' }] },
    ],
  }
  const recorded = fakeContext({ services: { pluginManager } })
  const rt = createRuntime(recorded, { home, github: false, diagnosticsFile: false })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  t.after(async () => {
    await ctx.fiber.dispose()
    await recorded.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  // Exercise the plugin's registered policies through DSH's real tool runtime.
  for (const policy of recorded.listeners.get('tools/pre-execute') ?? []) {
    if (!skipPolicy) ctx.on('tools/pre-execute', policy)
  }
  for (const guard of recorded.guards) ctx.tools.guard(guard)
  const ran = []
  ctx.tools.register(defineTool({
    name: 'plugin_manager',
    parameters: { action: { type: 'string', required: true }, target: { type: 'string' }, enabled: { type: 'boolean' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args) => { ran.push(args); return 'executed' },
  }))
  // A later permission policy cannot undo a final guard denial.
  ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }))
  const execute = (action, target, sessionId = 'chief', extra = {}) => ctx.tools.execute({
    name: 'plugin_manager', callId: ToolCallId('self-change'), signal: new AbortController().signal,
    arguments: { action, ...(target === undefined ? {} : { target }), ...extra },
    ...(sessionId === null ? {} : { agent: { id: sessionId, session: { id: sessionId }, ctx } }),
  })
  return { execute, ran, rt, pluginManager }
}

test('self-change is refused in current, archived, group, work and DSH Agent Sessions', async (t) => {
  const { execute, ran } = await setup(t)
  for (const session of SESSIONS) {
    for (const [action, target] of OWN) {
      for (const enabled of [false, true]) {
        const result = await execute(action, target, session, { enabled })
        assert.equal(result.isError, true, `${session}: ${action} ${target}`)
        assert.equal(result.error.message, SELF_UPDATE_REFUSAL)
      }
    }
  }
  assert.deepEqual(ran, [])
})

test('bundle overrides and unverified install sources cannot bypass self-change denial', async (t) => {
  const { execute, ran } = await setup(t)
  const calls = [
    ['set_bundle', 'override'], ['remove_bundle', 'override'], ['install_bundle', 'override@latest'],
    ['install_bundle', 'github:yikson/DS-Bot#main&path:/ds-bot'],
    ['install_bundle', 'https://example.com/release.tgz'], ['install_bundle', 'file:/work/plugin'],
    ['install_bundle', 'link:/work/plugin'], ['set_plugin', 'unknown-entry'],
    ['install_bundle', 'ds-bot'], ['install_bundle', ' ds-bot@latest '],
  ]
  for (const [action, target] of calls) assert.equal((await execute(action, target)).isError, true, target)
  assert.deepEqual(ran, [])
})

test('only positively identified foreign registry packages may be installed in managed Sessions', async (t) => {
  const { execute, ran } = await setup(t)
  const denied = [
    '.', '..', ' . ', ' .. ', './', '../', '.\\', '..\\',
    './ds-bot', '../ds-bot', '.\\ds-bot', '..\\ds-bot',
    '/work/ds-bot', '\\work\\ds-bot', 'C:\\work\\ds-bot', 'C:/work/ds-bot',
    '\\\\server\\share\\ds-bot', '~/ds-bot',
    'file:.', 'file:..', 'file:/work/ds-bot', 'link:.', 'link:..', 'link:/work/ds-bot',
    'owner/repo', 'github:owner/repo', 'gitlab:owner/repo', 'git@github.com:owner/repo.git',
    'git+https://github.com/owner/repo.git', 'https://github.com/owner/repo',
    'https://example.com/release.tgz', 'https://example.com/release.tar.gz',
    'release.tgz', 'release.tar.gz', './release.tgz',
    'other-plugin@.', 'other-plugin@..', 'other-plugin@./ds-bot', 'other-plugin@../ds-bot',
    'other-plugin@/work/ds-bot', 'other-plugin@..\\ds-bot', 'other-plugin@C:\\work\\ds-bot',
    'other-plugin@file:/work/ds-bot', 'other-plugin@link:../ds-bot',
    'other-plugin@github:owner/repo', 'other-plugin@npm:ds-bot', 'other-plugin@release.tgz',
    '', '.plugin', '_plugin', '@scope/.plugin', '@scope/_plugin', '@scope/..',
    '@.scope/plugin', '@scope/plugin/extra', 'MixedCase', 'node_modules', 'favicon.ico',
    'plugin@', 'plugin@%2e%2e', 'ds-bot', 'ds-bot@latest',
    'a'.repeat(215), `@${'a'.repeat(210)}/plugin`,
  ]
  for (const session of ['chief', 'dsh-agent']) {
    for (const target of denied) {
      const result = await execute('install_bundle', target, session)
      assert.equal(result.isError, true, `${session}: ${JSON.stringify(target)}`)
      assert.equal(result.error.message, SELF_UPDATE_REFUSAL)
    }
  }
  assert.deepEqual(ran, [])
  const allowed = [
    'foreign-plugin', 'foreign-plugin@latest', 'foreign-plugin@^1.2.3', 'foreign-plugin@~1.2',
    'foreign.plugin@1.0.0-beta.2+build', '@scope/foreign-plugin', '@scope/foreign-plugin@1.0.0',
  ]
  for (const session of ['chief', 'dsh-agent']) {
    for (const target of allowed) {
      assert.equal((await execute('install_bundle', target, session)).isError, false, target)
    }
  }
  assert.equal(ran.length, allowed.length * 2)
})

test('discovery and verifiable unrelated plugin changes remain available', async (t) => {
  const { execute, ran } = await setup(t)
  const calls = [
    ['list_plugins'], ['list_bundles'], ['list_version_exemptions'],
    ['set_plugin', 'entry-other'], ['set_bundle', 'other-plugin'],
    ['install_bundle', 'other-plugin@latest'], ['install_bundle', '@scope/other-plugin@1.0.0'],
    ['remove_bundle', 'other-plugin'], ['set_version_exemption', 'other-plugin@1.0.0'],
  ]
  for (const session of ['chief', 'dsh-agent']) {
    for (const [action, target] of calls) assert.equal((await execute(action, target, session)).isError, false, target)
  }
  assert.equal(ran.length, calls.length * 2)
})

test('plain non-team Sessions and agentless calls retain plugin management', async (t) => {
  const { execute, ran } = await setup(t)
  for (const session of ['unrelated-session', null]) {
    for (const [action, target] of OWN) assert.equal((await execute(action, target, session)).isError, false)
  }
  assert.equal(ran.length, OWN.length * 2)
})

test('missing or failed inventory refuses mutations without an unhandled rejection', async (t) => {
  for (const manager of [{}, {
    listPlugins: async () => { throw new Error('inventory failed') },
    listBundles: async () => { throw new Error('inventory failed') },
  }]) {
    const { execute, ran } = await setup(t, { manager })
    for (const [action, target] of [['set_plugin', 'entry-bot'], ['remove_bundle', 'alias'], ['install_bundle', 'other-plugin']]) {
      assert.equal((await execute(action, target)).isError, true)
    }
    assert.deepEqual(ran, [])
  }
})

test('a skipped pre-policy fails closed even before persisted ownership is loaded', async (t) => {
  const { execute, ran } = await setup(t, { skipPolicy: true })
  assert.equal((await execute('remove_bundle', 'ds-bot')).isError, true)
  assert.equal((await execute('list_bundles')).isError, false)
  assert.equal(ran.length, 1)
})

test('newly indexed Sessions are protected on their first execution', async (t) => {
  const { execute, rt, ran } = await setup(t)
  await rt.load()
  rt.state.agents.dsh.sessions.push('new-agent')
  rt.state.bots.chief.workBranches.next = { state: 'open', sessionId: 'new-work', workIds: [] }
  rt.indexSessions()
  for (const session of ['new-agent', 'new-work']) {
    assert.equal((await execute('remove_bundle', 'ds-bot', session)).isError, true)
  }
  assert.deepEqual(ran, [])
})
