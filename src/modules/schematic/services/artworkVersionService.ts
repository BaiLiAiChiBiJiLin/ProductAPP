const CHUNK = 256 * 1024
const versions = new Map<string, { version: Promise<string>; bytes: number }>()
let retainedBytes = 0

async function digest(bytes: Uint8Array) {
  const value = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Content identity without allocating a second, full-size UTF-8 artwork buffer. */
export function artworkVersion(svg: string): Promise<string> {
  const found = versions.get(svg)
  if (found) return found.version
  const version = (async () => {
    const chunks: string[] = []
    for (let start = 0; start < svg.length;) {
      let end = Math.min(start + CHUNK, svg.length)
      if (end < svg.length && /[\uD800-\uDBFF]/.test(svg[end - 1])) end--
      chunks.push(await digest(new TextEncoder().encode(svg.slice(start, end))))
      start = end
      if (start < svg.length) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return digest(new TextEncoder().encode(`artwork-v1:${svg.length}:${chunks.join(':')}`))
  })()
  const bytes = svg.length * 2
  versions.set(svg, { version, bytes }); retainedBytes += bytes
  // Pending callers share the immutable source. Completed large sources are not
  // kept alive by a fingerprint cache after their workspace has been closed.
  void version.finally(() => {
    while (versions.size > 32 || retainedBytes > 8 * 1024 * 1024) {
      const first = versions.entries().next().value
      if (!first) break
      versions.delete(first[0]); retainedBytes -= first[1].bytes
    }
  }).catch(() => { if (versions.get(svg)?.version === version) { versions.delete(svg); retainedBytes -= bytes } })
  return version
}
