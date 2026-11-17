import { useEffect, useRef, useState } from 'react'
import { Alert, Button } from 'antd'
import { Download } from 'lucide-react'
import { exportDiagnosticBundle, type DiagnosticExportResult } from './diagnosticsService'

type Props = { active: boolean; disabled: boolean; onBusyChange: (busy: boolean) => void }

function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function DiagnosticsPanel({ active, disabled, onBusyChange }: Props) {
  const locked = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<DiagnosticExportResult>()
  const [error, setError] = useState('')
  useEffect(() => { if (!active && !locked.current) { setError(''); setResult(undefined) } }, [active])
  const exportBundle = async () => {
    if (locked.current || disabled) return
    locked.current = true; setExporting(true); onBusyChange(true); setError(''); setResult(undefined)
    try {
      const exported = await exportDiagnosticBundle()
      if (exported) setResult(exported)
    } catch (failure) { setError(`诊断包导出失败：${failure instanceof Error ? failure.message : String(failure)}`) }
    finally { locked.current = false; setExporting(false); onBusyChange(false) }
  }

  return <section className="diagnostics-settings" hidden={!active} aria-label="诊断与反馈">
    <h3>诊断与反馈</h3>
    <p>出现同步冲突、图片加载失败等问题时，导出诊断包并发给技术人员分析。</p>
    <div className="diagnostics-settings-description">
      <p>包含软件版本、当前用户名、同步任务与请求版本、近期启动及同步转移事件。</p>
      <p>默认排除数据库密码、原始图片和备注图片；断网时也可导出。</p>
    </div>
    <div><Button type="primary" icon={<Download size={16}/>} loading={exporting} disabled={disabled || exporting} onClick={() => void exportBundle()}>{exporting ? '正在导出…' : '导出诊断包'}</Button></div>
    {error && <Alert type="error" showIcon message={error}/>}
    {result && <>
      <Alert type="success" showIcon message="诊断包已导出" description={<div className="diagnostics-export-result"><span>{result.path}</span><span>文件大小：{fileSize(result.bytes)}</span><span>请将此 ZIP 文件发送给技术人员。</span></div>}/>
      {result.warnings.length > 0 && <Alert type="warning" showIcon message="部分信息未收集完整" description={<ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}/>}
    </>}
  </section>
}
