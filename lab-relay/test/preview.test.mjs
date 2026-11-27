import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { call, management } from '../relay-demo.mjs'

const url = process.env.PREVIEW_TEST_URL
const origin = process.env.RELAY_CONSOLE_PREVIEW_ORIGIN
const state = process.env.RELAY_CONSOLE_STATE
const auditLog = process.env.PREVIEW_TEST_AUDIT_LOG

test('preview starts locked and accepts only the approved browser for initial setup', { skip: !url }, async () => {
  assert.ok(origin && state)
  const password = randomBytes(20).toString('hex')
  const body = {
    username: 'previewadmin', password, confirmPassword: password, SelfUseModeEnabled: false, DemoSiteEnabled: false,
  }
  const outcomes = new Map()
  const submit = async (cookie, status, outcome, from = origin) => {
    const response = await fetch(url + '/api/setup', {
      method: 'POST', redirect: 'manual',
      headers: {
        'content-type': 'application/json', origin: from, 'x-relay-request-id': 'caller-supplied',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, status)
    const requestId = response.headers.get('x-relay-request-id')
    assert.match(requestId ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.ok(!outcomes.has(requestId))
    outcomes.set(requestId, outcome)
    return response
  }
  const getState = () => management(url, '/api/setup')
  assert.equal((await getState()).status, false)
  assert.equal((await getState()).root_init, false)
  const activation = await fetch(url + '/activate-setup')
  assert.equal(activation.status, 200)
  const setCookie = activation.headers.get('set-cookie')
  assert.ok(setCookie?.includes('; Secure; HttpOnly; SameSite=Strict;'))
  const cookie = setCookie.split(';')[0]
  const code = (await activation.text()).match(/<code>([a-f0-9]{20})<\/code>/)?.[1]
  assert.ok(code)
  await submit(cookie, 403, 'browser_not_approved')
  await submit(undefined, 403, 'browser_not_approved')
  assert.equal((await getState()).status, false)
  const approvalFile = join(state, 'setup.approved')
  await writeFile(approvalFile, code + '\n', { mode: 0o600, flag: 'wx' })
  const expired = new Date(Date.now() - 16 * 60_000)
  await utimes(approvalFile, expired, expired)
  await submit(cookie, 403, 'browser_not_approved')
  assert.equal((await getState()).root_init, false)
  const now = new Date()
  await utimes(approvalFile, now, now)
  const other = await fetch(url + '/activate-setup')
  await submit(other.headers.get('set-cookie').split(';')[0], 403, 'browser_not_approved')
  await submit(cookie, 403, 'origin_mismatch', 'https://other.example')
  const approved = await fetch(url + '/activate-setup', { headers: { cookie }, redirect: 'manual' })
  assert.equal(approved.status, 303)
  assert.equal(approved.headers.get('location'), '/setup')
  const completed = await submit(cookie, 200, 'administrator_created')
  assert.equal((await completed.json()).success, true)
  assert.equal((await getState()).status, true)
  await submit(cookie, 404, 'already_initialized')
  assert.equal((await call(url, '/api/user/register', { body: {} })).status, 404)

  const { access_token: token } = await management(url, '/api/user/login', {
    body: { username: body.username, password },
  })
  const { items } = await management(url, '/api/channel/', { token })
  assert.ok(items.some(channel => channel.models === 'gpt-4o-mini'))
  assert.ok(items.some(channel => channel.models === 'text-embedding-3-small'))

  if (auditLog) {
    const events = (await readFile(auditLog, 'utf8')).split('\n')
      .filter(line => line.startsWith('{"event":"relay.owner_setup",')).map(line => JSON.parse(line))
    assert.equal(events.length, outcomes.size)
    for (const entry of events) {
      assert.deepEqual(Object.keys(entry).sort(), ['at', 'event', 'outcome', 'requestId'])
      assert.equal(entry.outcome, outcomes.get(entry.requestId))
      outcomes.delete(entry.requestId)
    }
    assert.equal(outcomes.size, 0)
  }
})
