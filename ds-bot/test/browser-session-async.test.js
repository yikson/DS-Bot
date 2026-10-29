import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/browser-session-async.mjs', import.meta.url))
for (const scenario of [
  'popup-rejection',
  'request-rejection',
  'perform-rejection',
  'script-success',
  'script-rejection',
  'script-dispose',
  'settle-close',
  'download-close',
  'request-close',
]) {
  test(`browser session strict child: ${scenario}`, () => {
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', fixture, scenario], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    assert.ifError(child.error)
    assert.equal(child.signal, null, child.stderr)
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    assert.equal(child.stdout.trim(), scenario)
  })
}
