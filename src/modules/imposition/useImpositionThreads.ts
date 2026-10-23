import { useEffect, useState } from 'react'
import { getImpositionComputeInfo, type ImpositionComputeInfo } from './impositionRecords'

export const IMPOSITION_THREADS_STORAGE_KEY = 'printflow.imposition.threads.v1'
type ThreadPreference = 'auto' | number

function readPreference(): ThreadPreference {
  try {
    const stored = localStorage.getItem(IMPOSITION_THREADS_STORAGE_KEY)
    const value = stored === null ? NaN : Number(stored)
    return Number.isSafeInteger(value) && value > 0 ? value : 'auto'
  } catch { return 'auto' }
}

function savePreference(value: ThreadPreference) {
  try { localStorage.setItem(IMPOSITION_THREADS_STORAGE_KEY, String(value)) } catch { /* A blocked preference store must not block packing. */ }
}

export function useImpositionThreads(forceAutomatic = false) {
  const [preference, setPreference] = useState<ThreadPreference>(readPreference)
  const [info, setInfo] = useState<ImpositionComputeInfo>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    void getImpositionComputeInfo().then(result => {
      if (!active) return
      if (!result || !Number.isSafeInteger(result.logicalCores) || result.logicalCores < 1
        || !Number.isSafeInteger(result.defaultThreads) || result.defaultThreads < 1 || result.defaultThreads > result.logicalCores) {
        throw new Error('Invalid native CPU information')
      }
      setInfo(result)
      setPreference(current => {
        const next = current === 'auto' ? current : Math.min(current, result.logicalCores)
        if (next !== current) savePreference(next)
        return next
      })
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [revision])

  const changePreference = (value: ThreadPreference) => {
    if (!info) return
    const next = value === 'auto' ? value : Math.min(info.logicalCores, Math.max(1, Math.floor(value)))
    setPreference(next)
    savePreference(next)
  }
  return {
    info,
    failed,
    preference: info && !forceAutomatic ? preference : 'auto' as const,
    // Omission delegates automatic CPU detection to the native worker. In
    // particular, a failed read must never use a browser's privacy-capped CPU count.
    threadCount: !forceAutomatic && info && preference !== 'auto' ? Math.min(preference, info.logicalCores) : undefined,
    changePreference,
    retry: () => { setFailed(false); setRevision(current => current + 1) },
  }
}
