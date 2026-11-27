import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { call, management } from '../relay-demo.mjs'

const origin = process.env.CONSOLE_URL
const password = process.env.RELAY_ADMIN_PASSWORD
const model = 'gpt-4o-mini'
const embeddings = 'text-embedding-3-small'

test('native management console on a fresh isolated instance', { skip: !origin }, async t => {
  assert.ok(password, 'RELAY_ADMIN_PASSWORD is required when CONSOLE_URL is set')
  const setOption = (token, key, value) =>
    management(origin, '/api/option/', { token, method: 'PUT', body: { key, value } })
  const login = (username, password) => management(origin, '/api/user/login', { body: { username, password } })
  const requestChat = token => call(origin, '/v1/chat/completions', {
    token, body: { model, messages: [{ role: 'user', content: 'Quota check' }], max_tokens: 100 },
  })
  const suffix = randomBytes(3).toString('hex')
  const groupA = 'lab-a-' + suffix
  const groupB = 'lab-b-' + suffix
  let admin
  let first
  let second
  let firstKey

  await t.test('serves the native UI, blocks setup writes and registration, and requires admin login', async () => {
    const html = await fetch(origin + '/')
    assert.equal(html.status, 200)
    assert.match(await html.text(), /<div id="root"[ >]/)
    assert.equal((await fetch(origin + '/api/setup', { method: 'POST' })).status, 404)
    assert.equal((await management(origin, '/api/setup')).status, true)
    const attempt = await call(origin, '/api/user/register', {
      body: { username: 'uninvited', password: randomBytes(20).toString('hex') },
    })
    assert.equal(attempt.data.success, false)
    assert.equal((await call(origin, '/api/channel/')).data.success, false)
    admin = (await login('labadmin', password)).access_token
    const channels = await management(origin, '/api/channel/', { token: admin })
    assert.ok(channels.items.some(channel => channel.models === model))
  })

  await t.test('assigns two labs distinct accounts and channel groups', async () => {
    await setOption(admin, 'GroupRatio', JSON.stringify({ default: 1, [groupA]: 1, [groupB]: 1 }))
    await setOption(admin, 'UserUsableGroups', JSON.stringify({ default: 'Default' }))
    await setOption(admin, 'ModelPrice', JSON.stringify({ 'lab-chat': 0.01 }))
    await management(origin, '/api/channel/', { token: admin, body: { mode: 'single', channel: {
      type: 1, key: 'local-simulation-only', name: 'Lab A simulation',
      models: `${model},lab-chat`, model_mapping: JSON.stringify({ 'lab-chat': model }),
      base_url: 'http://127.0.0.1:9133/chat', group: groupA, status: 1,
    } } })
    async function createLab(group) {
      const userPassword = randomBytes(20).toString('hex')
      await management(origin, '/api/user/', { token: admin, body: {
        username: group, password: userPassword, role: 1,
      } })
      const { items } = await management(origin, '/api/user/search?keyword=' + group, { token: admin })
      const user = items.find(item => item.username === group)
      assert.ok(user)
      await management(origin, '/api/user/', { token: admin, method: 'PUT', body: {
        id: user.id, username: user.username, display_name: user.display_name, group,
      } })
      await management(origin, '/api/user/manage', { token: admin, body: {
        id: user.id, action: 'add_quota', mode: 'override', value: 500000,
      } })
      const { access_token: token } = await login(group, userPassword)
      const groups = await management(origin, '/api/user/self/groups', { token })
      assert.ok(Object.hasOwn(groups, group))
      assert.ok(!Object.hasOwn(groups, group === groupA ? groupB : groupA))
      return { id: user.id, token }
    }
    first = await createLab(groupA)
    second = await createLab(groupB)
  })

  async function createKey(token, name, group, quota, limits) {
    await management(origin, '/api/token/', { token, body: {
      name, group, expired_time: -1, remain_quota: quota,
      model_limits_enabled: true, model_limits: limits,
    } })
    const { items } = await management(origin, '/api/token/', { token })
    const key = items.find(item => item.name === name)
    assert.ok(key)
    const secret = await management(origin, `/api/token/${key.id}/key`, { token, method: 'POST' })
    return { id: key.id, value: secret.key }
  }

  await t.test('enforces key scopes, blocks exhausted keys, and charges for usage', async () => {
    firstKey = await createKey(first.token, 'Scoped chat', groupA, 100000, `${model},lab-chat`)
    const empty = await createKey(first.token, 'Empty quota', groupA, 0, model)
    const secondKey = await createKey(second.token, 'Lab B chat', groupB, 100000, model)
    const chat = await requestChat(firstKey.value)
    assert.equal(chat.status, 200, chat.data.error?.message)
    assert.match(chat.data.choices[0].message.content, /本地模拟/)
    const mapped = await call(origin, '/v1/chat/completions', { token: firstKey.value, body: {
      model: 'lab-chat', messages: [{ role: 'user', content: 'Mapped model' }], max_tokens: 100,
    } })
    assert.equal(mapped.status, 200, mapped.data.error?.message)
    assert.match(mapped.data.choices[0].message.content, /本地模拟/)
    assert.equal((await call(origin, '/v1/embeddings', {
      token: firstKey.value, body: { model: embeddings, input: 'Disallowed model' },
    })).status, 403)
    assert.ok((await requestChat(empty.value)).status >= 400)
    assert.ok((await requestChat(secondKey.value)).status >= 400)
    const key = await management(origin, `/api/token/${firstKey.id}`, { token: first.token })
    assert.ok(key.remain_quota < 100000)
    const user = await management(origin, `/api/user/${first.id}`, { token: admin })
    assert.ok(user.quota < 500000)
  })

  await t.test('isolates key and usage records between the two lab accounts', async () => {
    const keys = await management(origin, '/api/token/', { token: second.token })
    assert.ok(!keys.items.some(item => item.id === firstKey.id))
    const allLogs = await management(origin, '/api/log/?type=2', { token: admin })
    const firstLogs = await management(origin, '/api/log/self?type=2', { token: first.token })
    const secondLogs = await management(origin, '/api/log/self?type=2', { token: second.token })
    assert.ok(allLogs.items.some(item => item.user_id === first.id && item.model_name === model))
    assert.ok(firstLogs.items.some(item => item.model_name === model))
    assert.ok(!secondLogs.items.some(item => item.model_name === model))
    assert.equal((await call(origin, '/api/log/', { token: second.token })).data.success, false)
  })
})

test('lab workspace shares native sessions, scopes members and saves branding', { skip: !origin }, async () => {
  const suffix = randomBytes(3).toString('hex')
  const username = 'member-' + suffix
  const brandName = '测试实验室 ' + suffix
  const memberPassword = randomBytes(20).toString('hex')
  const endpoint = origin + '/api/workspace'
  const callWorkspace = (token, body, requestOrigin = origin) => fetch(endpoint, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, origin: requestOrigin, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  const checked = async response => {
    const payload = await response.json()
    assert.equal(response.status, 200, payload.message)
    return payload.data
  }
  assert.match(await (await fetch(origin + '/workspace')).text(), /内蒙古大学多媒体计算实验室/)
  assert.equal((await fetch(endpoint)).status, 401)
  const login = await fetch(origin + '/api/user/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'labadmin', password }),
  })
  const cookie = login.headers.getSetCookie().find(value => value.includes('HttpOnly'))?.split(';')[0]
  assert.ok(cookie)
  const { access_token: admin } = await checked(await fetch(origin + '/api/user/auth/refresh', {
    method: 'POST', headers: { cookie },
  }))
  assert.equal((await checked(await callWorkspace(admin))).view, 'operator')
  await management(origin, '/api/user/', { token: admin, body: { username, password: memberPassword, role: 1 } })
  const loginMember = async () => (await management(origin, '/api/user/login', {
    body: { username, password: memberPassword },
  })).access_token
  let member = await loginMember()
  const initial = await checked(await callWorkspace(member))
  assert.equal(initial.view, 'member')
  assert.deepEqual(initial.members.map(row => row.id), [initial.self.id])
  const code = 'workspace-' + suffix
  const group = 'lab-' + code
  const create = { action: 'createLab', name: brandName, code }
  assert.equal((await callWorkspace(member, create)).status, 403)
  assert.equal((await callWorkspace(admin, create, 'https://different.example')).status, 403)
  assert.ok((await checked(await callWorkspace(admin, create))).labs.some(lab => lab.id === group))
  assert.equal((await callWorkspace(admin, create)).status, 409)
  const id = initial.self.id
  await checked(await callWorkspace(admin, { action: 'assignLab', id, group }))
  assert.equal((await callWorkspace(member)).status, 401, 'assigning a new routing group revokes the old session')
  member = await loginMember()
  await checked(await callWorkspace(admin, { action: 'setQuota', id, balance: 123456 }))
  const assigned = await checked(await callWorkspace(member))
  assert.deepEqual(assigned.labs, [{ id: group, name: brandName }])
  assert.equal(assigned.members[0].balance, 123456)
  assert.equal((await callWorkspace(member, { action: 'branding', name: 'Invalid' })).status, 403)
  assert.equal((await callWorkspace(admin, {
    action: 'branding', name: brandName, logo: 'data:image/png;base64,aGVsbG8=',
  })).status, 400)
  const logo = 'data:image/png;base64,' + (await readFile(new URL('../web/immc-logo.png', import.meta.url))).toString('base64')
  await checked(await callWorkspace(admin, { action: 'branding', name: brandName, logo }))
  assert.deepEqual((await checked(await callWorkspace(member))).brand, { name: brandName, logo })
  await checked(await callWorkspace(admin, { action: 'branding', name: brandName, logo: '' }))
  assert.equal((await checked(await callWorkspace(admin))).brand.logo, '')
})
