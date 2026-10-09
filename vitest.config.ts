import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', include: ['tests/batch-history-filters.test.ts', 'tests/history-thumbnails.test.tsx', 'tests/batch-history-panel.test.tsx', 'tests/storage-settings.test.tsx', 'tests/arrangement-frame-export.test.ts', 'tests/product-group-drag.test.tsx', 'tests/asset-details.test.tsx', 'tests/pdf-memory.test.ts', 'tests/batch-history.test.ts', 'tests/schematic-review.test.tsx', 'tests/imposition.test.tsx', 'tests/ui.test.tsx', 'tests/ruler-controls.test.tsx', 'tests/ruler-drag.test.tsx', 'tests/pool-card.test.tsx', 'tests/pdf-staging.test.tsx', 'tests/dimension-export.test.ts', 'tests/upload-service.test.ts'], maxWorkers: 1 } })
