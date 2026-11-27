import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, request } from 'node:http'
import { chmod, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fixture, listen, local } from './relay-demo.mjs'

const socket = '/bridge/native.sock'
const origin = process.env.RELAY_CONSOLE_PREVIEW_ORIGIN
const gatewayPort = 3000
process.umask(0o077)
const seed = fixture('local-simulation-only')
await listen(seed, 9133)
const gateway = spawn('/bin/new-api', ['--log-dir', '/data/logs'], {
  env: {
    HOME: '/data', HOST: local, PORT: String(gatewayPort), SQLITE_PATH: '/data/gateway.sqlite',
    SESSION_SECRET: randomBytes(32).toString('hex'), TRUSTED_PROXIES: 'none',
    ...(origin ? { SESSION_COOKIE_SECURE: 'true', SESSION_COOKIE_TRUSTED_URL: origin } : {}),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})

await rm(socket, { force: true })
const bridge = createServer({ requestTimeout: 60000 }, (req, res) => {
  const upstream = request({
    hostname: local, port: gatewayPort, method: req.method, path: req.url, headers: req.headers,
  }, response => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (res.headersSent) res.destroy()
    else res.writeHead(502).end()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
})
await new Promise((resolve, reject) => {
  bridge.once('error', reject)
  bridge.listen(socket, resolve)
})
await chmod(socket, 0o600)

let stopping = false
async function stop(exitCode) {
  if (stopping) return
  stopping = true
  bridge.close()
  seed.close()
  if (gateway.exitCode === null && gateway.signalCode === null) {
    const exited = new Promise(resolve => gateway.once('close', resolve))
    gateway.kill()
    await Promise.race([exited, delay(4000)])
    if (gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill('SIGKILL')
      await exited
    }
  }
  await rm(socket, { force: true })
  process.exit(exitCode)
}
gateway.on('error', error => { console.error(error.message); void stop(1) })
gateway.on('exit', () => { if (!stopping) void stop(1) })
process.once('SIGTERM', () => void stop(0))
process.once('SIGINT', () => void stop(0))
