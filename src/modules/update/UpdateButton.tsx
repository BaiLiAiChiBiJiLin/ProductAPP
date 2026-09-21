import { useEffect, useState } from 'react'
import { Button, Modal, Progress, message } from 'antd'
import { Download, RefreshCw } from 'lucide-react'
import { isTauri } from '@tauri-apps/api/core'
import { checkForUpdate, downloadAndInstallUpdate, type UpdateProgress } from './updateService'
import './update.css'

type Props = { autoCheck?: boolean; showButton?: boolean }
export default function UpdateButton({ autoCheck = false, showButton = true }: Props) {
  const [notice, contextHolder] = message.useMessage()
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<Awaited<ReturnType<typeof checkForUpdate>>>(null)
  const [downloading, setDownloading] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0 })
  useEffect(() => {
    if (!autoCheck || !isTauri()) return
    const timer = window.setTimeout(() => {
      void checkForUpdate().then(result => { if (result) setUpdate(result) }).catch(() => {})
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [autoCheck])
  const checkUpdate = async () => {
    if (!isTauri() || checking || downloading) return
    setChecking(true)
    try {
      const result = await checkForUpdate()
      if (!result) notice.success('当前已是最新版本')
      else setUpdate(result)
    } catch (error) {
      notice.error(`检查更新失败：${String(error)}`)
    } finally { setChecking(false) }
  }
  const install = async () => {
    if (!update || downloading) return
    setDownloading(true)
    try { await downloadAndInstallUpdate(update, setProgress) }
    catch (error) { setDownloading(false); notice.error(`下载更新失败：${String(error)}`) }
  }
  const percent = progress.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : undefined
  return <>
    {contextHolder}
    {showButton && <Button className="update-button" icon={checking ? <RefreshCw className="update-spin" size={14}/> : <Download size={14}/>} loading={checking} disabled={downloading} onClick={checkUpdate}>检查更新</Button>}
    <Modal open={Boolean(update)} title={`发现新版本 ${update?.version ?? ''}`} closable={!downloading} maskClosable={!downloading} onCancel={() => !downloading && setUpdate(null)} okText={downloading ? '正在下载…' : '下载并安装'} cancelText="稍后更新" onOk={install} okButtonProps={{ loading: downloading, disabled: downloading }} cancelButtonProps={{ disabled: downloading }}>
      <p>当前版本：{update?.currentVersion}</p>
      {update?.body && <div className="update-notes">{update.body}</div>}
      {downloading && <Progress percent={percent} status="active" format={() => percent === undefined ? `${Math.round(progress.downloaded / 1024 / 1024)} MB` : `${percent}%`}/>} 
    </Modal>
  </>
}
