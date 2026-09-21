/**
 * Back artwork is the first image element in document order, regardless of
 * layer names. Keep its original XML, ancestor transforms, defs and cutlines.
 * Mirroring belongs to Item.mirrorX in the canvas/export, not this SVG.
 */
export function backLayerSvg(svg: string): string {
  // Tokenize XML tags without interpreting quoted attribute contents as markup.
  // Comments/CDATA/processing instructions are consumed whole and never counted.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g
  const images: Array<{ start: number; end: number }> = []
  let openImage: number | undefined
  for (const match of svg.matchAll(tokens)) {
    const tag = match[0]
    if (/^<(?:[\w.-]+:)?image(?=[\s/>])/.test(tag)) {
      if (/\/\s*>$/.test(tag)) images.push({ start: match.index, end: match.index + tag.length })
      else openImage = match.index
    } else if (/^<\/(?:[\w.-]+:)?image\s*>$/.test(tag) && openImage !== undefined) {
      images.push({ start: openImage, end: match.index + tag.length })
      openImage = undefined
    }
  }
  let result = svg
  for (let index = images.length - 1; index >= 1; index--) {
    const { start, end } = images[index]
    result = result.slice(0, start) + result.slice(end)
  }
  return result
}
