import { createHash, randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { readJson } from './relay-demo.mjs'

const cookieName = '__Host-relay_setup'
const lifetime = 900
const setupBodyLimit = 8192
const reference = value => createHash('sha256').update(value).digest('hex').slice(0, 20)

async function isApproved(file, claim) {
  const approval = await open(file).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!approval) return false
  try {
    const info = await approval.stat()
    return info.isFile() && Date.now() - info.mtimeMs < lifetime * 1000 &&
      (await approval.readFile('utf8')).trim() === reference(claim)
  } finally {
    await approval.close()
  }
}

function reply(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ success: false, message }))
}

function auditSetup(outcome) {
  console.info(JSON.stringify({ event: 'relay.owner_setup', outcome, at: new Date().toISOString() }))
}

export function ownerSetup({ origin, approvalFile, isInitialized, initialize }) {
  let initializing = false
  return async (req, res) => {
    let path
    try {
      if (!req.url.startsWith('/')) throw new Error('Expected origin-form')
      path = decodeURIComponent(new URL('http://localhost' + req.url).pathname)
        .replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
    } catch {
      reply(res, 400, 'Invalid path')
      return true
    }
    const isRead = req.method === 'GET' || req.method === 'HEAD'
    if (isInitialized()) {
      if ((!isRead && path === '/api/setup') || path === '/activate-setup' || path === '/api/user/register') {
        if (req.method === 'POST' && path === '/api/setup') auditSetup('already_initialized')
        reply(res, 404, 'Not found')
        return true
      }
      return false
    }

    const cookies = req.headers.cookie?.split(';').map(item => item.trim()) ?? []
    let claim = cookies.find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    if (claim && !/^[a-f0-9]{64}$/.test(claim)) claim = undefined
    const approved = origin && claim && await isApproved(approvalFile, claim)
    if (path === '/activate-setup' && req.method === 'GET') {
      if (approved) {
        res.writeHead(303, { location: '/setup', 'cache-control': 'no-store' }).end()
        return true
      }
      claim ??= randomBytes(32).toString('hex')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        'referrer-policy': 'no-referrer',
        'set-cookie': `${cookieName}=${claim}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600`,
      }).end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>New API 管理台初始化</title><main><h1>New API 管理台初始化</h1><p>把下方确认码发给 Product Engineer。码只用于确认当前浏览器，不是管理员密码。</p><p><code>${reference(claim)}</code></p><p>收到确认后，在同一浏览器刷新本页，再在原生初始化页设置账号和密码。不要把密码发到聊天。</p></main></html>`)
      return true
    }
    if (req.method === 'POST' && req.url === '/api/setup') {
      if (!approved || req.headers.origin !== origin) {
        auditSetup('authorization_refused')
        reply(res, 403, '请先从 /activate-setup 确认此浏览器。')
        return true
      }
      if (initializing) {
        auditSetup('initialization_in_progress')
        reply(res, 409, 'Setup in progress')
        return true
      }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
        auditSetup('invalid_content_type')
        reply(res, 415, 'JSON required')
        return true
      }
      initializing = true
      try {
        let body
        try { body = await readJson(req, setupBodyLimit) } catch {
          auditSetup('invalid_request')
          reply(res, 400, 'Invalid setup request')
          return true
        }
        const { status, data } = await initialize(body)
        auditSetup(status === 200 && data.success === true ? 'administrator_created' : 'initialization_refused')
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(data))
      } catch (error) {
        auditSetup('initialization_error')
        throw error
      } finally {
        initializing = false
      }
      return true
    }
    if (isRead && ['/', '/setup', '/api/setup', '/api/status', '/favicon.ico', '/logo.png', '/manifest.json'].includes(path)) return false
    if (isRead && req.url.startsWith('/static/') && path.startsWith('/static/')) return false
    reply(res, 404, 'Not found')
    return true
  }
}
