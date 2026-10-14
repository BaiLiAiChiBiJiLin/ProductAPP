import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { Progress } from 'antd'
import { Upload } from 'lucide-react'
import Loading from '../../components/Loading'
import type { ImpositionRecord } from './impositionRecords'
import { importImpositionSvg, impositionImportLabel, impositionImportPercent, type ImpositionImportProgress } from './impositionUploadService'
import './imposition-upload.css'

type Props = {
  disabled?: boolean
  onImported: (record: ImpositionRecord) => void
  onBusyChange?: (busy: boolean) => void
  onError?: (error: string) => void
}

export default function ImpositionUpload({ disabled = false, onImported, onBusyChange, onError }: Props) {
  const zone = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<ImpositionImportProgress>({ phase: 'parse', completed: 0, total: 1 })
  const upload = useCallback(async (path?: string) => {
    if (disabled || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setDropActive(false)
    setError('')
    setProgress({ phase: 'parse', completed: 0, total: 1 })
    onBusyChange?.(true)
    try {
      const record = await importImpositionSvg(setProgress, path)
      if (record) onImported(record)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(detail)
      onError?.(detail)
    } finally {
      busyRef.current = false
      setBusy(false)
      onBusyChange?.(false)
    }
  }, [disabled, onImported, onBusyChange, onError])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten = () => {}
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disabled || busyRef.current || disposed) return
      if (payload.type === 'leave') { setDropActive(false); return }
      const bounds = zone.current?.getBoundingClientRect()
      const point = payload.position
      const ratio = window.devicePixelRatio || 1
      const inside = !!bounds && point.x / ratio >= bounds.left && point.x / ratio <= bounds.right
        && point.y / ratio >= bounds.top && point.y / ratio <= bounds.bottom
      if (payload.type !== 'drop') { setDropActive(inside); return }
      setDropActive(false)
      if (!inside) return
      const path = payload.paths.find(item => /\.svg$/i.test(item))
      if (path) void upload(path)
      else { setError('仅支持 SVG 文件'); onError?.('仅支持 SVG 文件') }
    }).then(stop => { if (disposed) stop(); else unlisten = stop }).catch(() => {})
    return () => { disposed = true; unlisten() }
  }, [disabled, onError, upload])

  return <div className="imposition-upload">
    <button ref={zone} type="button" className={`imposition-upload-zone${dropActive ? ' is-drop-active' : ''}`}
      disabled={disabled || busy} onClick={() => void upload()}
      onDragOver={event => { event.preventDefault() }}
      onDrop={event => { event.preventDefault(); if (!isTauri()) { setError('请在 Tauri 桌面窗口中拖入 SVG'); onError?.('请在 Tauri 桌面窗口中拖入 SVG') } }}>
      {busy ? <Loading size="small" inline /> : <Upload size={18} aria-hidden />}
      <span><strong>{busy ? impositionImportLabel(progress) : dropActive ? '松开导入 SVG' : '上传 SVG'}</strong>
        {!busy && <small>点击或拖入 · 单图 / 大图自动拆解</small>}
      </span>
    </button>
    {busy && <Progress size="small" percent={impositionImportPercent(progress)} showInfo={false} />}
    {error && <small className="imposition-upload-error" role="alert">{error}</small>}
  </div>
}
