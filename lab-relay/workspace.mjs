import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const defaultLabName = '内蒙古大学多媒体计算实验室'
const rootRole = 100
const memberRole = 1
const maxLogoBytes = 256 * 1024
const maxBody = 360 * 1024
const label = value => typeof value === 'string' ? value.trim() : ''

class WorkspaceError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function userSummary(user) {
  return {
    id: user.id, name: user.display_name || user.username, group: user.group,
    balance: user.quota ?? 0, used: user.used_quota ?? 0, requests: user.request_count ?? 0,
  }
}

function validateLogo(logo) {
  if (logo === '') return logo
  const match = typeof logo === 'string' &&
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(logo)
  if (!match) throw new WorkspaceError(400, 'Logo 只支持 PNG、JPEG 或 WebP。')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length > maxLogoBytes) throw new WorkspaceError(400, 'Logo 不得超过 256 KB。')
  const valid = {
    png: bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    jpeg: bytes.subarray(0, 3).toString('hex') === 'ffd8ff',
    webp: bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
  }
  if (!valid[match[1]]) throw new WorkspaceError(400, 'Logo 文件格式不匹配。')
  return logo
}

function respond(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export async function workspaceAssets({ demo = false } = {}) {
  const assets = new Map()
  for (const [path, file, type] of [
    ['/workspace', 'workspace.html', 'text/html; charset=utf-8'],
    ['/workspace.js', 'workspace.js', 'text/javascript; charset=utf-8'],
    ['/workspace.css', 'workspace.css', 'text/css; charset=utf-8'],
  ]) {
    let contents = await readFile(new URL(`./web/${file}`, import.meta.url), 'utf8')
    if (file === 'workspace.html' && demo) contents = contents.replace('data-mode="native"', 'data-mode="demo"')
    assets.set(path, { contents, type })
  }
  assets.set('/immc-logo.png', {
    contents: await readFile(new URL('./web/immc-logo.png', import.meta.url)), type: 'image/png',
  })
  return (req, res) => {
    const asset = assets.get(req.url.split('?')[0])
    if (!asset || !['GET', 'HEAD'].includes(req.method)) return false
    res.writeHead(200, {
      'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    }).end(req.method === 'HEAD' ? undefined : asset.contents)
    return true
  }
}

export function workspaceApi({ upstream, state, origin, readJson }) {
  const file = join(state, 'workspace.json')
  let pending = Promise.resolve()
  const serialized = operation => {
    const result = pending.then(operation)
    pending = result.catch(() => {})
    return result
  }
  async function load() {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { brand: { name: defaultLabName, logo: '/immc-logo.png' }, labs: [] }
    }
  }
  async function save(config) {
    const tmp = `${file}.${randomUUID()}`
    try {
      await writeFile(tmp, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
      await rename(tmp, file)
    } finally {
      await rm(tmp, { force: true })
    }
  }
  async function native(token, path, { body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const result = await upstream(path, { body, method, token })
    if (result.status === 401) throw new WorkspaceError(401, '请登录 New API 后再打开工作台。')
    if (result.status === 403) throw new WorkspaceError(403, '没有权限执行该操作。')
    if (result.status !== 200 || !result.data?.success) throw new WorkspaceError(502, 'New API 未能完成操作。')
    return result.data.data
  }
  async function members(token) {
    const users = []
    for (let page = 1; page <= 100; page++) {
      const result = await native(token, `/api/user/?p=${page}&page_size=100`)
      users.push(...result.items)
      if (users.length >= result.total) return users.filter(user => user.role === memberRole).map(userSummary)
      if (!result.items.length) break
    }
    throw new WorkspaceError(503, '成员列表过大，请使用原生用户后台。')
  }
  async function snapshot(token, user) {
    const { brand, labs } = await load()
    const groups = [{ id: 'default', name: brand.name }, ...labs]
    const self = userSummary(user)
    if (user.role !== rootRole) {
      const lab = groups.find(group => group.id === user.group)
      return { brand, view: 'member', self, labs: lab ? [lab] : [], members: [self] }
    }
    return { brand, view: 'operator', self, labs: groups, members: await members(token) }
  }
  async function mutate(token, body) {
    const config = await load()
    if (body?.action === 'branding') {
      const name = label(body.name)
      if (!name || [...name].length > 60) throw new WorkspaceError(400, '平台名称应为 1–60 个字符。')
      config.brand = { name, logo: body.logo === undefined ? config.brand.logo : validateLogo(body.logo) }
      await save(config)
      return
    }
    if (body?.action === 'createLab') {
      const name = label(body.name)
      const code = label(body.code)
      if (!/^[a-z][a-z0-9-]{1,23}$/.test(code) || !name || [...name].length > 60) {
        throw new WorkspaceError(400, '请输入实验室名称，以及 2–24 位小写字母、数字或横线的标识。')
      }
      const id = `lab-${code}`
      const options = await native(token, '/api/option/')
      const ratios = JSON.parse(options.find(option => option.key === 'GroupRatio')?.value ?? '{}')
      if (config.labs.some(lab => lab.id === id) || Object.hasOwn(ratios, id)) {
        throw new WorkspaceError(409, '该实验室标识已存在。')
      }
      await native(token, '/api/option/', { method: 'PUT', body: {
        key: 'GroupRatio', value: JSON.stringify({ ...ratios, [id]: 1 }),
      } })
      config.labs.push({ id, name })
      await save(config)
      return
    }
    if (!['assignLab', 'setQuota'].includes(body?.action) ||
        !Number.isSafeInteger(body.id) || body.id < 1) throw new WorkspaceError(400, '无效的成员操作。')
    const target = await native(token, `/api/user/${body.id}`)
    if (target.role !== memberRole) throw new WorkspaceError(403, '工作台只管理普通成员。')
    if (body.action === 'assignLab') {
      if (body.group !== 'default' && !config.labs.some(lab => lab.id === body.group)) {
        throw new WorkspaceError(400, '请选择已创建的实验室。')
      }
      await native(token, '/api/user/', { method: 'PUT', body: {
        id: target.id, username: target.username, display_name: target.display_name, remark: target.remark, group: body.group,
      } })
      return
    }
    if (!Number.isSafeInteger(body.balance) || body.balance < 0 || body.balance > 1_000_000_000) {
      throw new WorkspaceError(400, '请输入不超过 10 亿的非负整数额度。')
    }
    await native(token, '/api/user/manage', { body: {
      id: target.id, action: 'add_quota', mode: 'override', value: body.balance,
    } })
  }
  return async (req, res) => {
    if (req.url !== '/api/workspace') return false
    try {
      const token = /^Bearer ([A-Za-z0-9._-]+)$/i.exec(req.headers.authorization ?? '')?.[1]
      if (!token) throw new WorkspaceError(401, '请登录 New API 后再打开工作台。')
      if (!['GET', 'POST'].includes(req.method)) throw new WorkspaceError(405, '请求方式不受支持。')
      const user = await native(token, '/api/user/self')
      if (req.method === 'POST') {
        if (user.role !== rootRole) throw new WorkspaceError(403, '只有平台运营管理员可以修改。')
        if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') {
          throw new WorkspaceError(403, '请求必须来自当前工作台。')
        }
        let body
        try { body = await readJson(req, maxBody) } catch { throw new WorkspaceError(400, '请求无效或文件太大。') }
        await serialized(() => mutate(token, body))
      }
      respond(res, 200, { success: true, data: await snapshot(token, user) })
    } catch (error) {
      const known = error instanceof WorkspaceError
      respond(res, known ? error.status : 500, {
        success: false, message: known ? error.message : '工作台暂时不可用。',
      })
    }
    return true
  }
}
