export interface JiraResource { readonly id: string; readonly base: string; readonly site: string }
export interface ConnectionResource extends JiraResource { readonly epoch: number }

export function decodeToolJson(content: unknown): unknown {
  const blocks: readonly unknown[] = Array.isArray(content) ? content : []
  const raw = blocks.map((entry) => {
    const text = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['text'] : undefined
    return typeof text === 'string' ? text : ''
  }).join('\n').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '')
  return JSON.parse(raw) as unknown
}

export function selectJiraResource(data: unknown, allowsHttp?: (url: URL) => boolean): JiraResource | undefined {
  for (const item of Array.isArray(data) ? data : [data]) {
    if (!item || typeof item !== 'object') continue
    const { id, url } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim() || typeof url !== 'string' || !url.trim()) continue
    let parsed: URL
    try { parsed = new URL(url) } catch { continue }
    if (parsed.username || parsed.password) continue
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && allowsHttp?.(parsed))) continue
    return { id, base: `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`, site: parsed.host }
  }
}
