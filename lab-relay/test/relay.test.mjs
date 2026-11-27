import assert from 'node:assert/strict'
import test from 'node:test'

const url = process.env.DEMO_URL || 'http://127.0.0.1:9125'
const gateway = process.env.DEMO_GATEWAY_URL || 'http://127.0.0.1:9126'
const demo = (body) => fetch(`${url}/api/demo`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('serves a branded simulated workbench but no native administration endpoints', async () => {
  const page = await fetch(url + '/workspace')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /data-mode="demo"/)
  const logo = await fetch(url + '/immc-logo.png')
  assert.equal(logo.headers.get('content-type'), 'image/png')
  assert.equal((await fetch(url + '/api/workspace')).status, 404)
})

test('serves the trial page and routes chat completions through New API', async () => {
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /AI 资源中转站/)
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200)
  const response = await demo({ mode: 'chat', prompt: '检测中转' })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.endpoint, '/v1/chat/completions')
  assert.equal(body.model, 'gpt-4o-mini')
  assert.match(body.result, /收到 4 个字符/)
  assert.ok(body.tokens > 0)
})

test('routes embeddings to a different channel and returns usage', async () => {
  const response = await demo({ mode: 'embeddings', prompt: 'hello world' })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.endpoint, '/v1/embeddings')
  assert.equal(body.model, 'text-embedding-3-small')
  assert.deepEqual(body.result, [0.011, -0.218, 0.376, 0.149, -0.482, 0.061])
  assert.equal(body.tokens, 3)
})

test('closed gateway rejects unauthenticated direct calls and disables registration', async () => {
  const status = await fetch(`${gateway}/api/status`).then(response => response.json())
  assert.equal(status.success, true)
  assert.equal(status.data.version, 'v1.0.0-rc.51')
  assert.equal(status.data.register_enabled, false)
  assert.equal((await fetch(`${gateway}/v1/models`)).status, 401)
  for (const path of ['/v1/models', '/api/status', '/api/setup', '/api/channel/', '/api/token/']) {
    assert.equal((await fetch(url + path)).status, 404)
  }
  assert.equal((await fetch(url + '/api/setup', { method: 'POST' })).status, 404)
})

test('rejects unsupported operations, empty or oversized inputs, and non-JSON clients', async () => {
  for (const body of [
    { mode: 'constructor', prompt: 'hello' },
    { mode: ['chat'], prompt: 'hello' },
    { mode: { toString: null }, prompt: 'hello' },
    { mode: 'chat', prompt: ' ' },
    { mode: 'chat', prompt: '文'.repeat(301) },
  ]) {
    assert.equal((await demo(body)).status, 400)
  }
  assert.equal((await demo({ mode: 'chat', prompt: 'x'.repeat(4500) })).status, 413)
  const form = await fetch(`${url}/api/demo`, { method: 'POST', body: 'mode=chat' })
  assert.equal(form.status, 415)
})
