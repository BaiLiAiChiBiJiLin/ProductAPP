import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dayjs } from 'dayjs'
import type { BatchListQuery } from '../services/batchHistoryService'

export function useBatchHistoryFilters(enabled: boolean) {
  const [query, setQuery] = useState<BatchListQuery>({ page: 1, pageSize: 12 })
  const [name, setName] = useState('')
  const [savedDate, setSavedDate] = useState<Dayjs | null>(null)
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPending = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const apply = useCallback((nextName: string, nextDate: Dayjs | null) => {
    const filters = {
      search: nextName.trim() || undefined,
      dateFrom: nextDate?.startOf('day').toISOString(),
      dateTo: nextDate?.add(1, 'day').startOf('day').toISOString(),
    }
    // Enter and date selection can flush a pending debounce. Identical filters
    // must not query twice or reset the page the user subsequently navigates to.
    setQuery(current => current.search === filters.search && current.dateFrom === filters.dateFrom && current.dateTo === filters.dateTo
      ? current : { page: 1, pageSize: current.pageSize, ...filters })
  }, [])

  useEffect(() => {
    cancelPending()
    if (!enabled || composing) return
    timer.current = setTimeout(() => { timer.current = null; apply(name, savedDate) }, 400)
    return cancelPending
  }, [name, savedDate, composing, enabled, apply, cancelPending])

  const searchNow = () => {
    if (!enabled || composingRef.current) return
    cancelPending()
    apply(name, savedDate)
  }
  const changeDate = (date: Dayjs | null) => {
    cancelPending()
    setSavedDate(date)
    if (enabled && !composingRef.current) apply(name, date)
  }
  const clear = () => {
    cancelPending()
    composingRef.current = false
    setComposing(false)
    setName('')
    setSavedDate(null)
    setQuery(current => ({ page: 1, pageSize: current.pageSize }))
  }

  return {
    query, setQuery, name, setName, savedDate, changeDate, searchNow, clear,
    compositionStart: () => { cancelPending(); composingRef.current = true; setComposing(true) },
    compositionEnd: (value: string) => { composingRef.current = false; setName(value); setComposing(false) },
  }
}
