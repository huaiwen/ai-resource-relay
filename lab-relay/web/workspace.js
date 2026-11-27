const byId = id => document.getElementById(id)
const put = (id, text) => { byId(id).textContent = text }
const number = new Intl.NumberFormat('zh-CN')
const demo = document.body.dataset.mode === 'demo'
const storageKey = 'immc-demo-workspace-v1'
const fallbackBrand = { name: byId('brand-name').textContent, logo: '/immc-logo.png' }
const branding = byId('branding-form')
const editor = byId('editor')
const editForm = byId('editor-form')
const filter = byId('lab-filter')
let state
let auth
let edit

function element(tag, text) {
  const node = document.createElement(tag)
  node.textContent = text
  return node
}

async function request(path, options) {
  const response = await fetch(path, { ...options, cache: 'no-store', redirect: 'error' })
  const result = await response.json()
  if (!response.ok || !result.success) {
    const error = new Error(result.message || '请求失败，请稍后重试。')
    error.status = response.status
    throw error
  }
  return result.data
}

async function refresh() {
  auth = await request('/api/user/auth/refresh', {
    method: 'POST', headers: auth?.session?.sid ? { 'X-Auth-Session': auth.session.sid } : {},
  })
}

async function nativeState(body) {
  if (!auth || auth.access_expires_at * 1000 - Date.now() < 30_000) await refresh()
  const headers = { Authorization: `Bearer ${auth.access_token}` }
  if (body) headers['Content-Type'] = 'application/json'
  return request('/api/workspace', { headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) })
}

function exampleState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey))
    if (saved) return saved
  } catch { /* The demo also works if browser storage is unavailable. */ }
  return {
    brand: fallbackBrand, view: 'operator',
    labs: [{ id: 'default', name: fallbackBrand.name }, { id: 'lab-example', name: '联合研究组（示例）' }],
    members: [
      { id: 1, name: '多模态检索组', group: 'default', balance: 1850000, used: 150000, requests: 89 },
      { id: 2, name: '媒体安全组', group: 'default', balance: 948000, used: 52000, requests: 35 },
      { id: 3, name: '外部协作账号', group: 'lab-example', balance: 492000, used: 8000, requests: 12 },
    ],
  }
}

async function save(body) {
  if (!demo) {
    state = await nativeState(body)
  } else {
    const next = structuredClone(state)
    const member = next.members.find(row => row.id === body.id)
    if (body.action === 'branding') {
      next.brand = { name: body.name, logo: body.logo ?? next.brand.logo }
      next.labs.find(lab => lab.id === 'default').name = body.name
    } else if (body.action === 'createLab') {
      const id = `lab-${body.code}`
      if (next.labs.some(lab => lab.id === id)) throw new Error('该实验室标识已存在。')
      next.labs.push({ id, name: body.name })
    } else if (body.action === 'assignLab') {
      member.group = body.group
    } else {
      member.balance = body.balance
    }
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep changes for this page. */ }
    state = next
  }
  render()
}

function visibleMembers() {
  return filter.value ? state.members.filter(member => member.group === filter.value) : state.members
}

function renderMembers() {
  const operator = state.view === 'operator'
  const members = visibleMembers()
  put('member-count', number.format(members.length))
  put('member-detail', operator ? '当前所选实验室的普通账号' : '仅显示本人')
  for (const key of ['balance', 'used', 'requests']) {
    put(key, number.format(members.reduce((sum, row) => sum + row[key], 0)))
  }
  const rows = members.map(member => {
    const row = document.createElement('tr')
    const lab = state.labs.find(group => group.id === member.group)
    for (const value of [member.name, lab?.name || member.group || '未分配',
      ...['balance', 'used', 'requests'].map(key => number.format(member[key]))]) {
      row.append(element('td', value))
    }
    if (operator) {
      const cell = document.createElement('td')
      for (const [action, title] of [['assignLab', '分配'], ['setQuota', '设额度']]) {
        const button = element('button', title)
        button.className = 'secondary'
        button.setAttribute('aria-label', `${title} · ${member.name}`)
        button.addEventListener('click', () => showEditor(action, member))
        cell.append(button)
      }
      row.append(cell)
    }
    return row
  })
  if (!rows.length) {
    const row = document.createElement('tr')
    const cell = element('td', '这个实验室还没有成员。')
    cell.colSpan = operator ? 6 : 5
    row.append(cell)
    rows.push(row)
  }
  byId('member-rows').replaceChildren(...rows)
}

function render() {
  const operator = state.view === 'operator'
  const selected = filter.value
  filter.replaceChildren(new Option('全部', ''), ...state.labs.map(lab => new Option(lab.name, lab.id)))
  if (state.labs.some(lab => lab.id === selected)) filter.value = selected
  for (const id of ['scope-wrapper', 'actions-heading', 'create-lab', 'brand-nav', 'branding']) byId(id).hidden = !operator
  byId('users-link').hidden = demo || !operator
  byId('logout').hidden = demo
  byId('workbench').hidden = false
  put('brand-name', state.brand.name)
  document.title = `AI 工作台 · ${state.brand.name}`
  const logo = byId('brand-logo')
  if (state.brand.logo) logo.src = state.brand.logo
  else logo.removeAttribute('src')
  logo.hidden = !state.brand.logo
  branding.elements.name.value = state.brand.name
  put('members-note', operator ? '按实验室分组管理普通账号和额度；路由授权仍在 New API 配置。' : '你只能查看本人账号及额度。')
  renderMembers()
}

function showEditor(action, member) {
  edit = { action, id: member?.id }
  editForm.reset()
  put('editor-title', { createLab: '新增实验室', assignLab: `分配实验室：${member?.name}`, setQuota: `修改额度：${member?.name}` }[action])
  const fields = {
    'lab-name-field': action === 'createLab', 'lab-code-field': action === 'createLab',
    'member-lab-field': action === 'assignLab', 'member-quota-field': action === 'setQuota',
  }
  for (const [id, active] of Object.entries(fields)) {
    const field = byId(id)
    field.hidden = !active
    field.querySelector('input, select').required = active
  }
  editForm.elements.group.replaceChildren(...state.labs.map(lab => new Option(lab.name, lab.id)))
  if (member) {
    editForm.elements.group.value = member.group
    editForm.elements.balance.value = member.balance
  }
  put('editor-error', '')
  editor.showModal()
}

function readLogo(file) {
  if (file.size > 256 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('请选择不超过 256 KB 的 PNG、JPEG 或 WebP。')
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('无法读取 Logo。'))
    reader.readAsDataURL(file)
  })
}

function submit(form, errorId, operation) {
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const button = form.querySelector('[type=submit]')
    button.disabled = true
    put(errorId, '')
    try { await operation(form.elements) } catch (error) { put(errorId, error.message || '保存失败。') }
    finally { button.disabled = false }
  })
}

submit(branding, 'brand-result', async fields => {
  const name = fields.name.value.trim()
  if (!name) throw new Error('请输入平台名称。')
  const file = fields.logo.files[0]
  const logo = fields.clear.checked ? '' : file ? await readLogo(file) : undefined
  await save({ action: 'branding', name, logo })
  fields.logo.value = ''
  fields.clear.checked = false
  put('brand-result', demo ? '已保存到此浏览器。' : '已保存。')
})

submit(editForm, 'editor-error', async fields => {
  const body = { ...edit }
  if (edit.action === 'createLab') {
    body.name = fields.name.value.trim()
    body.code = fields.code.value.trim()
    if (!body.name || !/^[a-z][a-z0-9-]{1,23}$/.test(body.code)) throw new Error('请输入名称与有效标识。')
  } else if (edit.action === 'assignLab') {
    body.group = fields.group.value
  } else {
    body.balance = fields.balance.valueAsNumber
  }
  await save(body)
  editor.close()
})
filter.addEventListener('change', renderMembers)
byId('create-lab').addEventListener('click', () => showEditor('createLab'))
byId('cancel-edit').addEventListener('click', () => editor.close())
byId('logout').addEventListener('click', async () => {
  try {
    await request('/api/user/auth/logout', { method: 'POST', headers: {
      'X-Auth-Session': auth.session.sid, Authorization: `Bearer ${auth.access_token}`,
    } })
    location.reload()
  } catch { put('notice', '退出未完成，请在 New API 后台退出。') }
})

const primary = byId('primary-action')
byId('after-sign-in').addEventListener('click', () => location.reload())
if (demo) {
  state = exampleState()
  put('environment', '模拟环境')
  put('notice', '可以直接试用。成员与额度为示例，编辑仅保存在此浏览器；模型请求走真实 New API 网关和本地模拟上游。')
  primary.textContent = '试用模型'
  primary.href = '/'
  primary.removeAttribute('target')
  byId('models-link').href = '/'
  put('models-link', '试用聊天与向量 →')
  put('keys-copy', '正式版在 New API 管理自己的项目密钥；演示不发放密钥。')
  put('branding-note', '此处仅预览品牌，不会修改其他用户看到的名称和 Logo。')
  for (const id of ['keys-link', 'usage-link']) byId(id).hidden = true
  render()
} else {
  try {
    const setup = await request('/api/setup')
    if (!setup.status) {
      primary.hidden = true
      put('notice', '正式控制台尚未开通；没有管理员账号。')
    } else {
      state = await nativeState()
      const operator = state.view === 'operator'
      put('notice', `已登录：${state.self.name} · ${operator ? '平台运营管理员' : '普通成员'}`)
      primary.href = operator ? '/channels' : '/dashboard'
      primary.textContent = operator ? '打开 New API 后台' : '打开 New API'
      if (!operator) {
        byId('models-link').href = '/pricing'
        put('models-link', '查看模型与价格 →')
      }
      render()
    }
  } catch (error) {
    if (error.status === 401) {
      byId('after-sign-in').hidden = false
      put('notice', '请在新标签页登录 New API，再回此页刷新。')
    } else {
      put('notice', '工作台暂时不可用，请稍后刷新。')
    }
  }
}
