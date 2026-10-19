export const HEADER_TEXT_FONT_SIZE = 8.5
export const HEADER_TEXT_LINE_HEIGHT = 11

/** Keep one- and two-line captions centered with the same line spacing. */
export function headerTextLayout(lines: readonly string[], height: number) {
  const lineHeight = Math.min(HEADER_TEXT_LINE_HEIGHT, height / Math.max(1, lines.length))
  const top = (height - lines.length * lineHeight) / 2
  return lines.map((text, index) => {
    const y = top + index * lineHeight
    return {
      text, y, height: lineHeight,
      // SVG uses an alphabetic baseline; canvas Text centers within this box.
      baselineY: y + lineHeight / 2 + HEADER_TEXT_FONT_SIZE * .35,
    }
  })
}
