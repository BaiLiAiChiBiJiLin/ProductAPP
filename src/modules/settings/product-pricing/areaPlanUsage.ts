import { sameEntity, type EntityReference } from '../product-options/model'

export function matchesAttribute(row: { optionName: string; reference: EntityReference }, optionName: string, reference: EntityReference): boolean {
  return row.optionName === optionName && sameEntity(row.reference, reference)
}
