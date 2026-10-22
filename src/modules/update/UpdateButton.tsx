import { useEffect, useRef, useState } from 'react'
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
  const actionInFlight = useRef(false)
  useEffect(() => {
    if (!autoCheck || !isTauri()) return
    const timer = window.setTimeout(() => {
      void checkForUpdate().then(result => { if (result) setUpdate(result) }).catch(() => {})
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [autoCheck])
  const checkUpdate = async () => {
    if (!isTauri() || actionInFlight.current) return
    actionInFlight.current = true
    setChecking(true)
    try {
      const result = await checkForUpdate()
      if (!result) notice.success('当前已是最新版本')
      else setUpdate(result)
    } catch (error) {
      notice.error(`检查更新失败：${String(error)}`)
    } finally { actionInFlight.current = false; setChecking(false) }
  }
  const install = async () => {
    if (!update || actionInFlight.current) return
    actionInFlight.current = true
    setDownloading(true)
    setProgress({ downloaded: 0, phase: 'connecting' })
    try { await downloadAndInstallUpdate(update, setProgress) }
    catch (error) { notice.error(`下载更新失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { actionInFlight.current = false; setDownloading(false) }
  }
  const percent = progress.total ? Math.min(100, Math.round(progress.downloaded / progress.total * 100)) : undefined
  const statusText = progress.phase === 'connecting' ? '正在连接下载服务器…'
    : progress.phase === 'retrying' ? `连接中断，正在重试${progress.attempt && progress.maxAttempts ? `（${progress.attempt}/${progress.maxAttempts}）` : ''}…`
    : progress.phase === 'installing' ? '正在安装…'
    : percent === undefined ? '正在下载…' : `${percent}%`
  return <>
    {contextHolder}
    {showButton && <Button className="update-button" icon={checking ? <RefreshCw className="update-spin" size={14}/> : <Download size={14}/>} loading={checking} disabled={downloading} onClick={checkUpdate}>检查更新</Button>}
    <Modal open={Boolean(update)} title={`发现新版本 ${update?.version ?? ''}`} closable={!downloading} maskClosable={!downloading} onCancel={() => !downloading && setUpdate(null)} okText={downloading ? '更新中…' : '下载并安装'} cancelText="稍后更新" onOk={install} okButtonProps={{ loading: downloading, disabled: downloading }} cancelButtonProps={{ disabled: downloading }}>
      <p>当前版本：{update?.currentVersion}</p>
      {update?.body && <div className="update-notes">{update.body}</div>}
      {downloading && <div className="update-download-progress"><Progress percent={percent} status="active" showInfo={false}/><div className="update-download-progress-label" role="status"><span>{statusText}</span><span>{formatBytes(progress.downloaded)}{progress.total ? ` / ${formatBytes(progress.total)}` : ''}</span></div></div>}
    </Modal>
  </>
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
