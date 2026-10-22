/** Space is reserved for canvas interaction, not focused action buttons. */
export function installButtonKeyboardGuard(doc: Document = document) {
  const onSpace = (event: KeyboardEvent) => {
    if (event.code !== 'Space' && event.key !== ' ' && event.key !== 'Spacebar') return
    if (!(event.target instanceof Element)) return
    const button = event.target.closest('button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], [role="button"]')
    if (!button) return
    // Switches and other selection controls can also be rendered as buttons.
    if (button.matches('[role="switch"], [role="checkbox"], [role="radio"]')) return
    if (event.target.closest('textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]')) return
    if (event.target instanceof HTMLInputElement && !event.target.matches('input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]')) return
    event.preventDefault()
    // Also block explicit component-level Space handlers, such as asset cards.
    event.stopPropagation()
  }
  doc.addEventListener('keydown', onSpace, true)
  doc.addEventListener('keyup', onSpace, true)
  return () => {
    doc.removeEventListener('keydown', onSpace, true)
    doc.removeEventListener('keyup', onSpace, true)
  }
}
