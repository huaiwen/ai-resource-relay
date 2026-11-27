const form = document.querySelector('#demo')
const prompt = document.querySelector('#prompt')
const endpoint = document.querySelector('#endpoint')
const state = document.querySelector('#state')
const result = document.querySelector('#result')
const send = form.querySelector('button')
const metric = Object.fromEntries(['route', 'tokens', 'duration'].map(id => [id, document.getElementById(id)]))

function update() {
  document.querySelector('#counter').textContent = `${prompt.value.length} / ${prompt.maxLength}`
  endpoint.textContent = form.elements.mode.value === 'chat' ? 'POST /v1/chat/completions' : 'POST /v1/embeddings'
}
form.addEventListener('input', update)
update()

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (send.disabled) return
  send.disabled = true
  state.textContent = '处理中'
  result.textContent = '正在等待网关响应…'
  for (const element of Object.values(metric)) element.textContent = '—'
  try {
    const response = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: form.elements.mode.value, prompt: prompt.value }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    state.textContent = '200 · 请求成功'
    result.textContent = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)
    metric.route.textContent = data.route
    metric.tokens.textContent = data.tokens ?? '—'
    metric.duration.textContent = `${data.duration_ms} ms`
  } catch (error) {
    state.textContent = '请求失败'
    result.textContent = error.message || '暂时无法连接网关，请重试。'
  } finally {
    send.disabled = false
  }
})
