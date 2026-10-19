import { useEffect, useRef, useState } from 'react'
import { Pagination } from 'antd'

type Customer = { name: string; count: number }
type Props = { customers: Customer[]; onSelect: (customer: string) => void }
const COLORS = ['#1677ff', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#6366f1', '#84cc16']

function pieGeometry(width: number, height: number) {
  const labelWidth = Math.min(120, Math.max(84, width * .22))
  const radius = Math.max(0, Math.min((width - labelWidth * 2 - 44) / 2, height / 2 - 30))
  return { labelWidth, radius, innerRadius: radius * .1 }
}

function customerLabels(customers: Customer[], width: number, height: number, page: number) {
  const total = customers.reduce((sum, customer) => sum + customer.count, 0)
  const { radius, labelWidth } = pieGeometry(width, height)
  let start = -Math.PI / 2
  const labels = customers.map((customer, index) => {
    const angle = customers.length === 1 ? -Math.PI / 4 : start + customer.count / total * Math.PI
    start += customer.count / total * Math.PI * 2
    return { ...customer, index, angle, right: Math.cos(angle) >= 0, y: height / 2 + Math.sin(angle) * (radius + 18), labelWidth }
  }).slice((page - 1) * 6, page * 6)
  for (const right of [false, true]) {
    const side = labels.filter(label => label.right === right).sort((a, b) => a.y - b.y)
    const gap = Math.min(52, Math.max(0, height - 52) / Math.max(1, side.length - 1))
    side.forEach((label, index) => { label.y = Math.max(26, label.y, index ? side[index - 1].y + gap : 26) })
    for (let index = side.length - 1; index >= 0; index--) side[index].y = Math.min(side[index].y, index === side.length - 1 ? height - 26 : side[index + 1].y - gap)
  }
  return labels
}

export default function PoolCustomerPie({ customers, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hoverRef = useRef<string | undefined>(undefined)
  const redrawRef = useRef<(() => void) | undefined>(undefined)
  const [hovered, setHovered] = useState<string>()
  const [page, setPage] = useState(1)
  const [size, setSize] = useState({ width: 480, height: 360 })
  const pageRef = useRef(1)
  const total = customers.reduce((sum, customer) => sum + customer.count, 0)
  const currentPage = Math.min(page, Math.max(1, Math.ceil(customers.length / 6)))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let progress = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0
    let frame = 0
    let started: number | undefined
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      if (!width || !height) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const density = window.devicePixelRatio || 1
      canvas.width = Math.round(width * density)
      canvas.height = Math.round(height * density)
      ctx.scale(density, density)
      const { radius, innerRadius, labelWidth } = pieGeometry(width, height)
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(width / 2, height / 2)
      ctx.arc(width / 2, height / 2, radius + 4, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2)
      ctx.closePath(); ctx.clip()
      let start = -Math.PI / 2
      customers.forEach((customer, index) => {
        const fraction = customer.count / total
        const end = start + fraction * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(width / 2, height / 2)
        ctx.arc(width / 2, height / 2, radius, start, end)
        ctx.closePath()
        ctx.fillStyle = COLORS[index % COLORS.length]
        ctx.globalAlpha = hoverRef.current && hoverRef.current !== customer.name ? .62 : 1
        ctx.fill()
        ctx.globalAlpha = 1
        if (progress === 1 && fraction >= .055 && radius > 50) {
          const middle = (start + end) / 2
          const distance = radius * .65
          ctx.fillStyle = '#fff'
          ctx.font = `600 ${radius > 140 ? 17 : 13}px "Segoe UI", "Microsoft YaHei", sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(`${Math.round(fraction * 100)}%`, width / 2 + Math.cos(middle) * distance, height / 2 + Math.sin(middle) * distance)
        }
        start = end
      })
      // Draw individual radial separators only across the visible ring.
      // Their width stays constant without closed-wedge miter spikes.
      if (customers.length > 1) {
        let boundary = -Math.PI / 2
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.lineCap = 'butt'
        customers.forEach(customer => {
          const edgeX = width / 2 + Math.cos(boundary) * radius
          const edgeY = height / 2 + Math.sin(boundary) * radius
          ctx.beginPath()
          ctx.moveTo(width / 2 + Math.cos(boundary) * (innerRadius - 1), height / 2 + Math.sin(boundary) * (innerRadius - 1))
          ctx.lineTo(edgeX, edgeY)
          ctx.stroke()
          boundary += customer.count / total * Math.PI * 2
        })
      }
      // A small center opening keeps narrow slice tips from crowding together.
      ctx.beginPath()
      ctx.arc(width / 2, height / 2, innerRadius, 0, Math.PI * 2)
      ctx.fillStyle = '#fff'; ctx.fill()
      ctx.restore()
      if (progress === 1) customerLabels(customers, width, height, pageRef.current).forEach(label => {
        const edgeX = width / 2 + Math.cos(label.angle) * radius
        const edgeY = height / 2 + Math.sin(label.angle) * radius
        const elbowX = width / 2 + Math.cos(label.angle) * (radius + 14)
        const endX = label.right ? width - labelWidth - 10 : labelWidth + 10
        ctx.beginPath(); ctx.moveTo(edgeX, edgeY); ctx.lineTo(elbowX, label.y); ctx.lineTo(endX, label.y)
        ctx.strokeStyle = COLORS[label.index % COLORS.length]; ctx.lineWidth = 1.5; ctx.stroke()
      })
    }
    redrawRef.current = draw
    draw()
    const animate = (timestamp: number) => {
      started ??= timestamp
      const elapsed = Math.min(1, (timestamp - started) / 750)
      progress = 1 - Math.pow(1 - elapsed, 3)
      draw()
      if (elapsed < 1) frame = requestAnimationFrame(animate)
    }
    if (progress < 1) frame = requestAnimationFrame(animate)
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect()
      if (width && height) setSize(current => current.width === width && current.height === height ? current : { width, height })
      draw()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    return () => { observer.disconnect(); cancelAnimationFrame(frame); redrawRef.current = undefined }
  }, [customers, total])
  useEffect(() => { hoverRef.current = hovered; redrawRef.current?.() }, [hovered])
  useEffect(() => { pageRef.current = currentPage; redrawRef.current?.() }, [currentPage])

  function customerAt(clientX: number, clientY: number): string | undefined {
    const canvas = canvasRef.current
    if (!canvas || !total) return
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left - rect.width / 2
    const y = clientY - rect.top - rect.height / 2
    const { radius, innerRadius } = pieGeometry(rect.width, rect.height)
    const distance = Math.hypot(x, y)
    if (distance > radius || distance < innerRadius) return
    const angle = (Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)
    let edge = 0
    return customers.find(customer => { edge += customer.count / total * Math.PI * 2; return angle < edge })?.name
  }

  return <section className="pool-pie-distribution" aria-label="客户图片占比">
    <div className="pool-section-heading"><h3>客户图片占比</h3><span>点击扇区查看客户图片</span></div>
    <div className="pool-pie-chart"><canvas ref={canvasRef} role="img" aria-label={`客户图片占比饼图，共 ${total} 张图片，${customers.length} 位客户`} onMouseMove={event => setHovered(customerAt(event.clientX, event.clientY))} onMouseLeave={() => setHovered(undefined)} onClick={event => { const name = customerAt(event.clientX, event.clientY); if (name) onSelect(name) }} style={{ cursor: hovered ? 'pointer' : 'default' }}/>{hovered && <span className="pool-pie-tooltip">{hovered} · {customers.find(customer => customer.name === hovered)?.count} 张</span>}<div className="pool-pie-callouts">{customerLabels(customers, size.width, size.height, currentPage).map(customer => <button style={{ width: customer.labelWidth, top: customer.y, ...(customer.right ? { right: 4 } : { left: 4 }) }} key={customer.name} onClick={() => onSelect(customer.name)} onMouseEnter={() => setHovered(customer.name)} onFocus={() => setHovered(customer.name)} onBlur={() => setHovered(undefined)} onMouseLeave={() => setHovered(undefined)} title={`查看${customer.name}的图片`}><span className="pool-pie-swatch" style={{ background: COLORS[customer.index % COLORS.length] }}/><span className="pool-pie-customer">{customer.name}</span><span className="pool-pie-callout-values">{customer.count} 张 · {Math.round(customer.count / total * 100)}%</span></button>)}</div></div>
    {customers.length > 6 && <Pagination size="small" current={currentPage} pageSize={6} total={customers.length} showSizeChanger={false} onChange={setPage}/>}
  </section>
}
