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
    proxy: {
      '/__printflow_remote': {
        target: 'https://fakestar-oss.oss-us-west-1.aliyuncs.com',
        changeOrigin: true,
        rewrite: (path) => {
          const raw = path.match(/[?&]url=([^&]+)/)?.[1]
          if (!raw) return '/'
          const remote = new URL(decodeURIComponent(raw))
          if (remote.protocol !== 'https:' && remote.protocol !== 'http:') return '/'
          return remote.pathname + remote.search
        },
      },
    },
  },
})

