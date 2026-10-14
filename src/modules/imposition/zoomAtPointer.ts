type Point = { x: number; y: number }

// Account for the scene's automatic centering before and after zooming.
export function zoomAtPointer(pointer: Point, offset: Point, oldZoom: number, newZoom: number, viewport: { width: number; height: number }, scene: { width: number; height: number }): Point {
  const axis = (point: number, pan: number, size: number, content: number) => {
    const oldCenter = Math.max(0, (size - content * oldZoom) / 2)
    const newCenter = Math.max(0, (size - content * newZoom) / 2)
    const scenePoint = (point - pan - oldCenter) / oldZoom
    return point - scenePoint * newZoom - newCenter
  }
  return { x: axis(pointer.x, offset.x, viewport.width, scene.width), y: axis(pointer.y, offset.y, viewport.height, scene.height) }
}
