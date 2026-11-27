import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const local = '127.0.0.1'
const models = {
  chat: { name: 'gpt-4o-mini', endpoint: '/v1/chat/completions', label: '文本对话' },
  embeddings: { name: 'text-embedding-3-small', endpoint: '/v1/embeddings', label: '文本向量' },
}
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/demo.css': ['demo.css', 'text/css; charset=utf-8'],
  '/demo.js': ['demo.js', 'text/javascript; charset=utf-8'],
}
const maxBody = 4096
const maxPrompt = 300
const expiry = 8000

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req, limit = maxBody) {
  const chunks = []
  let length = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > limit) {
      req.resume()
      throw new Error('request too large')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

function listen(server, port, host = local) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

async function call(origin, path, { body, method = body === undefined ? 'GET' : 'POST', token } = {}) {
  if (typeof origin === 'function') return origin(path, { body, method, token })
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(origin + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(expiry),
  })
  const data = await response.json()
  return { status: response.status, data }
}

async function management(origin, path, options) {
  const { status, data } = await call(origin, path, options)
  if (status !== 200 || data?.success !== true) {
    throw new Error(`New API setup failed: ${path} (${status}) ${data?.message || ''}`)
  }
  return data.data
}

function fixture(key) {
  return createServer({ requestTimeout: 12000 }, async (req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${key}`) {
      return json(res, 401, { error: 'fixture authorization required' })
    }
    try {
      const body = await readJson(req)
      const chat = models.chat
      const embeddings = models.embeddings
      if (req.url === `/chat${chat.endpoint}` && body.model === chat.name) {
        const text = body.messages?.at(-1)?.content
        if (typeof text !== 'string') return json(res, 400, { error: 'missing prompt' })
        const size = [...text].length
        const meta = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: chat.name }
        const content = `已收到 ${size} 个字符。New API 已将请求转发到对话演示渠道，并将响应返回到此页面。此回复由本地模拟服务生成。`
        const promptTokens = Math.max(1, Math.ceil(size / 4))
        const usage = { prompt_tokens: promptTokens, completion_tokens: 23, total_tokens: promptTokens + 23 }
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
          const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({
            ...meta, object: 'chat.completion.chunk', choices, ...extra,
          })}\n\n`)
          chunk([{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }])
          chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
          if (body.stream_options?.include_usage === true) chunk([], { usage })
          return res.end('data: [DONE]\n\n')
        }
        return json(res, 200, {
          ...meta, object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: {
            role: 'assistant', content,
          } }],
          usage,
        })
      }
      if (req.url === `/embeddings${embeddings.endpoint}` && body.model === embeddings.name) {
        if (typeof body.input !== 'string') return json(res, 400, { error: 'missing input' })
        const size = [...body.input].length
        const inputTokens = Math.max(1, Math.ceil(size / 4))
        return json(res, 200, {
          object: 'list', model: embeddings.name,
          data: [{ object: 'embedding', index: 0, embedding: [size / 1000, -0.218, 0.376, 0.149, -0.482, 0.061] }],
          usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
        })
      }
      return json(res, 404, { error: 'unknown fixture route' })
    } catch {
      return json(res, 400, { error: 'invalid fixture request' })
    }
  })
}

async function setup(origin, fixtureOrigin, fixtureKey, isRunning, account = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await management(origin, '/api/status')
      break
    } catch (error) {
      if (!isRunning() || attempt >= 80) throw error
      await delay(250)
    }
  }
  const password = account.password ?? `A3!${randomBytes(24).toString('hex')}`
  const username = account.username ?? 'relay-demo'
  await management(origin, '/api/setup', { body: { username, password, confirmPassword: password,
    SelfUseModeEnabled: !account.username, DemoSiteEnabled: false } })
  const admin = await seedConsole(origin, fixtureOrigin, fixtureKey, { username, password, siteName: account.siteName })
  const tokenName = 'browser-demo'
  await management(origin, '/api/token/', { token: admin, body: {
    name: tokenName, expired_time: -1, remain_quota: 10000000,
    model_limits_enabled: true, model_limits: Object.values(models).map(model => model.name).join(','),
    allow_user_quota_query: false, group: 'default',
  } })
  const { items } = await management(origin, '/api/token/', { token: admin })
  const tokenId = items.find(item => item.name === tokenName)?.id
  if (!tokenId) throw new Error('Demo key was not created')
  const token = await management(origin, `/api/token/${tokenId}/key`, { method: 'POST', token: admin })
  return token.key
}

async function seedConsole(origin, fixtureOrigin, fixtureKey, { username, password, siteName }) {
  const login = await management(origin, '/api/user/login', { body: { username, password } })
  const admin = login.access_token
  for (const key of ['RegisterEnabled', 'PasswordRegisterEnabled']) {
    await management(origin, '/api/option/', { method: 'PUT', token: admin, body: { key, value: false } })
  }
  if (siteName) {
    await management(origin, '/api/option/', {
      method: 'PUT', token: admin, body: { key: 'SystemName', value: siteName },
    })
  }
  for (const [id, model] of Object.entries(models)) {
    await management(origin, '/api/channel/', { token: admin, body: { mode: 'single', channel: {
      type: 1, key: fixtureKey, name: `Demo · ${model.label}`, models: model.name,
      base_url: `${fixtureOrigin}/${id}`, group: 'default', status: 1,
    } } })
  }
  return admin
}

function demoApp(staticFiles, gateway, token, serveWorkspace) {
  let active = 0
  return createServer({ requestTimeout: 12000, headersTimeout: 8000 }, async (req, res) => {
    if (serveWorkspace(req, res)) return
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'")
    const path = req.url.split('?')[0]
    const asset = staticFiles.get(path)
    if ((req.method === 'GET' || req.method === 'HEAD') && asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' })
      return res.end(asset.contents)
    }
    if (req.method !== 'POST' || path !== '/api/demo') return json(res, 404, { error: '页面不存在。' })
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') {
      return json(res, 415, { error: '请发送 JSON 请求。' })
    }
    if (Number(req.headers['content-length']) > maxBody) {
      req.resume()
      return json(res, 413, { error: '请求太大。' })
    }
    if (active >= 12) return json(res, 429, { error: '试用服务繁忙，请稍后再试。' })
    active++
    try {
      let input
      try {
        input = await readJson(req)
      } catch {
        return json(res, 400, { error: '请求无效或已超出长度限制。' })
      }
      const { mode, prompt } = input ?? {}
      if (typeof mode !== 'string' || !Object.hasOwn(models, mode) ||
          typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > maxPrompt) {
        return json(res, 400, { error: `请选择任务，并输入 1–${maxPrompt} 个字符。` })
      }
      const model = models[mode]
      const body = mode === 'chat'
        ? { model: model.name, messages: [{ role: 'user', content: prompt.trim() }], max_tokens: 100 }
        : { model: model.name, input: prompt.trim() }
      const started = performance.now()
      const { status, data } = await call(gateway, model.endpoint, { body, token })
      const result = mode === 'chat' ? data.choices?.[0]?.message?.content : data.data?.[0]?.embedding
      if (status !== 200 || result == null) throw new Error(`unexpected gateway status ${status}`)
      return json(res, 200, {
        result, model: model.name, endpoint: model.endpoint, route: model.label,
        tokens: data.usage?.total_tokens ?? null, duration_ms: Math.round(performance.now() - started),
      })
    } catch (error) {
      console.error('Demo relay failed:', error.message)
      return json(res, 502, { error: '演示网关暂时不可用，请稍后重试。' })
    } finally {
      active--
    }
  })
}

async function main() {
  const installer = fileURLToPath(new URL('./install-new-api.sh', import.meta.url))
  const binary = execFileSync(installer, { encoding: 'utf8' }).trim()
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  await mkdir(stateHome, { recursive: true, mode: 0o700 })
  const state = await mkdtemp(join(stateHome, 'ai-relay-demo-'))
  const key = randomBytes(24).toString('hex')
  const upstream = fixture(key)
  let gateway
  let app
  let shuttingDown = false
  const stop = async (exitCode) => {
    if (shuttingDown) return
    shuttingDown = true
    app?.close()
    upstream.close()
    if (gateway?.exitCode === null && gateway.signalCode === null) {
      const closed = new Promise(resolve => gateway.once('close', resolve))
      gateway.kill()
      await Promise.race([closed, delay(5000)])
      if (gateway.exitCode === null && gateway.signalCode === null) {
        gateway.kill('SIGKILL')
        await closed
      }
    }
    await rm(state, { recursive: true, force: true })
    process.exit(exitCode)
  }
  process.once('SIGTERM', () => void stop(0))
  process.once('SIGINT', () => void stop(0))
  try {
    const fixturePort = await listen(upstream, 0)
    const gatewayPort = Number(process.env.DEMO_GATEWAY_PORT || 9126)
    const gatewayOrigin = `http://${local}:${gatewayPort}`
    gateway = spawn(binary, ['--log-dir', join(state, 'logs')], {
      cwd: state,
      env: {
        HOME: state, HOST: local, PORT: String(gatewayPort), TRUSTED_PROXIES: 'none',
        SESSION_SECRET: randomBytes(32).toString('hex'), SQLITE_PATH: join(state, 'gateway.sqlite'),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    gateway.on('error', error => { console.error(error.message); void stop(1) })
    gateway.on('exit', code => { if (!shuttingDown) { console.error(`New API exited (${code})`); void stop(1) } })
    const token = await setup(gatewayOrigin, `http://${local}:${fixturePort}`, key, () => gateway.exitCode === null)
    const staticFiles = new Map(await Promise.all(Object.entries(assets).map(async ([path, [file, type]]) =>
      [path, { type, contents: await readFile(new URL(`./web/${file}`, import.meta.url)) }])))
    const { workspaceAssets } = await import('./workspace.mjs')
    app = demoApp(staticFiles, gatewayOrigin, token, await workspaceAssets({ demo: true }))
    const port = await listen(app, Number(process.env.PORT || 9125), '0.0.0.0')
    console.log(`AI relay demo ready on port ${port}`)
  } catch (error) {
    console.error(error.message)
    await stop(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()

export { call, fixture, listen, local, management, readJson, seedConsole, setup }
