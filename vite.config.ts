import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['antd-masonry/es/masonry', 'antd-masonry/es/config-provider', '@ant-design/cssinjs'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.cargo-target/**', '**/.test-output/**', '**/.npm-cache/**'] },
  },
})

