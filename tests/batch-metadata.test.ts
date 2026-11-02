import { expect, test } from 'vitest'
import { initializeBatchMetadata } from '../src/modules/schematic/services/batchMetadataService'

test('new batches use the local calendar at creation and the saved username', () => {
  expect(initializeBatchMetadata('霍', { now: new Date(2026, 10, 2, 0, 15) })).toEqual({
    customerName: '', drawingDate: '2026-11-02', estimatedShipDate: '2026-11-10', designer: '霍',
  })
  expect(initializeBatchMetadata('另一位用户', { now: new Date(2026, 10, 3, 0, 15) })).toMatchObject({
    drawingDate: '2026-11-03', estimatedShipDate: '2026-11-11', designer: '另一位用户',
  })
})

test.each([
  ['2026-10-27', '2026-11-04'],
  ['2026-12-28', '2027-01-05'],
  ['2028-02-25', '2028-03-04'],
])('missing shipment date is eight calendar days after %s', (drawingDate, expected) => {
  expect(initializeBatchMetadata('霍', { metadata: { drawingDate } }).estimatedShipDate).toBe(expected)
})

test('history fills missing fields from its saved local date instead of today', () => {
  const savedAt = new Date(2026, 9, 31, 0, 15).toISOString()
  expect(initializeBatchMetadata('霍', { savedAt, now: new Date(2026, 10, 2), metadata: {
    customerName: 'YUKINO OISHI', drawingDate: '', estimatedShipDate: '', designer: '',
  } })).toEqual({
    customerName: 'YUKINO OISHI', drawingDate: '2026-10-31', estimatedShipDate: '2026-11-08', designer: '霍',
  })
})

test('saved drawing date determines the default shipment date and saved edits are retained', () => {
  const metadata = { customerName: '客户', drawingDate: '2026-10-01', estimatedShipDate: '2026-10-20', designer: '原设计者' }
  const options = { savedAt: '2026-10-15', metadata }
  expect(initializeBatchMetadata('当前用户', options)).toEqual(metadata)
  expect(initializeBatchMetadata('当前用户', { ...options, metadata: { ...metadata, estimatedShipDate: '' } })).toEqual({
    ...metadata, estimatedShipDate: '2026-10-09',
  })
})
