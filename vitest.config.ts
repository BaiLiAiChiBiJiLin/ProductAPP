import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', include: ['tests/ui.test.tsx', 'tests/ruler-controls.test.tsx', 'tests/pool-card.test.tsx', 'tests/pdf-staging.test.tsx'], maxWorkers: 1 } })

