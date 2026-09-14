/** 联网搜索后端抽象（对齐 providers 层思路：协议差异收在 provider 实现里，R1 手写 HTTP） */

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

export interface SearchQuery {
  query: string
  /** 结果条数（provider 实现自行截断） */
  max: number
  /** 时效过滤：day/week/month；缺省 = 不过滤 */
  recency?: 'day' | 'week' | 'month'
}

export interface SearchProvider {
  search(q: SearchQuery, signal: AbortSignal): Promise<SearchHit[]>
}
