import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
function StartupReady() {
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event('printflow-ui-ready')))
    return () => cancelAnimationFrame(frame)
  }, [])
  return <App />
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><StartupReady /></React.StrictMode>)
