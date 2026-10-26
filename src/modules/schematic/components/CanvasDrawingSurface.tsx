import { useEffect, useState } from 'react'
import { PAPER_HEIGHT, PAPER_WIDTH, type Asset, type Page } from '../../../model'
import type { CanvasAnnotation } from '../layoutTypes'
import { manualRulerGeometry, manualRulerLabel, manualRulerPlacement, measuredDistance, rulerCalibration, type Point, type RulerCalibration } from '../services/canvasAnnotationService'
import { RULER_COLOR, RULER_STROKE_WIDTH } from '../services/imageDimensionService'

/** An independent overlay keeps pointer previews from rerendering every SVG image. */
export default function CanvasDrawingSurface({ tool, page, assets, scales, x, y, scale, toPaper, onText, onRuler, onCancel }: {
  tool: 'text' | 'ruler'; page: Page; assets: Map<string, Asset>; scales?: ReadonlyMap<string, number>
  x: number; y: number; scale: number; color: string; toPaper: (x: number, y: number) => Point
  onText: (point: Point) => void; onRuler: (ruler: CanvasAnnotation) => void; onCancel: () => void
}) {
  const [start, setStart] = useState<{ point: Point; calibration: RulerCalibration } | null>(null)
  const [end, setEnd] = useState<Point | null>(null)
  const [placement, setPlacement] = useState<Point | null>(null)
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { setStart(null); setEnd(null); setPlacement(null); onCancel() } }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [onCancel])
  const inside = (point: Point) => point.x >= 0 && point.y >= 0 && point.x <= PAPER_WIDTH && point.y <= PAPER_HEIGHT
  return <div aria-label={tool === 'text' ? '点击画布添加文字' : '点击画布绘制标尺'} style={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' }}
    onPointerDown={event => { if (event.button === 0) { event.preventDefault(); event.stopPropagation() } }}
    onPointerMove={event => { if (!start) return; const point = toPaper(event.clientX, event.clientY); if (inside(point)) { if (placement) setPlacement(point); else setEnd(point) } }}
    onClick={event => {
      event.stopPropagation()
      const point = toPaper(event.clientX, event.clientY)
      if (!inside(point)) return
      if (tool === 'text') { onText(point); return }
      if (!start) { setStart({ point, calibration: rulerCalibration(page, assets, point, scales) }); setEnd(point); return }
      if (!placement) {
        if (Math.hypot(point.x - start.point.x, point.y - start.point.y) < 1) return
        setEnd(point); setPlacement(point); return
      }
      if (!end) return
      onRuler({ id: crypto.randomUUID(), kind: 'ruler', ...manualRulerPlacement(start.point, end, point), color: RULER_COLOR,
        measuredMm: measuredDistance(start.point, end, start.calibration), sourceItemId: start.calibration.sourceItemId })
      setStart(null); setEnd(null); setPlacement(null)
    }}>
    {start && end && (() => {
      const color = RULER_COLOR
      const previewRuler = { id: 'preview', kind: 'ruler' as const, ...manualRulerPlacement(start.point, end, placement ?? end), color, measuredMm: measuredDistance(start.point, end, start.calibration) }
      const geometry = manualRulerGeometry(previewRuler)
      return <svg aria-hidden style={{ position: 'absolute', left: x, top: y, width: PAPER_WIDTH * scale, height: PAPER_HEIGHT * scale, pointerEvents: 'none', overflow: 'visible' }} viewBox={`0 0 ${PAPER_WIDTH} ${PAPER_HEIGHT}`}>
        {geometry.segment.map((line, index) => <line key={`segment-${index}`} data-ruler-segment x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} stroke={color} strokeWidth={RULER_STROKE_WIDTH}/>) }
        {geometry.extension.map((line, index) => <line key={`extension-${index}`} data-ruler-extension x1={line[0]} y1={line[1]} x2={line[2]} y2={line[3]} stroke={color} strokeWidth={RULER_STROKE_WIDTH}/>) }
        <polygon data-ruler-arrow points={`${geometry.arrowStart[0]},${geometry.arrowStart[1]} ${geometry.arrowStart[2]},${geometry.arrowStart[3]} ${geometry.arrowStart[4]},${geometry.arrowStart[5]}`} fill={color}/>
        <polygon data-ruler-arrow points={`${geometry.arrowEnd[0]},${geometry.arrowEnd[1]} ${geometry.arrowEnd[2]},${geometry.arrowEnd[3]} ${geometry.arrowEnd[4]},${geometry.arrowEnd[5]}`} fill={color}/>
        <circle cx={start.point.x} cy={start.point.y} r={2} fill={color}/>
        <text x={geometry.textX} y={geometry.textY} textAnchor="middle" dominantBaseline="central" transform={`rotate(${geometry.textRotation} ${geometry.textX} ${geometry.textY})`} fontSize={8} fill={color}>{manualRulerLabel(previewRuler.measuredMm)}</text>
      </svg>
    })()}
  </div>
}
