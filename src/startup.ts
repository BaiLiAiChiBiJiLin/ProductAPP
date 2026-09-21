import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

const showWindow = () => {
  if (isTauri()) void getCurrentWindow().show().catch(console.error)
}
// Paint the static splash before revealing the WebView or loading the React tree.
requestAnimationFrame(() => requestAnimationFrame(showWindow))
const retry = document.getElementById('startup-retry')!
retry.onclick = () => window.location.reload()
const failed = () => {
  const message = document.getElementById('startup-message')
  if (message) message.textContent = '启动未完成，请尝试重新加载。'
  retry.hidden = false
  showWindow()
}
const timeout = window.setTimeout(failed, 30000)
window.addEventListener('printflow-ui-ready', () => {
  clearTimeout(timeout)
  const splash = document.getElementById('startup-screen')
  if (!splash) return
  splash.style.opacity = '0'
  splash.style.pointerEvents = 'none'
  window.setTimeout(() => splash.remove(), 200)
}, { once: true })
void import('./main.tsx').catch(error => { console.error('PrintFlow 启动失败', error); clearTimeout(timeout); failed() })
