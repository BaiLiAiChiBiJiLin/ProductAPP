type Rect = { x: number; y: number; width: number; height: number }
type SizedUnit<T> = { value: T; width: number; height: number }
type Section<T> = { key: string; units: SizedUnit<T>[]; maxColumns: number }
type Placement<T> = Rect & { value: T }
export type PackedSection<T> = Rect & { key: string; columns: number; placements: Placement<T>[] }

/** Independent column bottoms let short units fill space beside a tall unit. */
export function packGroupColumns<T>(units: Array<{ value: T; height: number }>, columns: number, top: number, bottom: number, gap: number) {
  const ends = Array.from({ length: columns }, () => top)
  const placements: Array<{ value: T; column: number; y: number; height: number }> = []
  for (const unit of units) {
    const column = ends.indexOf(Math.min(...ends))
    if (ends[column] + unit.height > bottom + 1e-7) continue
    placements.push({ value: unit.value, column, y: ends[column], height: unit.height })
    ends[column] += unit.height + gap
  }
  return { placements, bottom: placements.length ? Math.max(...ends) - gap : top }
}

/** Each mode owns one header rectangle per page; unused width can host another mode. */
export function packCompactSections<T>(sections: Section<T>[], area: Rect, headerHeight: number, gap: number): PackedSection<T>[][] {
  const pending = sections.map(section => ({ ...section, units: [...section.units] }))
  const pages: PackedSection<T>[][] = []
  while (pending.some(section => section.units.length)) {
    const output: PackedSection<T>[] = []
    const free: Rect[] = [{ ...area }]
    for (const section of pending) {
      if (!section.units.length) continue
      const width = Math.max(...section.units.map(unit => unit.width))
      const candidates = free.flatMap((rect, index) => {
        const columns = Math.min(section.maxColumns, section.units.length, Math.floor((rect.width + gap + 1e-7) / (width + gap)))
        if (columns < 1) return []
        const result = packGroupColumns(section.units.map(unit => ({ value: unit, height: unit.height })), columns,
          rect.y + headerHeight + gap, rect.y + rect.height, gap)
        if (!result.placements.length) return []
        return [{ index, rect, columns, result }]
      }).sort((a, b) => b.result.placements.length - a.result.placements.length || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      const candidate = candidates[0]
      if (!candidate) continue
      const { index, rect, columns, result } = candidate
      const usedWidth = columns * width + (columns - 1) * gap
      const height = result.bottom - rect.y
      const placements = result.placements.map(placed => ({ value: placed.value.value,
        x: rect.x + placed.column * (width + gap), y: placed.y, width, height: placed.height }))
      output.push({ key: section.key, x: rect.x, y: rect.y, width: usedWidth, height, columns, placements })
      const used = new Set(result.placements.map(placed => placed.value))
      section.units = section.units.filter(unit => !used.has(unit))
      free.splice(index, 1)
      const rightWidth = rect.width - usedWidth - gap
      const belowHeight = rect.height - height - gap
      if (rightWidth > 0) free.push({ x: rect.x + usedWidth + gap, y: rect.y, width: rightWidth, height })
      if (belowHeight > 0) free.push({ x: rect.x, y: rect.y + height + gap, width: rect.width, height: belowHeight })
    }
    if (!output.length) throw new Error('图片组在保持当前尺寸时超出整页排列区域，请扩大排列区域或减少组内图片。')
    pages.push(output)
  }
  return pages
}
