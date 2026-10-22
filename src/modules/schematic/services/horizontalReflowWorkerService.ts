import { planHorizontalGroupReflow, type HorizontalGroupReflowPlan, type HorizontalGroupReflowRequest } from './horizontalGroupReflowService'

/** A short-lived worker gets geometry only; the UI keeps original SVG strings. */
export async function calculateHorizontalReflow(request: HorizontalGroupReflowRequest): Promise<HorizontalGroupReflowPlan> {
  if (typeof Worker === 'undefined') return planHorizontalGroupReflow(request)
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./horizontalReflow.worker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('横排计算超时，请重试')) }, 30000)
    const dispose = () => { clearTimeout(timer); worker.terminate() }
    worker.onmessage = (event: MessageEvent<{ plan?: HorizontalGroupReflowPlan; error?: string }>) => {
      dispose()
      if (event.data.plan) resolve(event.data.plan)
      else reject(new Error(event.data.error ?? '横排计算失败'))
    }
    worker.onerror = event => { dispose(); reject(new Error(event.message || '横排计算线程无法启动')) }
    worker.postMessage(request)
  })
}
