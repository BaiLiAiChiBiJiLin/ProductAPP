import { expect, test } from 'vitest'
import type { Asset } from '../src/model'
import { reconcileCloudBatchAssets, reconcileCloudBatchMetadata } from '../src/modules/schematic/services/cloudBatchReconciliation'

const asset: Asset = {
  id: 'a', name: 'image', productId: 'product', productName: 'Product', width: 10, height: 10,
  svg: '', previewUrl: '', thumbnailUrl: '', storagePath: 'temp-assets/a.svg', attributes: { QT: '12', Size: 'small' },
}
const saved: Asset = { ...asset, storagePath: 'printflow:a', attributes: { ...asset.attributes, Finish: 'polished' } }

test.each(['0', '', '30'])('keeps newer QT %j and notes while applying the shared resource path', qt => {
  const edited = { ...asset, attributes: { ...asset.attributes, QT: qt }, note: 'new note' }
  expect(reconcileCloudBatchAssets([edited], [asset], [saved])).toEqual([{ ...edited, storagePath: saved.storagePath }])
})

test('accepts automatic Finish matching for an unchanged submitted product', () => {
  const [result] = reconcileCloudBatchAssets([asset], [asset], [saved])
  expect(result.attributes).toEqual({ QT: '12', Size: 'small', Finish: 'polished' })
  expect(result.storagePath).toBe('printflow:a')
})

test.each([
  { productId: 'other-product' },
  { productName: 'Other custom name' },
  { finishMatchDisabled: true },
  { attributes: { QT: '12', Size: 'large' } },
])('does not apply Finish from an outdated product configuration: %j', patch => {
  const edited = { ...asset, ...patch }
  expect(reconcileCloudBatchAssets([edited], [asset], [saved])[0].attributes).toEqual(edited.attributes)
})

test('never maps removed or replaced resources by position, and follows IDs after a reorder', () => {
  const b = { ...asset, id: 'b', storagePath: 'temp-assets/b.svg' }
  const savedB = { ...b, storagePath: 'printflow:b' }
  const replacement = { ...asset, id: 'replacement', storagePath: 'temp-assets/replacement.svg' }
  expect(reconcileCloudBatchAssets([b, replacement], [asset, b], [saved, savedB]))
    .toEqual([{ ...b, storagePath: 'printflow:b' }, replacement])
  expect(reconcileCloudBatchAssets([], [asset], [saved])).toEqual([])
  const changedPath = { ...asset, storagePath: 'temp-assets/new-artwork.svg' }
  expect(reconcileCloudBatchAssets([changedPath], [asset], [saved])[0].storagePath).toBe(changedPath.storagePath)
})

test('merges metadata field by field without restoring edited or cleared local values', () => {
  const before = { customerName: 'customer', drawingDate: '2026-11-02', estimatedShipDate: '2026-11-10', designer: 'local' }
  const current = { ...before, customerName: 'new customer', estimatedShipDate: '' }
  expect(reconcileCloudBatchMetadata(current, before, { ...before, designer: 'normalized' }))
    .toEqual({ ...current, designer: 'normalized' })
})
