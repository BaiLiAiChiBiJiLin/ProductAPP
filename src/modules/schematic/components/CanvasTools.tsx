import { Button, ColorPicker, Tooltip } from 'antd'
import { MousePointer2, Ruler, Type } from 'lucide-react'
import type { CanvasTool, RulerMode } from '../services/canvasAnnotationService'
import './canvas-tools.css'

export default function CanvasTools({ tool, onTool, rulerMode = 'free', onRulerMode, background, onBackground, hasGroup, disabled }: {
  tool: CanvasTool; onTool: (tool: CanvasTool) => void
  rulerMode?: RulerMode; onRulerMode?: (mode: RulerMode) => void
  background: string; onBackground: (color: string) => void; hasGroup: boolean; disabled: boolean
}) {
  return <div className="canvas-floating-tools" role="toolbar" aria-label="画布工具">
    <Tooltip title="选择 / 移动文字"><Button aria-label="选择工具" aria-pressed={tool === 'select'} type={tool === 'select' ? 'primary' : 'text'} icon={<MousePointer2 size={18}/>} disabled={disabled} onClick={() => onTool('select')}/></Tooltip>
    <Tooltip title="添加文字：点击画布放置"><Button aria-label="添加文字" aria-pressed={tool === 'text'} type={tool === 'text' ? 'primary' : 'text'} icon={<Type size={18}/>} disabled={disabled} onClick={() => onTool('text')}/></Tooltip>
    <Tooltip title="标尺：先选择方向，再点击两点测量；移动调整延伸线，第三次点击完成"><Button aria-label="添加标尺" aria-pressed={tool === 'ruler'} type={tool === 'ruler' ? 'primary' : 'text'} icon={<Ruler size={18}/>} disabled={disabled} onClick={() => onTool('ruler')}/></Tooltip>
    {tool === 'ruler' && <div className="ruler-mode-options" role="group" aria-label="标尺方向">
      {([['vertical', '垂直标尺'], ['horizontal', '水平标尺'], ['free', '自由标尺']] as const).map(([mode, label]) => <Button key={mode} size="small" type={rulerMode === mode ? 'primary' : 'text'} aria-label={label} aria-pressed={rulerMode === mode} disabled={disabled} onClick={() => onRulerMode?.(mode)}>{label}</Button>)}
    </div>}
    <span className="canvas-tool-label">块背景色</span>
    <ColorPicker aria-label="块背景色" value={background} disabled={disabled || !hasGroup} onChangeComplete={color => onBackground(color.toRgbString())}/>
  </div>
}
