import type { NoteImage } from '../../../model'

export const MAX_NOTE_IMAGES = 3
export const DEFAULT_NOTE_FONT_SIZE = 14
export const DEFAULT_NOTE_COLOR = '#666666'
type NoteImageSource = { noteImages?: NoteImage[]; noteImage?: string | null }

/** An explicit empty list clears legacy images; absent lists preserve older batches. */
export function getNoteImages(source: NoteImageSource): NoteImage[] {
  const images = source.noteImages ?? (source.noteImage ? [{ src: source.noteImage, name: '' }] : [])
  return images.filter(image => Boolean(image.src?.trim())).slice(0, MAX_NOTE_IMAGES)
    .map(image => ({ src: image.src, name: image.name ?? '' }))
}

export function sameNoteImages(left: NoteImage[], right: NoteImage[]): boolean {
  return left.length === right.length && left.every((image, index) => image.src === right[index].src && image.name === right[index].name)
}

/** Keep the legacy first-image field readable by older records and integrations. */
export function noteImagesPatch(images: NoteImage[]): { noteImages: NoteImage[]; noteImage: string } {
  const noteImages = getNoteImages({ noteImages: images })
  return { noteImages, noteImage: noteImages[0]?.src ?? '' }
}
