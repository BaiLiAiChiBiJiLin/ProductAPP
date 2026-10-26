import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_LAYOUT, LAYOUT_PRESET_STORAGE_KEY, deleteLayoutPreset, listLayoutPresets, saveLayoutPreset, type LayoutPresetInput, type LayoutPresetSnapshot } from './layoutPresetStore'

function rememberedPreset() {
  try { return localStorage.getItem(LAYOUT_PRESET_STORAGE_KEY) ?? undefined } catch { return undefined }
}

export function useImpositionLayoutPresets() {
  const [snapshot, setSnapshot] = useState<LayoutPresetSnapshot>()
  const [selectedId, setSelectedId] = useState<string | undefined>(rememberedPreset)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const mounted = useRef(true)
  const saveLock = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    listLayoutPresets().then(next => {
      if (!cancelled) setSnapshot(next)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [revision])
  const presets = snapshot?.presets ?? []
  const selected = presets.find(preset => preset.id === selectedId) ?? presets.find(preset => preset.name === '大版') ?? presets[0]
  const layoutKey = JSON.stringify(selected?.config ?? DEFAULT_LAYOUT)
  // Keep coordinate caches when only a preset's label/version or another preset changes.
  const layout = useMemo(() => JSON.parse(layoutKey) as typeof DEFAULT_LAYOUT, [layoutKey])
  useEffect(() => {
    if (!selected) return
    try { localStorage.setItem(LAYOUT_PRESET_STORAGE_KEY, selected.id) } catch { /* Preferences must not block packing. */ }
  }, [selected?.id])

  async function save(preset: LayoutPresetInput) {
    if (saveLock.current) throw new Error('正在保存版面配置，请稍候。')
    saveLock.current = true; setSaving(true)
    try {
      const next = await saveLayoutPreset(preset)
      if (mounted.current) {
        setSnapshot(next)
        setSelectedId(preset.id ?? next.presets.find(item => item.name === preset.name.trim())?.id)
      }
    } finally { saveLock.current = false; if (mounted.current) setSaving(false) }
  }
  async function remove() {
    if (!selected || saveLock.current) return
    saveLock.current = true; setSaving(true)
    try {
      const next = await deleteLayoutPreset(selected.id, selected.version)
      if (mounted.current) setSnapshot(next)
    } finally { saveLock.current = false; if (mounted.current) setSaving(false) }
  }
  return {
    presets, selected, layout, loading, saving, error,
    ready: !!selected && !loading && !saving && !error,
    canManage: !!snapshot?.canManage,
    preview: !!snapshot?.preview,
    select: setSelectedId,
    retry: () => setRevision(value => value + 1),
    save, remove,
  }
}

export type ImpositionLayoutPresetState = ReturnType<typeof useImpositionLayoutPresets>
