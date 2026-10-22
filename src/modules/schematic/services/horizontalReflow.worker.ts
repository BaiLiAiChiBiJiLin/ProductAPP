import { planHorizontalGroupReflow, type HorizontalGroupReflowRequest } from './horizontalGroupReflowService'

self.onmessage = (event: MessageEvent<HorizontalGroupReflowRequest>) => {
  try { self.postMessage({ plan: planHorizontalGroupReflow(event.data) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
