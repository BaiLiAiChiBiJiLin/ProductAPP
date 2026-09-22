import { useEffect, useState } from 'react'
import { Group, Image as KonvaImage, Rect, Text } from 'react-konva'
import type { ImageGroup } from '../layoutTypes'
import { imageDetailsLayout } from '../services/imageDetailsLayoutService'
import { detailPanelsForGroup } from '../arrangement/productGroupDetails'
import { finishLabel } from '../services/finishLabelService'
import { accessoryFrame, rememberAccessoryImage } from '../services/accessoryFrameService'
import { resolveRemoteImage } from '../services/remoteImageService'

const imageCache = new Map<string, HTMLImageElement>()

function AccessoryImage({ src, x, y, width, height, code, framed = false }: { src: string; x: number; y: number; width: number; height: number; code?: string; framed?: boolean }) {
  const [image, setImage] = useState<HTMLImageElement>()
  useEffect(() => {
    let cancelled = false
    let element: HTMLImageElement | undefined
    setImage(undefined)
    const load = async () => {
      const resolved = await resolveRemoteImage(src)
      if (cancelled) return
      const cached = imageCache.get(resolved)
      if (cached) { rememberAccessoryImage(src, cached); setImage(cached); return }
      element = new window.Image()
      element.crossOrigin = 'anonymous'
      element.onload = () => {
        if (!cancelled && element) {
          rememberAccessoryImage(src, element)
          imageCache.set(resolved, element)
          setImage(element)
        }
      }
      element.onerror = () => { if (!cancelled) console.warn('配件或备注图片解码失败') }
      element.src = resolved
    }
    void load().catch(error => { if (!cancelled) console.warn('配件或备注图片加载失败', error) })
    return () => { cancelled = true; if (element) { element.onload = null; element.onerror = null } }
  }, [src])
  if (!image) return null
  if (framed) rememberAccessoryImage(src, image)
  if (framed) {
    const frame = accessoryFrame(src, x, y, width, code)
    return <Group listening={false}>
      <Rect x={frame.x} y={frame.y} width={frame.frameWidth} height={frame.frameHeight} fill="#fff" cornerRadius={1}/>
      <KonvaImage image={image} crop={frame.crop} x={frame.imageX} y={frame.imageY} width={frame.width} height={frame.height}/>
      {code && <Text x={frame.x} y={frame.codeY} width={frame.frameWidth} height={12} text={code} align="center" fontSize={8} fontStyle="bold" fill="#475569"/>}
    </Group>
  }
  const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  const fittedWidth = image.naturalWidth * ratio
  const fittedHeight = image.naturalHeight * ratio
  return <KonvaImage image={image} x={x + (width - fittedWidth) / 2} y={y + (height - fittedHeight) / 2} width={fittedWidth} height={fittedHeight} listening={false}/>
}

export default function ImageGroupDetails({ group }: { group: ImageGroup }) {
  const label = finishLabel(group)
  return <Group listening={false}>{detailPanelsForGroup(group).map(panel => <DetailsPanel key={panel.id} group={panel}/>)}{label.text && <Text x={label.x + label.width} y={label.y} text={label.text} fontSize={10} fill="#ff4d4f" wrap="none" ref={node => { if (node) node.offsetX(node.width()) }} listening={false}/>}</Group>
}

function DetailsPanel({ group }: { group: ImageGroup }) {
  const details = group.details
  if (!details) return null
  const { x, y, width, line, fontSize, fields, bodyY, imageSize, noteX, noteWidth, noteY, noteLines, noteLine, noteFontSize, noteImageSize, noteImageY } = imageDetailsLayout(group)
  return <Group x={x} y={y} listening={false}>
    {fields.map((field, index) => <Text key={field.key} y={index * line} text={field.text} width={width} height={line} fontSize={Math.min(fontSize, field.fontSize ?? fontSize)} wrap="none" fontStyle="bold" fill="#475569" ellipsis/>)}
    {details.accessoryImage && <AccessoryImage src={details.accessoryImage} x={0} y={bodyY - y} width={imageSize} height={imageSize} code={details.accessoryCode} framed/>}
    {noteLines.map((value, index) => <Text key={`note-${index}`} x={noteX - x} y={noteY - y + index * noteLine} text={value} width={noteWidth} align="center" height={noteLine} fontSize={noteFontSize} fill="#475569" ellipsis/>)}
    {details.noteImage && noteImageSize > 0 && <AccessoryImage src={details.noteImage} x={noteX - x + (noteWidth - noteImageSize) / 2} y={noteImageY - y} width={noteImageSize} height={noteImageSize}/>} 
  </Group>
}
