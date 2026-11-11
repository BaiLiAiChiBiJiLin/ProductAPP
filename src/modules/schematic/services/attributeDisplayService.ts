/** Keep saved option selections while omitting the no-technique placeholder in read-only views. */
export function isHiddenAttributeValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().replace(/\s+/g, ' ').toLowerCase() === 'no additional technique'
}
