import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from 'antd'
import { ArrowLeft, ArrowRight, Check, CircleStop, Play } from 'lucide-react'
import { hasSeenFeatureTour, markFeatureTourSeen } from './featureTourService'
import { getFeatureTour, listFeatureTours } from './featureTourCatalog'
import type { FeatureTourRelease } from './types'
import './feature-tour.css'

type Props = { enabled: boolean; requestOpen?: number; onOpenChange?: (open: boolean) => void }

export default function FeatureTour({ enabled, requestOpen = 0, onOpenChange }: Props) {
  const [open, setOpen] = useState(false)
  const [release, setRelease] = useState<FeatureTourRelease>()
  const [index, setIndex] = useState(0)
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const [playing, setPlaying] = useState(!reducedMotion)
  const [mediaFailed, setMediaFailed] = useState(false)
  const autoChecked = useRef(false)
  const lastRequest = useRef(0)
  const pendingRequest = useRef(false)
  const openChange = useRef(onOpenChange)
  openChange.current = onOpenChange
  const visible = enabled && open && Boolean(release)
  const releases = listFeatureTours()

  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!preference) return
    const change = () => { setReducedMotion(preference.matches); if (preference.matches) setPlaying(false) }
    preference.addEventListener?.('change', change)
    return () => preference.removeEventListener?.('change', change)
  }, [])

  useEffect(() => {
    if (requestOpen !== lastRequest.current) {
      if (requestOpen > 0) pendingRequest.current = true
      lastRequest.current = requestOpen
    }
    if (!enabled) return
    const current = getFeatureTour()
    const manual = pendingRequest.current
    pendingRequest.current = false
    // Historical introductions are only a fallback for an explicit menu request.
    const target = manual ? current ?? listFeatureTours()[0] : current
    if (target && (manual || (!autoChecked.current && !hasSeenFeatureTour(target.version, target.id)))) {
      setRelease(target); setIndex(0); setPlaying(!reducedMotion); setMediaFailed(false); setOpen(true)
    }
    autoChecked.current = true
  }, [enabled, requestOpen, reducedMotion])

  useEffect(() => { onOpenChange?.(visible) }, [visible, onOpenChange])
  useEffect(() => () => openChange.current?.(false), [])

  if (!release) return null
  const slides = release.slides
  const slide = slides[index]
  const close = () => { markFeatureTourSeen(release.version, release.id); setOpen(false) }
  const select = (next: number) => { setIndex(Math.max(0, Math.min(slides.length - 1, next))); setMediaFailed(false) }
  const changeVersion = (version: string) => {
    const target = releases.find(item => item.version === version)
    if (!target) return
    markFeatureTourSeen(release.version, release.id)
    setRelease(target); setIndex(0); setMediaFailed(false)
  }
  return <Modal className="feature-tour" width={900} centered open={visible} title={<div className="feature-tour-modal-title"><span>新功能介绍</span><select className="feature-tour-version" aria-label="介绍版本" value={release.version} onChange={event => changeVersion(event.target.value)}>{releases.map(item => <option key={item.version} value={item.version}>v{item.version}</option>)}</select></div>}
    closeIcon={<span aria-label="关闭新功能介绍">×</span>} onCancel={close} footer={null} destroyOnHidden keyboard maskClosable={false}>
    <section className="feature-tour-content" aria-label="新功能轮播" onKeyDown={event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); select(index - 1) }
      if (event.key === 'ArrowRight') { event.preventDefault(); select(index + 1) }
    }}>
      <div className="feature-tour-heading" aria-live="polite" aria-atomic="true">
        <span className="feature-tour-count">{String(index + 1).padStart(2, '0')}<span> / {String(slides.length).padStart(2, '0')}</span></span>
        <div><h2>{slide.title}</h2><p>{slide.description}</p></div>
      </div>
      <div className="feature-tour-demo">
        {visible && <img key={`${release.version}-${slide.id}-${playing && !mediaFailed ? 'animated' : 'poster'}`} src={playing && !mediaFailed ? slide.animation : slide.poster} alt={slide.alt}
          width={960} height={540} decoding="async" onError={playing && !mediaFailed ? () => setMediaFailed(true) : undefined}/>}
      </div>
      <div className="feature-tour-demo-caption">
        <div className="feature-tour-shortcuts">{slide.shortcuts.map(shortcut => <span key={shortcut}>{shortcut}</span>)}</div>
        <Button type="text" size="small" icon={playing && !mediaFailed ? <CircleStop size={14}/> : <Play size={14}/>} disabled={mediaFailed}
          onClick={() => setPlaying(value => !value)}>{mediaFailed ? '演示暂不可用' : playing ? '停止播放' : '播放演示'}</Button>
      </div>
      <div className="feature-tour-footer">
        <Button type="text" className="feature-tour-skip" onClick={close}>跳过介绍</Button>
        <nav className="feature-tour-dots" aria-label="选择功能介绍">
          {slides.map((item, step) => <button key={item.id} type="button" aria-label={`查看第 ${step + 1} 项：${item.title}`} aria-current={step === index ? 'step' : undefined}
            className={step === index ? 'is-active' : ''} onClick={() => select(step)}><span/></button>)}
        </nav>
        <div className="feature-tour-actions"><Button icon={<ArrowLeft size={15}/>} disabled={index === 0} onClick={() => select(index - 1)}>上一项</Button>
          <Button type="primary" icon={index === slides.length - 1 ? <Check size={15}/> : <ArrowRight size={15}/>} onClick={index === slides.length - 1 ? close : () => select(index + 1)}>{index === slides.length - 1 ? '开始使用' : '下一项'}</Button></div>
      </div>
    </section>
  </Modal>
}
