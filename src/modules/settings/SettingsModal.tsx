import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Modal } from 'antd'
import { FolderOpen } from 'lucide-react'
import Loading from '../../components/Loading'
import { chooseHistoryDirectory, loadStorageSettings, saveStorageSettings, type StorageSettings } from './storageSettingsService'
import './settings.css'

type Props = { open: boolean; onClose: () => void }

export default function SettingsModal({ open, onClose }: Props) {
  const [settings, setSettings] = useState<StorageSettings>()
  const [directory, setDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const busy = useRef(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
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
      if (selected) { setDirectory(selected); setError('') }
    } catch (failure) { setError(String(failure)) }
    finally { busy.current = false; setChoosing(false) }
  }

  const save = async () => {
    if (busy.current || !settings || !directory.trim()) return
    busy.current = true
    setSaving(true)
    setError('')
    try {
      await saveStorageSettings(directory.trim())
      onClose()
    } catch (failure) { setError(String(failure)) }
    finally { busy.current = false; setSaving(false) }
  }

  return <Modal title="设置" open={open} width={640} onCancel={onClose}
    closable={!saving && !choosing} maskClosable={!saving && !choosing} keyboard={!saving && !choosing}
    footer={<>
      <Button onClick={onClose} disabled={saving || choosing}>取消</Button>
      <Button type="primary" onClick={() => void save()} disabled={loading || !settings || !directory.trim() || saving || choosing}
        icon={saving ? <Loading size="small" inline/> : undefined}>{saving ? '正在保存…' : '保存'}</Button>
    </>}>
    <div className="storage-settings">
      {loading ? <Loading text="正在加载设置…"/> : <>
        {error && <Alert type="error" showIcon message={error} action={!settings ? <Button size="small" onClick={() => setRevision(value => value + 1)}>重试</Button> : undefined}/>}
        {settings && <>
          <label htmlFor="history-save-directory">历史记录保存目录</label>
          <div className="storage-settings-path">
            <Input id="history-save-directory" value={directory} onChange={event => setDirectory(event.target.value)} disabled={saving || choosing}/>
            <Button icon={choosing ? <Loading size="small" inline/> : <FolderOpen size={16}/>} onClick={() => void choose()} disabled={saving || choosing}>选择文件夹</Button>
          </div>
          <div className="storage-settings-default"><span>默认：{settings.defaultHistoryDirectory}</span><Button type="link" size="small" disabled={saving || choosing} onClick={() => setDirectory(settings.defaultHistoryDirectory)}>恢复默认</Button></div>
          <p>新批次按客户名称和保存时间建立文件夹，同名批次自动区分。修改目录后，已有批次仍保存在原位置，可正常打开和继续保存。</p>
        </>}
      </>}
    </div>
  </Modal>
}
