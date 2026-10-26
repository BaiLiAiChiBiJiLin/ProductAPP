import { useCallback, useEffect, useState } from 'react'
import { Button, Dropdown, Input, Modal, message } from 'antd'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { orderModule, imageEditModule, schematicModule, schematicReviewModule, SchematicReviewPage, impositionModule, ImpositionPage, progressModule } from './modules'
import SchematicPage from './modules/schematic/SchematicPage'
import type { ReviewRestoreRequest } from './modules/schematic-review/reviewRecords'
import { Check, ChevronDown, PlayCircle, Settings, UserRound } from 'lucide-react'
import './App.css'
import './module-shell.css'
import ModulePage from './components/ModulePage'
import printflowIcon from './assets/printflow-icon.png'
import { initializeSharedUser, validSharedUserName } from './modules/schematic/services/sharedTransferService'
import { refreshProductConfigs } from './modules/schematic/services/productConfigService'
import { invalidateFinishNames } from './modules/schematic/services/finishService'
import UpdateButton from './modules/update/UpdateButton'
import { FeatureTour, listFeatureTours } from './modules/feature-tour'
import SettingsModal from './modules/settings/SettingsModal'
import { installButtonKeyboardGuard } from './buttonKeyboard'
import { storageMode } from './services/backend'
import { needsCloudRegistration, confirmCloudRegistration } from './services/cloudRegistration'
const modules = [orderModule, imageEditModule, schematicModule, schematicReviewModule, impositionModule, progressModule]
// React StrictMode mounts effects twice in development. Keep the startup
// refresh single-flight so two 9 MB responses cannot overlap and double the
// JSON parsing/transport peak.
let startupProductConfigRefresh: Promise<void> | undefined
export default function App() {
  useEffect(() => installButtonKeyboardGuard(), [])
  const [notice, noticeContext] = message.useMessage()
  const [active, setActive] = useState('schematic')
  const [reviewRevision, setReviewRevision] = useState(0)
  const [impositionRevision, setImpositionRevision] = useState(0)
  const [restoreRequest, setRestoreRequest] = useState<ReviewRestoreRequest>()
  const [schematicWorking, setSchematicWorking] = useState(false)
  const [leaving, setLeaving] = useState<string | null>(null)
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(null), 540)
    return () => window.clearTimeout(timer)
  }, [active, leaving])
  const [visitedModules, setVisitedModules] = useState(() => new Set(['schematic']))
  const [transitionDirection, setTransitionDirection] = useState<'forward' | 'backward'>('forward')
  const activeIndex = modules.findIndex(module => module.id === active)
  const [accountName, setAccountName] = useState(() => localStorage.getItem('printflow-account-name')?.trim() || '')
  const [draftAccountName, setDraftAccountName] = useState(accountName)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [identityError, setIdentityError] = useState('')
  const [identityReady, setIdentityReady] = useState(!isTauri())
  const [registrationRequired, setRegistrationRequired] = useState(false)
  const [featureTourOpen, setFeatureTourOpen] = useState(false)
  const [featureTourRequest, setFeatureTourRequest] = useState(0)
  const [updateDialogs, setUpdateDialogs] = useState({ automatic: false, manual: false })
  const automaticUpdateChanged = useCallback((open: boolean) => setUpdateDialogs(current => ({ ...current, automatic: open })), [])
  const manualUpdateChanged = useCallback((open: boolean) => setUpdateDialogs(current => ({ ...current, manual: open })), [])
  const featureTourReady = identityReady && Boolean(accountName) && !registrationRequired && !identityError
    && !settingsOpen && !schematicWorking && !updateDialogs.automatic && !updateDialogs.manual
  useEffect(() => {
    if (!isTauri()) return
    const key = 'product-config-startup'
    notice.open({ key, type: 'loading', content: '正在请求产品配置接口…', duration: 0 })
    startupProductConfigRefresh ??= refreshProductConfigs().then(() => {
      invalidateFinishNames()
      return undefined
    })
    void startupProductConfigRefresh.then(() => {
      notice.success({ key, content: '产品配置及工艺数据已更新到本地缓存', duration: 2.5 })
    }).catch(error => {
      notice.warning({ key, content: '产品配置接口请求失败，继续使用本地缓存', duration: 5 })
      console.warn('产品配置接口请求失败，继续使用本地缓存', error)
    })
  }, [notice])
  const sharedRecordsChanged = useCallback(() => { setReviewRevision(value => value + 1); setImpositionRevision(value => value + 1) }, [])
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    setIdentityReady(false)
    void storageMode().then(async mode => {
      if (cancelled) return
      if (needsCloudRegistration(mode, accountName)) {
        setRegistrationRequired(true)
        return
      }
      if (!accountName) return
      try { await initializeSharedUser(accountName) }
      catch (error) {
        if (mode.shared) throw error
        notice.warning({ key: 'shared-folder', content: `共享目录暂不可用，历史记录刷新时可重试：${String(error)}`, duration: 6 })
      }
      if (!cancelled) { setIdentityError(''); setIdentityReady(true) }
    }).catch(error => { if (!cancelled) setIdentityError(String(error)) })
    return () => { cancelled = true }
  }, [accountName, notice])
  const saveAccountName = async () => {
    if (signingIn) return
    const value = draftAccountName.trim()
    if (!validSharedUserName(value)) { notice.error('请填写有效用户名，不要使用路径符号或 Windows 保留名称'); return }
    if (schematicWorking) { notice.warning('请等待当前图片处理完成后再修改用户名'); return }
    setSigningIn(true)
    try {
      const mode = await storageMode()
      if (mode.shared) {
        await initializeSharedUser(value)
        confirmCloudRegistration(mode, value)
      }
      setRegistrationRequired(false); setIdentityReady(true)
      localStorage.setItem('printflow-account-name', value); setAccountName(value); setDraftAccountName(value); setIdentityError(''); notice.success('用户名已保存')
    } catch (error) { setIdentityError(String(error)); notice.error(`用户名保存失败：${String(error)}`) }
    finally { setSigningIn(false) }
  }
  const userMenu = <div className="account-popover"><div className="account-popover-title"><UserRound size={16}/>用户信息</div><label>用户名<Input size="small" value={draftAccountName} maxLength={30} onChange={event => setDraftAccountName(event.target.value)} onPressEnter={saveAccountName}/></label><Button type="primary" size="small" icon={<Check size={14}/>} onClick={saveAccountName}>保存</Button><Button className="account-settings-button" icon={<Settings size={14}/>} onClick={() => { setUserMenuOpen(false); setSettingsOpen(true) }}>设置</Button>{listFeatureTours().length > 0 && <Button className="account-settings-button" icon={<PlayCircle size={14}/>} onClick={() => { setUserMenuOpen(false); setFeatureTourRequest(value => value + 1) }}>新功能介绍</Button>}<UpdateButton onDialogOpenChange={manualUpdateChanged}/></div>
  const switchModule = (id: string) => {
    if (id === active) return
    const nextIndex = modules.findIndex(module => module.id === id)
    setTransitionDirection(nextIndex >= activeIndex ? 'forward' : 'backward')
    setVisitedModules(current => new Set(current).add(id))
    setLeaving(active)
    setActive(id)
  }
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten = () => {}
    void listen<{ path: string }>('external-svg-import', () => {
      if (!cancelled && active !== 'schematic') switchModule('schematic')
    }).then(stop => { if (cancelled) stop(); else unlisten = stop }).catch(() => {})
    return () => { cancelled = true; unlisten() }
  }, [active])
  return <>{noticeContext}<Modal title="设置用户名" open={!accountName || registrationRequired || Boolean(identityError)} closable={false} maskClosable={false} keyboard={false} footer={<Button type="primary" onClick={saveAccountName} loading={signingIn} disabled={!draftAccountName.trim() || signingIn}>保存用户名</Button>}><p>请输入你的用户名，用于识别历史批次归属和接收转移。</p>{identityError && <p role="alert">{identityError}</p>}<Input aria-label="首次设置用户名" autoFocus maxLength={30} value={draftAccountName} onChange={event => setDraftAccountName(event.target.value)} onPressEnter={saveAccountName}/></Modal><SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)}/><FeatureTour enabled={featureTourReady} requestOpen={featureTourRequest} onOpenChange={setFeatureTourOpen}/><div className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><img src={printflowIcon} alt="PrintFlow" /></div><span>PrintFlow</span></div><nav className="workflow">{modules.map(module => <button key={module.id} className={active === module.id ? 'active' : ''} onClick={() => switchModule(module.id)}>{module.label}</button>)}</nav><div className="topbar-actions"><UpdateButton autoCheck showButton={false} enabled={identityReady && Boolean(accountName) && !featureTourOpen && !settingsOpen} onDialogOpenChange={automaticUpdateChanged}/><Dropdown trigger={['click']} open={userMenuOpen} onOpenChange={setUserMenuOpen} dropdownRender={() => userMenu}><button className="user-menu"><span className="avatar">{accountName.slice(0, 1) || '?'}</span><span>{accountName || '请设置用户名'}</span><ChevronDown size={14}/></button></Dropdown></div></header><main className={`module-stage direction-${transitionDirection}`}>{identityReady && modules.map(module => visitedModules.has(module.id) && <section key={module.id} className={`module-view ${active === module.id ? (leaving ? 'is-active is-entering' : 'is-active') : leaving === module.id ? 'is-leaving' : 'is-hidden'}`} inert={active !== module.id} aria-hidden={active !== module.id}>{module.id === 'schematic' ? <SchematicPage key={restoreRequest?.token ?? 'new'} initialRecord={restoreRequest?.record} onRecordSaved={() => setReviewRevision(value => value + 1)} onWorkingChange={setSchematicWorking} userName={accountName} onSharedRecordsChanged={sharedRecordsChanged}/> : module.id === 'schematic-review' ? <SchematicReviewPage active={active === 'schematic-review'} revision={reviewRevision} working={schematicWorking} onImpositionSubmitted={() => setImpositionRevision(value => value + 1)} onImposition={() => switchModule('imposition')} onEdit={record => { setRestoreRequest({ token: crypto.randomUUID(), record }); switchModule('schematic') }}/> : module.id === 'imposition' ? <ImpositionPage active={active === 'imposition'} revision={impositionRevision} onReturned={() => setReviewRevision(value => value + 1)}/> : <ModulePage title={module.label} description="模块正在建设中"/>}</section>)}</main></div></>
}




