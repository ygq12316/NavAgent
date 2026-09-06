// src/renderer/src/components/DiffPane.tsx
/** Diff pane（对标 CC 桌面端）：左文件列表 / 右逐文件 unified diff；点行加评论，批量收集后以 steer 发回会话。 */
import { useCallback, useEffect, useState } from 'react'
import type { DiffFileEntry, DiffResult } from '@shared/types'
import { getApi } from '../api'
import { DiffView } from './DiffView'

interface Props {
  sessionId: string
  /** Git 面板点击改动文件 → 聚焦该文件 diff（key 变化触发重新定位） */
  focusPath?: string | null
  focusKey?: number
  /** 提交评论（作为 steering 注入运行中的会话；空闲则作为新消息） */
  onComment: (text: string) => void
}

const STATUS_LABEL: Record<DiffFileEntry['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除'
}

export function DiffPane({ sessionId, focusPath = null, focusKey = 0, onComment }: Props) {
  const [data, setData] = useState<DiffResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  /** path → 行号 → 评论 */
  const [comments, setComments] = useState<Map<string, Map<number, string>>>(new Map())
  const [commentFor, setCommentFor] = useState<{ path: string; line: number; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const d = await getApi().diffGet(sessionId)
      setData(d)
      // 默认选中第一个文件（对齐 CC 桌面端：打开即见内容）
      if (d.files.length > 0) setActive((cur) => (cur && d.files.some((f) => f.path === cur) ? cur : d.files[0]!.path))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setComments(new Map())
    setActive(null)
    void refresh()
  }, [refresh])

  const files = data?.files ?? []

  // Git 面板点击的文件：数据就绪后聚焦（focusKey 变化触发重新定位）
  useEffect(() => {
    if (focusPath && data && data.files.some((f) => f.path === focusPath)) setActive(focusPath)
  }, [focusKey, focusPath, data])

  const current = files.find((f) => f.path === active) ?? null

  const addComment = (): void => {
    if (!commentFor || !commentFor.text.trim()) {
      setCommentFor(null)
      return
    }
    setComments((prev) => {
      const next = new Map(prev)
      const m = new Map(next.get(commentFor.path) ?? [])
      m.set(commentFor.line, commentFor.text.trim())
      next.set(commentFor.path, m)
      return next
    })
    setCommentFor(null)
  }

  const commentCount = [...comments.values()].reduce((n, m) => n + m.size, 0)

  const submitComments = (): void => {
    const lines: string[] = ['以下是代码审查意见，请按要求修改：']
    for (const [path, m] of comments) {
      for (const [line, text] of m) lines.push(`- ${path}:${line} → ${text}`)
    }
    onComment(lines.join('\n'))
    setComments(new Map())
  }

  return (
    <div className="diff-pane">
      <div className="diff-toolbar">
        <span className="diff-source mono">{data ? (data.source === 'git' ? 'git diff' : '会话内改动') : ''}</span>
        <span className="meta-spacer" />
        {commentCount > 0 && (
          <button className="btn btn-primary" onClick={submitComments} title="把行内评论批量发给 Claude">
            发送 {commentCount} 条评论
          </button>
        )}
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>
      {files.length === 0 ? (
        <div className="diff-empty">{loading ? '' : '本会话暂无文件改动（agent 改动文件后出现 diff）'}</div>
      ) : (
        <div className="diff-body">
          <div className="diff-files">
            {files.map((f) => (
              <button key={f.path} className={`diff-file${f.path === active ? ' on' : ''}`} onClick={() => setActive(f.path)} title={f.path}>
                <span className="diff-file-status">{STATUS_LABEL[f.status]}</span>
                <span className="diff-file-path mono">{f.path}</span>
                <span className="diff-file-stat mono">
                  +{f.additions} −{f.deletions}
                </span>
              </button>
            ))}
          </div>
          <div className="diff-content">
            {current && (
              <>
                <div className="diff-file-head mono">{current.path}</div>
                <DiffView
                  text={current.diff}
                  onLineClick={(lineNo) => setCommentFor({ path: current.path, line: lineNo, text: '' })}
                />
                {[...comments.get(current.path)?.entries() ?? []].map(([line, text]) => (
                  <div key={line} className="diff-comment">
                    <span className="diff-comment-line mono">L{line}</span> {text}
                  </div>
                ))}
                {commentFor && commentFor.path === current.path && (
                  <div className="diff-comment-editor">
                    <span className="mono">L{commentFor.line} 评论</span>
                    <textarea
                      autoFocus
                      value={commentFor.text}
                      rows={2}
                      onChange={(e) => setCommentFor({ ...commentFor, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault()
                          addComment()
                        }
                        if (e.key === 'Escape') setCommentFor(null)
                      }}
                      placeholder="输入评论（Ctrl+Enter 收集，稍后批量发送）"
                    />
                    <div className="row">
                      <button className="btn btn-primary" onClick={addComment}>
                        收集
                      </button>
                      <button className="btn" onClick={() => setCommentFor(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
