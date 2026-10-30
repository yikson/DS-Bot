// After the ordinary smoke, restart its isolated bench with taskSessionsEnabled: true
// and taskSessions: [Chief, Coder], then run: node dev/task-routing-smoke.mjs <name> <port>
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const [name, port] = process.argv.slice(2)
assert.match(name ?? '', /^[a-z0-9-]+$/)
assert.match(port ?? '', /^\d+$/)
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const home = join(root, `.dsh-test-${name}`)
const base = `http://127.0.0.1:${port}`
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const state = () => json(join(home, 'bot/state.json'))
const mock = () => readFileSync(join(home, 'mock.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const login = readFileSync(join(home, 'web.log'), 'utf8').match(new RegExp(`${base}/\\?token=[^\\s]+`))?.[0]
assert.ok(login, 'isolated bench login URL')
const response = await fetch(login, { redirect: 'manual' })
const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
assert.ok(cookie, 'isolated bench login cookie')
async function api(endpoint, payload = {}) {
  const result = await (await fetch(`${base}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })).json()
  assert.equal(result.ok, true, result.error?.message)
  return result.value
}
async function settle() {
  const deadline = Date.now() + 120_000
  let count = mock().length, quiet = Date.now()
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const view = await api('state')
    const next = mock().length
    if (next !== count || Object.keys(view.activity ?? {}).length) {
      count = next
      quiet = Date.now()
    } else if (Date.now() - quiet > 2500) return
  }
  throw new Error('Task-enabled bench did not settle')
}
function eventsOf(id) {
  const sessions = join(home, 'sessions')
  const matches = readdirSync(sessions).map(project => join(sessions, project))
    .filter(project => readdirSync(project).includes(id))
  assert.equal(matches.length, 1, 'one stored Session directory')
  const bytes = readFileSync(join(matches[0], id, 'session.v4.jsonl.zstd'))
  const records = []
  for (let offset = 0; offset < bytes.length;) {
    const { buffer, engine } = zstdDecompressSync(bytes.subarray(offset), { info: true })
    assert.ok(engine.bytesWritten > 0)
    offset += engine.bytesWritten
    records.push(...buffer.toString().trim().split('\n').map(line => JSON.parse(line)))
  }
  return records.filter(record => record.type !== 'session')
}
function pendingIn(events) {
  const lists = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const { target, start, removedCount = 0, inserted } = event.data
    lists[target].splice(start, removedCount, ...inserted)
  }
  return Object.values(lists).flat()
}
const chief = Object.values(state().bots).find(bot => bot.name === 'Chief')
const coder = Object.values(state().bots).find(bot => bot.name === 'Coder')
assert.ok(chief && coder, 'ordinary smoke must create Chief and Coder first')
await api('send', { sessionId: chief.id, text: 'Task routing warmup' })
await settle()
const results = []
for (let round = 1; round <= 2; round++) {
  const before = new Set(Object.keys(state().tasks ?? {}))
  const callsBefore = mock().length
  await Promise.all([1, 2].map(index => api('send', {
    sessionId: chief.id, text: `转告 Coder: task-routing-round-${round}-job-${index}`,
  })))
  await settle()
  const saved = state()
  const tasks = Object.values(saved.tasks).filter(task => !before.has(task.id))
  assert.equal(tasks.length, 2, 'two root delegations open two tasks')
  const ids = new Set(tasks.map(task => task.id))
  const requests = saved.exchanges.filter(entry => ids.has(entry.taskId) && entry.role === 'request')
  const replies = saved.exchanges.filter(entry => ids.has(entry.taskId) && entry.role === 'reply')
  assert.equal(requests.length, 2, 'exactly two task requests')
  assert.equal(replies.length, 2, 'exactly two task replies')
  assert.equal(new Set(tasks.flatMap(task => Object.values(task.sessions))).size, 4)
  let inheritedQueuedInputs = 0
  for (const task of tasks) {
    assert.equal(task.state, 'open')
    assert.equal(task.phase, 'ready')
    assert.equal(task.participants[chief.id].kind, 'fork')
    assert.equal(task.participants[coder.id].kind, 'fresh')
    const boundary = task.participants[chief.id].inheritedThrough
    const source = eventsOf(task.participants[chief.id].sourceSessionId)
    assert.equal(source.find(event => event.seq === boundary)?.type, 'turn/end')
    const child = eventsOf(task.sessions[chief.id])
    const inherited = child.filter(event => event.seq <= boundary)
    const own = child.filter(event => event.seq > boundary)
    const pending = pendingIn(inherited).filter(message => message.source.kind === 'user')
    inheritedQueuedInputs += pending.length
    assert.equal(pendingIn(child).length, 0, 'child inbox is durably settled')
    assert.equal(own.filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length, 0,
      'fork must never execute inherited trunk user input')
    const request = requests.find(entry => entry.to === coder.id
      && replies.some(reply => reply.replyTo === entry.id && reply.taskId === task.id) && entry.taskId === task.id)
    assert.ok(request, 'task has its own request/reply pair')
    assert.equal(own.filter(event => event.type === 'user/message' && event.data.source?.replyTo === request.id).length, 1,
      'one reply reaches the exact requester fork')
    for (const message of pending) {
      assert.ok(source.some(event => event.type === 'user/message' && event.data.id === message.id),
        'original trunk still executes its queued input')
    }
  }
  assert.ok(inheritedQueuedInputs > 0, 'scenario must actually fork across an unconsumed queued user instruction')
  const calls = mock().slice(callsBefore)
  const trunkCalls = calls.filter(call => call.session === (saved.bots[coder.id].sessionId ?? coder.id))
  assert.equal(trunkCalls.length, 0, 'recipient trunk must not run task work')
  const result = { round, tasks: tasks.length, requests: requests.length, replies: replies.length,
    endpoints: 4, inheritedQueuedInputs, replayedUserInputs: 0, recipientTrunkCalls: trunkCalls.length }
  results.push(result)
  console.log(JSON.stringify(result))
}
writeFileSync(join(home, 'task-routing-result.json'), JSON.stringify(results, null, 2) + '\n')
console.log('task routing smoke: both queued-delegation rounds passed')
