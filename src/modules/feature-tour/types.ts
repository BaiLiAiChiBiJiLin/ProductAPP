export type FeatureTourSlide = {
  id: string
  title: string
  description: string
  shortcuts: string[]
  animation: string
  poster: string
  alt: string
}

export type FeatureTourRelease = {
  version: string
  id: string
  enabled: boolean
  slides: FeatureTourSlide[]
}
