import type { CSSProperties, ReactNode } from 'react'
import './module-page.css'

type Props = {
  title: string
  description?: ReactNode
  actions?: ReactNode
  toolbar?: ReactNode
  notice?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/** Shared workspace spacing and typography, matching the schematic upload page. */
export default function ModulePage({ title, description, actions, toolbar, notice, footer, children, className = '', style }: Props) {
  return <div className={`module-page ${className}`} style={style}>
    <section className="module-page-card">
      <header className="module-page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions}</header>
      {notice && <div className="module-page-notice">{notice}</div>}
      {toolbar && <div className="module-page-tools">{toolbar}</div>}
      {children}
      {footer && <footer className="module-page-footer">{footer}</footer>}
    </section>
  </div>
}
