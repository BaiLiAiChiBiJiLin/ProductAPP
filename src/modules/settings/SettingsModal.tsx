import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import { FolderOpen } from 'lucide-react'
import Loading from '../../components/Loading'
import { chooseHistoryDirectory, loadStorageSettings, saveStorageSettings, type StorageSettings } from './storageSettingsService'
import './settings.css'
import { invoke } from '../../services/backend'
import { readPools } from '../imposition/impositionPoolStore'

type Props = { open: boolean; onClose: () => void }
const ProductOptionsSettings = lazy(() => import('./product-options/ProductOptionsSettings'))

export default function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<StorageSettings>()
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [section, setSection] = useState('storage')
  const [productVisited, setProductVisited] = useState(false)
  const [productBusy, setProductBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [migration, setMigration] = useState<{ batches: number; reviews: number; jobs: number; snapshot: string }>()
  const [maintenanceMessage, setMaintenanceMessage] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const busy = useRef(false)
  const maintain = async (command: string) => {
    if (busy.current) return
    busy.current = true; setSaving(true); setError(''); setMaintenanceMessage('')
    try {
      if (command === 'preview_cloud_migration') setMigration(await invoke(command))
      else if (command === 'migrate_local_data') {
        const result = await invoke<{ imported: number; skipped: number; errors: string[]; localRecordsDeleted?: boolean }>(command, { pools: readPools(), snapshot: migration?.snapshot })
        setMaintenanceMessage(result.localRecordsDeleted ? `已迁移 ${result.imported} 条，已迁移过的 ${result.skipped} 条已跳过，本机旧数据已删除。关闭设置后请刷新各列表。` : `已迁移 ${result.imported} 条，已迁移过的 ${result.skipped} 条已跳过。存在未完成项目，本机数据已保留。`)
        if (result.errors.length) setError(`以下记录未迁移，可修复后重试：${result.errors.join('；')}`)
        else setMigration(undefined)
      } else if (command === 'delete_local_data') {
        const result = await invoke<{ removed: number; errors: string[] }>(command, { confirmed: true, snapshot: migration?.snapshot })
        setMaintenanceMessage(result.errors.length ? `已删除 ${result.removed} 条本机旧记录，部分文件待重试清理。` : `已删除 ${result.removed} 条本机旧记录及其文件。`)
        if (result.errors.length) setError(`本机文件清理未完成：${result.errors.join('；')}`)
        setMigration(undefined)
      } else if (command === 'check_shared_storage') {
        await invoke(command); setMaintenanceMessage('云数据库已连接，共享目录读写及删除测试通过。')
      } else {
        const result = await invoke<{ removed: number }>(command)
        setMaintenanceMessage(`已清理 ${result.removed} 个不再使用的共享文件。`)
      }
    } catch (failure) { setError(String(failure)) }
    finally { busy.current = false; setSaving(false) }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setSaved(false)
    setMigration(undefined); setMaintenanceMessage('')
    setSettings(undefined)
    void (async () => {
      try {
        const value = await loadStorageSettings()
        if (!cancelled) { setSettings(value); setDirectory(value.historyDirectory) }
      } catch (failure) { if (!cancelled) setError(String(failure)) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [open, revision])

  const choose = async () => {
    if (busy.current) return
    busy.current = true
    setChoosing(true)
    try {
      const selected = await chooseHistoryDirectory(directory)
      if (selected) { setDirectory(selected); setError(''); setSaved(false) }
    } catch (failure) { setError(String(failure)) }
    finally { busy.current = false; setChoosing(false) }
  }

  const deleteLocal = () => {
    if (busy.current || !migration) return
    setDeleteConfirmOpen(true)
  }

  const save = async () => {
    if (busy.current || !settings || !directory.trim()) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      const value = await saveStorageSettings(directory.trim())
      setSettings(value)
      setDirectory(value.historyDirectory)
      setSaved(true)
    } catch (failure) { setError(String(failure)) }
    finally { busy.current = false; setSaving(false) }
  }

  return <><Modal title="设置" open={open} width="96vw" className="app-settings-modal" onCancel={() => { if (!saving && !choosing && !productBusy) { setProductVisited(false); setSection('storage'); onClose() } }}
    closable={!saving && !choosing && !productBusy} maskClosable={false} keyboard={false} footer={null}>
    <div className="app-settings-shell">
      <nav className="app-settings-nav" aria-label="设置项目">
        <button type="button" aria-current={section === 'storage' ? 'page' : undefined} disabled={saving || choosing || productBusy} onClick={() => setSection('storage')}>历史记录保存目录</button>
        <button type="button" aria-current={section === 'products' ? 'page' : undefined} disabled={saving || choosing || productBusy} onClick={() => { setProductVisited(true); setSection('products') }}>产品选项配置</button>
      </nav>
      <div className="app-settings-content">
    <div className="storage-settings" hidden={section !== 'storage'}>
      <div className="storage-settings-header"><h3>历史记录保存目录</h3>{!settings?.shared && <Button type="primary" onClick={() => void save()} disabled={loading || !settings || !directory.trim() || saving || choosing} icon={saving ? <Loading size="small" inline/> : undefined}>{saving ? '正在保存…' : '保存'}</Button>}</div>
      {loading ? <Loading text="正在加载设置…"/> : <>
        {error && <Alert type="error" showIcon message={error} action={!settings ? <Button size="small" onClick={() => setRevision(value => value + 1)}>重试</Button> : undefined}/>}
        {settings && <>
          <label htmlFor="history-save-directory">历史记录保存目录</label>
          <div className="storage-settings-path">
            <Input id="history-save-directory" value={directory} onChange={event => { setDirectory(event.target.value); setSaved(false) }} disabled={settings.shared || saving || choosing}/>
            {!settings.shared && <Button icon={choosing ? <Loading size="small" inline/> : <FolderOpen size={16}/>} onClick={() => void choose()} disabled={saving || choosing}>选择文件夹</Button>}
          </div>
          {!settings.shared && <><div className="storage-settings-default"><span>默认：{settings.defaultHistoryDirectory}</span><Button type="link" size="small" disabled={saving || choosing} onClick={() => { setDirectory(settings.defaultHistoryDirectory); setSaved(false) }}>恢复默认</Button></div>
          <p>新批次按客户名称和保存时间建立文件夹，同名批次自动区分。修改目录后，已有批次仍保存在原位置，可正常打开和继续保存。</p></>}
          {settings.shared && <>
            <Alert type="info" showIcon message="共享模式" description="历史批次仅所属用户可见；示意图审核和生产拼版由所有用户共享。目录与数据库在配置文件中设置，修改后需重启软件。"/>
            <p>配置文件：{settings.configPath}</p>
            <Button disabled={saving} onClick={() => void maintain('check_shared_storage')}>检查连接与目录权限</Button>
            <Button disabled={saving} onClick={() => void maintain('preview_cloud_migration')}>检查本机旧数据</Button>
            {migration && <div><p>本机有 {migration.batches} 个历史批次、{migration.reviews} 条审核、{migration.jobs} 条生产记录。历史批次导入后归当前用户，审核和生产记录公开。</p>
              <span style={{ display: 'inline-flex', gap: 8 }}>
                <Button type="primary" loading={saving} disabled={saving} onClick={() => void maintain('migrate_local_data')}>迁移数据</Button>
                <Button danger loading={saving} disabled={saving} onClick={deleteLocal}>删除旧数据</Button>
              </span></div>}
            <p>删除记录后，仍被其他记录引用的文件继续保留。未引用的文件保留至少 24 小时后可清理。</p>
            <Button disabled={saving} onClick={() => void maintain('cleanup_cloud_resources')}>清理未引用文件</Button>
            {maintenanceMessage && <Alert type="success" showIcon message={maintenanceMessage}/>}
          </>}
        </>}
      </>}
      {saved && <Alert type="success" showIcon message="历史记录保存目录已保存"/>}
    </div>
    {productVisited && <div className="app-settings-page" hidden={section !== 'products'}><Suspense fallback={<Loading text="正在加载产品配置…"/>}><ProductOptionsSettings onBusyChange={setProductBusy}/></Suspense></div>}
      </div>
    </div>
  </Modal><Modal title="删除本机旧数据？" open={deleteConfirmOpen} onCancel={() => { if (!saving) setDeleteConfirmOpen(false) }} onOk={async () => { await maintain('delete_local_data'); setDeleteConfirmOpen(false) }} okText="删除旧数据" cancelText="取消" okButtonProps={{ danger: true }} confirmLoading={saving} maskClosable={!saving} keyboard={!saving}><p>删除后无法从本机恢复。共享数据源中的已迁移记录不受影响。</p></Modal>
  </>
}
