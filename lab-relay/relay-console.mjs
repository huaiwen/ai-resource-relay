import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { call, listen, local, readJson, seedConsole, setup } from './relay-demo.mjs'
import { ownerSetup } from './console-owner-setup.mjs'
import { workspaceApi, workspaceAssets } from './workspace.mjs'

const state = resolve(process.env.RELAY_CONSOLE_STATE ||
  join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'ai-relay-console'))
const dataDir = join(state, 'data')
const bridgeDir = join(state, 'bridge')
const socketPath = join(bridgeDir, 'native.sock')
const sitePort = Number(process.env.PORT || 9129)
const readyFile = join(dataDir, '.initialized')
const fixtureOrigin = 'http://127.0.0.1:9133'
const fixtureKey = 'local-simulation-only'
const preview = process.env.RELAY_CONSOLE_PREVIEW === '1'
const previewOrigin = process.env.RELAY_CONSOLE_PREVIEW_ORIGIN
if (previewOrigin && (!preview || new URL(previewOrigin).origin !== previewOrigin ||
    !previewOrigin.startsWith('https://'))) {
  throw new Error('RELAY_CONSOLE_PREVIEW_ORIGIN requires preview mode and the exact HTTPS origin')
}
const blockedHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const requestHeaders = new Set(['accept', 'accept-encoding', 'accept-language', 'authorization', 'content-encoding',
  'content-length', 'content-type', 'host', 'if-modified-since', 'if-none-match', 'origin', 'referer', 'sec-fetch-site',
  'user-agent', 'x-requested-with', 'x-auth-session', 'x-security-proof',
  'anthropic-version', 'anthropic-beta', 'x-api-key', 'x-goog-api-key'])

function proxy(req, res) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => requestHeaders.has(key)))
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').map(item => item.trim())
      .filter(item => /^(new_api_refresh|new_api_has_session)=/.test(item))
    if (cookies.length) headers.cookie = cookies.join('; ')
  }
  const upstream = request({ socketPath, method: req.method, path: req.url, headers }, response => {
    const relayHeaders = Object.fromEntries(Object.entries(response.headers)
      .filter(([key]) => !blockedHeaders.has(key)))
    res.writeHead(response.statusCode, relayHeaders)
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (res.headersSent) res.destroy()
    else res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('New API 暂时不可用')
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

function internal(path, { method, body, token }) {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = { accept: 'application/json' }
  if (payload !== null) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = Buffer.byteLength(payload)
  }
  if (token) headers.authorization = `Bearer ${token}`
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers, signal: AbortSignal.timeout(8000) }, async res => {
      try {
        const chunks = []
        for await (const chunk of res) chunks.push(chunk)
        resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) })
      } catch (error) {
        reject(error)
      }
    })
    req.once('error', reject)
    req.end(payload)
  })
}

await mkdir(dataDir, { recursive: true, mode: 0o700 })
await mkdir(bridgeDir, { recursive: true, mode: 0o700 })
const password = process.env.RELAY_ADMIN_PASSWORD
delete process.env.RELAY_ADMIN_PASSWORD
const imageScript = fileURLToPath(new URL('./console-image.sh', import.meta.url))
const image = execFileSync(imageScript, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const name = 'ai-relay-console-' + createHash('sha256').update(state).digest('hex').slice(0, 16)
const docker = spawn('docker', ['run', '--rm', '--init', '--pull=never', '--network=none', '--read-only', '--name', name,
  '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=1024m', '--pids-limit=256',
  '--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
  '--mount', `type=bind,src=${dataDir},dst=/data`, '--mount', `type=bind,src=${bridgeDir},dst=/bridge`,
  ...(previewOrigin ? ['--env', `RELAY_CONSOLE_PREVIEW_ORIGIN=${previewOrigin}`] : []),
  image], { stdio: 'inherit' })

let service
let stopped = false
async function stop(exitCode) {
  if (stopped) return
  stopped = true
  service?.close()
  if (docker.exitCode === null && docker.signalCode === null) {
    const exited = new Promise(resolve => docker.once('close', resolve))
    docker.kill()
    await Promise.race([exited, delay(6000)])
  }
  process.exit(exitCode)
}
docker.on('error', error => { console.error(error.message); void stop(1) })
docker.on('exit', () => { if (!stopped) void stop(1) })
process.once('SIGINT', () => void stop(0))
process.once('SIGTERM', () => void stop(0))

try {
  let setupStatus
  for (let count = 0; count < 100; count++) {
    try {
      const { data } = await call(internal, '/api/setup')
      if (data?.success === true) { setupStatus = data.data; break }
    } catch { /* Wait for the container to accept connections. */ }
    await delay(200)
  }
  if (!setupStatus) throw new Error('New API container did not get ready')
  let initialized = setupStatus.status
  if (!preview && initialized) {
    const ready = await stat(readyFile).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!ready?.isFile()) {
      throw new Error('Previous bootstrap did not finish; use a fresh RELAY_CONSOLE_STATE directory')
    }
  } else if (!preview) {
    if (!password || password.length < 16) {
      throw new Error('First startup requires RELAY_ADMIN_PASSWORD with at least 16 characters')
    }
    const token = await setup(internal, fixtureOrigin, fixtureKey, () => !stopped, {
      username: 'labadmin', password, siteName: '实验室 AI 中转站',
    })
    const probe = await call(internal, '/v1/chat/completions', { token, body: {
      model: 'gpt-4o-mini', messages: [{ role: 'user', content: '初始化演示' }], max_tokens: 100,
    } })
    if (probe.status !== 200 || !probe.data.choices?.length) throw new Error('Simulated upstream did not respond')
    await writeFile(readyFile, '', { mode: 0o600, flag: 'wx' })
    initialized = true
  }
  const handleSetup = ownerSetup({
    origin: previewOrigin,
    approvalFile: join(state, 'setup.approved'),
    isInitialized: () => initialized,
    async initialize(body) {
      const result = await call(internal, '/api/setup', { body })
      if (result.status === 200 && result.data.success) {
        initialized = true
        try {
          await seedConsole(internal, fixtureOrigin, fixtureKey, {
            username: body.username, password: body.password, siteName: '实验室 AI 中转站',
          })
          await writeFile(readyFile, '', { mode: 0o600, flag: 'wx' })
        } catch {
          console.error('Administrator was created; check registration and add the simulated channels from the console.')
        }
      }
      return result
    },
  })
  const serveWorkspace = await workspaceAssets()
  const handleWorkspace = workspaceApi({
    upstream: internal, readJson, state, origin: previewOrigin || `http://${local}:${sitePort}`,
  })
  service = createServer({ requestTimeout: 30000 }, async (req, res) => {
    try {
      if (!preview && req.headers.host !== `${local}:${sitePort}`) return res.writeHead(421).end()
      if (serveWorkspace(req, res) || await handleSetup(req, res) || await handleWorkspace(req, res)) return
      proxy(req, res)
    } catch {
      if (res.headersSent) res.destroy()
      else res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end('{"success":false,"message":"Setup temporarily unavailable"}')
    }
  })
  await listen(service, sitePort)
  console.log(`Native New API console ready on port ${sitePort}`)
} catch (error) {
  console.error(error.message)
  await stop(1)
}
