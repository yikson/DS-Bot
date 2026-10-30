// Run ordinary smoke first, restart the isolated bench with taskSessionsEnabled: true
// and taskSessions: [Chief, Coder], then use open, close, and verify (after restart).
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const [name, port, phase = 'open'] = process.argv.slice(2)
assert.match(name ?? '', /^[a-z0-9-]+$/)
assert.match(port ?? '', /^\d+$/)
assert.ok(['open', 'hmr', 'close', 'verify'].includes(phase))
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const home = join(root, `.dsh-test-${name}`)
const base = `http://127.0.0.1:${port}`
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const state = () => read(join(home, 'bot/state.json'))
const log = () => readFileSync(join(home, 'mock.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const resultPath = join(home, 'lifecycle-result.json')
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(`${base}/\\?token=[^\\s]+`))?.[0]
assert.ok(login)
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
async function api(endpoint, payload = {}) {
  const value = await (await fetch(`${base}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })).json()
  assert.ok(value.ok, value.error?.message)
  return value.value
}
async function settle() {
  let calls = log().length, since = Date.now()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const view = await api('state')
    const now = log().length
    if (now !== calls || Object.keys(view.activity ?? {}).length) { calls = now; since = Date.now() }
    else if (Date.now() - since > 3000) return
  }
  throw new Error('Lifecycle bench did not settle')
}
const send = (sessionId, text) => api('send', { sessionId, text })
function eventsOf(id) {
  const sessions = join(home, 'sessions')
  const dirs = readdirSync(sessions).map(project => join(sessions, project)).filter(project => readdirSync(project).includes(id))
  assert.equal(dirs.length, 1)
  const bytes = readFileSync(join(dirs[0], id, 'session.v4.jsonl.zstd'))
  const records = []
  for (let offset = 0; offset < bytes.length;) {
    const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), { info: true })
    assert.ok(engine.bytesWritten)
    offset += engine.bytesWritten
    records.push(...buffer.toString().trim().split('\n').map(line => JSON.parse(line)))
  }
  return records
}
if (phase === 'open') {
  const chief = Object.values(state().bots).find(bot => bot.name === 'Chief')
  const coder = Object.values(state().bots).find(bot => bot.name === 'Coder')
  assert.ok(chief && coder, 'ordinary smoke must run first')
  await send(chief.id, 'Lifecycle warmup')
  await settle()
  const before = new Set(Object.keys(state().tasks ?? {}))
  await send(chief.id, '转告 Coder: lifecycle-open-evidence')
  await settle()
  const tasks = Object.values(state().tasks).filter(task => !before.has(task.id))
  assert.equal(tasks.length, 1)
  const task = tasks[0]
  assert.equal(task.phase, 'ready')
  await send(task.sessions[chief.id], '转告 Coder: lifecycle-follow-up-evidence')
  await settle()
  const saved = state().tasks[task.id]
  assert.equal(saved.state, 'open')
  const exchanges = state().exchanges.filter(entry => entry.taskId === task.id)
  assert.equal(exchanges.filter(entry => entry.role === 'request').length, 2)
  assert.equal(exchanges.filter(entry => entry.role === 'reply').length, 2)
  assert.equal(Object.keys(state().tasks).length, before.size + 1, 'follow-up stays in the same task')
  assert.equal(eventsOf(chief.sessionId ?? chief.id).filter(event => event.type === 'user/message'
    && event.data?.content?.some(block => block.text === '转告 Coder: lifecycle-follow-up-evidence')).length, 0)
  const view = await api('state')
  assert.ok(view.tasks.some(item => item.id === task.id), 'task dock state is exposed')
  writeFileSync(resultPath, JSON.stringify({ taskId: task.id, requesterSession: task.sessions[chief.id],
    requester: chief.id, assigneeSession: task.sessions[coder.id], requests: 2, replies: 2, phase }, null, 2))
  console.log('open/follow-up: one task, two requests, two replies; user input stays in requester task Session')
} else if (phase === 'hmr') {
  const result = read(resultPath)
  const before = structuredClone(state().tasks[result.taskId].sessions)
  const pid = readFileSync(join(home, 'web.pid'), 'utf8').trim()
  const checkTools = () => {
    const call = log().findLast(call => call.session === result.requesterSession && call.toolNames?.includes('message_bot'))
    assert.ok(call?.toolNames?.includes('close_task'), 'run the mock with MOCK_LOG_TOOLS=1')
    assert.ok(call.toolNames.includes('list_tasks'))
  }
  await send(result.requesterSession, 'Gate HMR before')
  await settle()
  checkTools()
  async function remote(method, args) {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: `gate-${Date.now()}`, method, payload: { args } }),
    })
    const value = await response.json()
    assert.ok(value.result?.ok, JSON.stringify(value.result?.error ?? value))
    return value.result.value
  }
  const plugins = await remote('pluginManager/listPlugins', {})
  const bot = plugins.find(plugin => plugin.moduleName === 'ds-bot')
  assert.ok(bot?.entryId)
  for (const enabled of [false, true]) {
    const change = await remote('pluginManager/setPluginEnabled', { id: bot.entryId, enabled })
    assert.equal(change.application, 'applied', JSON.stringify(change.error))
  }
  await send(result.requesterSession, 'Gate HMR after')
  await settle()
  checkTools()
  assert.equal(readFileSync(join(home, 'web.pid'), 'utf8').trim(), pid, 'this is plugin HMR, not host restart')
  assert.deepEqual(state().tasks[result.taskId].sessions, before)
  assert.equal(state().tasks[result.taskId].state, 'open')
  result.hmr = 'same host and endpoints; close_task/list_tasks restored'
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  console.log('hmr: disabled/enabled the bot entry in the live host; same requester retains close_task/list_tasks')
} else {
  const result = read(resultPath)
  if (phase === 'close') {
    await send(result.requesterSession, '关闭任务 done: Lifecycle evidence accepted')
    await settle()
  } else await settle()
  const task = state().tasks[result.taskId]
  assert.equal(task.state, 'done')
  assert.equal(task.delivery.state, 'delivered')
  const summaryId = task.delivery.summaryId
  const conclusions = task.delivery.targets.flatMap(target => eventsOf(target.sessionId))
    .filter(event => event.type === 'user/message' && event.data?.source?.exchangeId === summaryId)
  assert.equal(conclusions.length, 1, 'one conclusion before and after host restart')
  assert.ok(Array.from(conclusions[0].data.content.map(block => block.text ?? '').join('')).length <= 1000)
  const view = await api('state')
  assert.equal(view.tasks.filter(task => task.id === result.taskId && task.state === 'open').length, 0)
  result.phase = phase
  result.conclusions = conclusions.length
  result.state = task.state
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  console.log(`${phase}: done, one persisted conclusion, no open task dock entry`)
}
