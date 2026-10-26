import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Select, Space, Tag } from 'antd'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import Loading from '../../../components/Loading'
import { listTransferUsers, previewBatchTransfer, type SharedTransferProgress, type TransferPreview } from '../services/sharedTransferService'

type Props = {
  open: boolean; userName: string; batchId: string | null; batchName: string; assetCount: number
  onCancel: () => void; onTransfer: (recipient: string) => Promise<void>
  saveBeforeTransfer?: boolean
}

export default function TransferBatchModal({ open, userName, batchId, batchName, assetCount, onCancel, onTransfer, saveBeforeTransfer = true }: Props) {
  const [users, setUsers] = useState<string[]>([])
  const [recipient, setRecipient] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<TransferPreview>()
  const [progress, setProgress] = useState<SharedTransferProgress>()
  const [revision, setRevision] = useState(0)
  const sendLock = useRef(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setError(''); setRecipient(undefined); setPreview(undefined); setProgress(undefined)
    const readPreview = batchId && isTauri() ? previewBatchTransfer(batchId).catch(failure => {
      if (String(failure).includes('请先保存当前批次')) return undefined
      throw failure
    }) : Promise.resolve(undefined)
    void Promise.all([listTransferUsers(userName), readPreview]).then(([names, details]) => {
      if (!cancelled) { setUsers(names); setPreview(details) }
    }).catch(failure => { if (!cancelled) setError(`读取共享用户或关联记录失败：${String(failure)}`) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, userName, batchId, revision])

  useEffect(() => {
    if (!open || !isTauri()) return
    let cancelled = false
    let stop = () => {}
    void listen<SharedTransferProgress>('shared-transfer-progress', event => { if (!cancelled) setProgress(event.payload) })
      .then(unlisten => { if (cancelled) unlisten(); else stop = unlisten }).catch(() => {})
    return () => { cancelled = true; stop() }
  }, [open])

  const confirm = async () => {
    if (!recipient || loading || sendLock.current) return
    sendLock.current = true; setSending(true); setError('')
    try { await onTransfer(recipient) }
    catch (failure) { setError(`转移未完成：${String(failure)}。若共享连接中断，请返回历史记录刷新确认状态。`) }
    finally { sendLock.current = false; setSending(false) }
  }
  const shared = Boolean(preview?.shared)
  const phase = shared ? '正在更新批次归属…' : progress?.phase === 'send' ? `正在发送文件（${progress.completed}/${progress.total}）…` : saveBeforeTransfer ? '正在保存批次并准备完整数据包…' : '正在准备已保存批次的完整数据包…'
  return <Modal title="转移批次" open={open} onCancel={() => { if (!sending) onCancel() }} onOk={() => void confirm()} okText="确认转移" cancelText="取消" confirmLoading={sending} closable={!sending} maskClosable={!sending} keyboard={!sending}
    okButtonProps={{ disabled: !recipient || loading || Boolean(error) }} cancelButtonProps={{ disabled: sending }}>
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <div><strong>{batchName || '当前批次'}</strong><div style={{ marginTop: 8 }}><Tag>整批 {assetCount} 张图片</Tag>{!shared && <><Tag>审核 {preview?.reviewCount ?? 0} 条</Tag><Tag>生产拼版 {preview?.jobCount ?? 0} 条</Tag></>}</div></div>
      <Alert type="info" showIcon message={shared ? "转移历史批次归属" : "转移整个批次及其关联记录"} description={shared ? "转移成功后，该批次从你的历史列表移到接收用户的列表。示意图审核和生产拼版仍为公共记录，图片文件保持原位置。" : `${saveBeforeTransfer ? '确认后先保存当前批次，再发送' : '确认后直接发送已保存批次的'}图片、产品属性、组合顺序、备注、示意图审核和生产拼版数据。对方在历史记录页刷新即可接收。接收成功前保留原数据并暂停修改。`}/>
      {loading ? <Loading text="正在读取共享用户…" inline/> : <Select aria-label="接收用户" placeholder="选择接收用户" showSearch style={{ width: '100%' }} value={recipient} options={users.map(name => ({ value: name, label: name }))} onChange={setRecipient} disabled={sending} notFoundContent="暂无其他用户，请让接收方打开软件并保存用户名"/>}
      <Button size="small" onClick={() => setRevision(value => value + 1)} disabled={sending || loading}>刷新用户列表</Button>
      {sending && <Loading text={phase} inline/>}
      {error && <Alert type="error" showIcon message={error}/>}
    </Space>
  </Modal>
}
