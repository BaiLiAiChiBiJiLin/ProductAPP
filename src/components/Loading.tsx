import loadingGif from '../assets/loading.gif'

type LoadingProps = {
  size?: 'small' | 'medium' | 'large'
  text?: string
  inline?: boolean
}

export default function Loading({ size = 'medium', text, inline = false }: LoadingProps) {
  return <span className={`app-loading app-loading-${size}${inline ? ' app-loading-inline' : ''}`} role="status" aria-live="polite">
    <img src={loadingGif} alt="" aria-hidden="true" />
    {text && <span>{text}</span>}
  </span>
}
