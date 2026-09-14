import type { SearchHit, SearchProvider, SearchQuery } from './types'

const ENDPOINT = 'https://api.tavily.com/search'

interface TavilyResult {
  title?: unknown
  url?: unknown
  content?: unknown
}

interface TavilyResponse {
  results?: TavilyResult[]
}

/**
 * Tavily Search API（POST /search，Bearer 认证；免费档 1000 次/月）。
 * time_range: day/week/month/year——我们的 recency 枚举是其子集，直接透传。
 */
export class TavilySearchProvider implements SearchProvider {
  constructor(private apiKey: string) {}

  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchHit[]> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        query: q.query,
        max_results: Math.min(Math.max(q.max, 1), 10),
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        ...(q.recency ? { time_range: q.recency } : {})
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`Tavily ${res.status}${body ? `：${body}` : ''}`)
    }
    const data = (await res.json()) as TavilyResponse
    return (data.results ?? [])
      .slice(0, q.max)
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title : '',
        url: typeof r.url === 'string' ? r.url : '',
        snippet: typeof r.content === 'string' ? r.content : ''
      }))
      .filter((h) => h.url.length > 0)
  }
}
