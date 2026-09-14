import type { Tool } from '../registry'
import { getConfig } from '../../config'
import { TavilySearchProvider } from '../../search/tavily'

interface Args {
  query: string
  max_results?: number
  recency?: 'day' | 'week' | 'month'
}

const RESULT_CAP = 8_000

export const webSearchTool: Tool<Args> = {
  name: 'web_search',
  description:
    '联网搜索（Tavily），返回标题/URL/摘要列表。需要最新信息、官方文档、版本号、库用法、新闻等模型知识覆盖不到的内容时使用；摘要不够时用 web_fetch 读取具体网页全文。',
  mutating: false,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（可用英文提高结果质量）' },
      max_results: { type: 'number', description: '结果条数，默认 5，上限 10' },
      recency: { type: 'string', enum: ['day', 'week', 'month'], description: '时效过滤（可选）：只看最近一天/一周/一月' }
    },
    required: ['query']
  },
  validate: (a) => (typeof a?.query === 'string' && a.query.trim().length > 0 ? null : 'query 必须是非空字符串'),
  async execute(args, _ctx, signal) {
    const cfg = getConfig().webSearch
    if (!cfg?.apiKey) return { content: 'web_search 未配置：请在设置 → 通用 中填写 Tavily API Key', isError: true }
    const max = Math.min(Math.max(args.max_results ?? 5, 1), 10)
    try {
      const provider = new TavilySearchProvider(cfg.apiKey)
      const hits = await provider.search({ query: args.query.trim(), max, recency: args.recency }, signal)
      if (hits.length === 0) return { content: `没有找到与「${args.query}」相关的结果，可换关键词重试` }
      const lines = hits.map(
        (h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet.slice(0, 300).replace(/\s+/g, ' ').trim()}`
      )
      return { content: lines.join('\n\n').slice(0, RESULT_CAP) }
    } catch (err) {
      return { content: `搜索失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
}
