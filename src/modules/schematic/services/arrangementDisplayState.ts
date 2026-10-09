import type { DimensionDisplayOverride } from './imageDimensionService'

export type AccessoryVisual = { scale: number; x: number; y: number }
export type ArrangementDisplayState = {
  dimensionDisplayOverrides: Map<string, DimensionDisplayOverride>
  visualScales: Map<string, number>
  accessoryVisuals: Map<string, AccessoryVisual>
  zoom: number
}

export const emptyArrangementDisplayState = (): ArrangementDisplayState => ({
  dimensionDisplayOverrides: new Map(), visualScales: new Map(), accessoryVisuals: new Map(), zoom: 1,
})

export type SavedArrangementDisplay = {
  dimensionDisplayOverrides: [string, DimensionDisplayOverride][]
  visualScales: [string, number][]
  accessoryVisuals: [string, AccessoryVisual][]
  zoom: number
}

export function saveArrangementDisplay(state: ArrangementDisplayState): SavedArrangementDisplay {
  return {
    dimensionDisplayOverrides: [...state.dimensionDisplayOverrides],
    visualScales: [...state.visualScales], accessoryVisuals: [...state.accessoryVisuals], zoom: state.zoom,
  }
}

export function restoreArrangementDisplay(state: SavedArrangementDisplay): ArrangementDisplayState {
  return {
    dimensionDisplayOverrides: new Map(state.dimensionDisplayOverrides),
    visualScales: new Map(state.visualScales), accessoryVisuals: new Map(state.accessoryVisuals), zoom: state.zoom,
  }
}
