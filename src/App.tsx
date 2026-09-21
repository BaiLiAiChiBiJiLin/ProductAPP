import { useEffect, useState } from 'react'
import { Button, Dropdown, Input, message } from 'antd'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { orderModule, imageEditModule, schematicModule, impositionModule, progressModule } from './modules'
import SchematicPage from './modules/schematic/SchematicPage'
import { Check, ChevronDown, UserRound } from 'lucide-react'
import './App.css'
import './module-shell.css'
import printflowIcon from './assets/printflow-icon.png'
import { SOFTWARE_ACCOUNT_NAME } from './config/account'
import { loadProductConfigs } from './modules/schematic/services/productConfigService'
import UpdateButton from './modules/update/UpdateButton'
const modules = [orderModule, imageEditModule, schematicModule, impositionModule, progressModule]
// React StrictMode mounts effects twice in development. Keep the startup
// refresh single-flight so two 9 MB responses cannot overlap and double the
// JSON parsing/transport peak.
let startupProductConfigRefresh: Promise<void> | undefined
export default function App() {
  const [notice, noticeContext] = message.useMessage()
  const [active, setActive] = useState('schematic')
  const [leaving, setLeaving] = useState<string | null>(null)
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(null), 540)
    return () => window.clearTimeout(timer)
  }, [active, leaving])
  const [visitedModules, setVisitedModules] = useState(() => new Set(['schematic']))
  const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward')
  const activeIndex = modules.findIndex(module => module.id === active)
  const [accountName, setAccountName] = useState(() => localStorage.getItem('printflow-account-name') || SOFTWARE_ACCOUNT_NAME)
  const [draftAccountName, setDraftAccountName] = useState(accountName)
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
  const userMenu = <div className="account-popover"><div className="account-popover-title"><UserRound size={16}/>用户信息</div><label>用户名<Input size="small" value={draftAccountName} maxLength={30} onChange={event => setDraftAccountName(event.target.value)} onPressEnter={() => { const value = draftAccountName.trim(); if (value) { localStorage.setItem('printflow-account-name', value); setAccountName(value); message.success('用户名已保存') } }}/></label><Button type="primary" size="small" icon={<Check size={14}/>} onClick={() => { const value = draftAccountName.trim(); if (value) { localStorage.setItem('printflow-account-name', value); setAccountName(value); message.success('用户名已保存') } }}>保存</Button><UpdateButton /></div>
  const switchModule = (id: string) => {
    if (id === active) return
    const nextIndex = modules.findIndex(module => module.id === id)
    setTransitionDirection(nextIndex >= activeIndex ? 'forward' : 'backward')
    setVisitedModules(current => new Set(current).add(id))
    setLeaving(active)
    setActive(id)
  }
  return <>{noticeContext}<div className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><img src={printflowIcon} alt="PrintFlow" /></div><span>PrintFlow</span></div><nav className="workflow">{modules.map(module => <button key={module.id} className={active === module.id ? 'active' : ''} onClick={() => switchModule(module.id)}>{module.label}</button>)}</nav><div className="topbar-actions"><UpdateButton autoCheck showButton={false} /><Dropdown trigger={['click']} dropdownRender={() => userMenu}><button className="user-menu"><span className="avatar">{accountName.slice(0, 1)}</span><span>{accountName}</span><ChevronDown size={14}/></button></Dropdown></div></header><main className={`module-stage direction-${transitionDirection}`}>{modules.map(module => visitedModules.has(module.id) && <section key={module.id} className={`module-view ${active === module.id ? (leaving ? 'is-active is-entering' : 'is-active') : leaving === module.id ? 'is-leaving' : 'is-hidden'}`} inert={active !== module.id} aria-hidden={active !== module.id}>{module.id === 'schematic' ? <SchematicPage /> : <div className="module-placeholder"><h1>{module.label}</h1><p>模块正在建设中</p></div>}</section>)}</main></div></>
}




