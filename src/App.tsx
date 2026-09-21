import { useEffect, useState } from 'react'
import { message } from 'antd'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { orderModule, imageEditModule, schematicModule, impositionModule, progressModule } from './modules'
import SchematicPage from './modules/schematic/SchematicPage'
import { ChevronDown } from 'lucide-react'
import './App.css'
import printflowIcon from './assets/printflow-icon.png'
import { SOFTWARE_ACCOUNT_NAME } from './config/account'
import { loadProductConfigs } from './modules/schematic/services/productConfigService'
const modules = [orderModule, imageEditModule, schematicModule, impositionModule, progressModule]
// React StrictMode mounts effects twice in development. Keep the startup
// refresh single-flight so two 9 MB responses cannot overlap and double the
// JSON parsing/transport peak.
let startupProductConfigRefresh: Promise<void> | undefined
export default function App() {
  const [notice, noticeContext] = message.useMessage()
  const [active, setActive] = useState('schematic')
  useEffect(() => {
    if (!isTauri()) return
    const key = 'product-config-startup'
    notice.open({ key, type: 'loading', content: '正在请求产品配置接口…', duration: 0 })
    startupProductConfigRefresh ??= invoke('refresh_product_configs').then(() => loadProductConfigs(true).then(() => undefined))
    void startupProductConfigRefresh.then(() => {
      notice.success({ key, content: '产品配置接口请求完成，已更新本地缓存', duration: 2.5 })
    }).catch(error => {
      notice.warning({ key, content: '产品配置接口请求失败，继续使用本地缓存', duration: 5 })
      console.warn('产品配置接口请求失败，继续使用本地缓存', error)
    })
  }, [notice])
  return <>{noticeContext}<div className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><img src={printflowIcon} alt="PrintFlow" /></div><span>PrintFlow</span></div><nav className="workflow">{modules.map(module => <button key={module.id} className={active === module.id ? 'active' : ''} onClick={() => setActive(module.id)}>{module.label}</button>)}</nav><button className="user-menu"><span className="avatar">{SOFTWARE_ACCOUNT_NAME.slice(0, 1)}</span><span>{SOFTWARE_ACCOUNT_NAME}</span><ChevronDown size={14}/></button></header>{active === 'schematic' && <SchematicPage />}</div></>
}




