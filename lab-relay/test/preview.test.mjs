import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { call, management } from '../relay-demo.mjs'

const url = process.env.PREVIEW_TEST_URL
const origin = process.env.RELAY_CONSOLE_PREVIEW_ORIGIN
const state = process.env.RELAY_CONSOLE_STATE

test('preview starts locked and accepts only the approved browser for initial setup', { skip: !url }, async () => {
  assert.ok(origin && state)
  const password = randomBytes(20).toString('hex')
  const body = {
    username: 'previewadmin', password, confirmPassword: password, SelfUseModeEnabled: false, DemoSiteEnabled: false,
  }
  const submit = (cookie, from = origin) => fetch(url + '/api/setup', {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', origin: from, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
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
  assert.equal((await submit(cookie)).status, 403)
  assert.equal((await submit()).status, 403)
  assert.equal((await getState()).status, false)
  await writeFile(join(state, 'setup.approved'), code + '\n', { mode: 0o600, flag: 'wx' })
  const other = await fetch(url + '/activate-setup')
  assert.equal((await submit(other.headers.get('set-cookie').split(';')[0])).status, 403)
  assert.equal((await submit(cookie, 'https://other.example')).status, 403)
  const approved = await fetch(url + '/activate-setup', { headers: { cookie }, redirect: 'manual' })
  assert.equal(approved.status, 303)
  assert.equal(approved.headers.get('location'), '/setup')
  const completed = await submit(cookie)
  assert.equal(completed.status, 200)
  assert.equal((await completed.json()).success, true)
  assert.equal((await getState()).status, true)
  assert.equal((await submit(cookie)).status, 404)
  assert.equal((await call(url, '/api/user/register', { body: {} })).status, 404)

  const { access_token: token } = await management(url, '/api/user/login', {
    body: { username: body.username, password },
  })
  const { items } = await management(url, '/api/channel/', { token })
  assert.ok(items.some(channel => channel.models === 'gpt-4o-mini'))
  assert.ok(items.some(channel => channel.models === 'text-embedding-3-small'))
})
