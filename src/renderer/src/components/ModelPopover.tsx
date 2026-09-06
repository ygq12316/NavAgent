import { useEffect, useState } from 'react'
import { getApi } from '../api'
import { IconCheck } from './icons'

interface Props {
  model: string
  /** 全局默认模型（常驻列表，标注「默认」——会话切走后仍可切回，对齐 Claude Code 的 Default 选项） */
  defaultModel?: string
  onPick: (id: string) => void
}

/** 模型切换悬浮窗：紧凑索引列表（行尾序号、当前行打勾、悬停看全名）。
 * 数据源 = 渲染层本地目录快照（models.json 各供应商模型 + 默认模型 + 当前模型），纯本地即时渲染，不依赖网络与主进程探测。 */
export function ModelPopover({ model, defaultModel, onPick }: Props) {
  const [ids, setIds] = useState<string[] | null>(null)

  useEffect(() => {
    // 基线先行：默认模型 + 当前模型立即可见（弹窗永不空白）；目录快照到达后再合并出完整列表
    setIds([...new Set([...(defaultModel ? [defaultModel] : []), ...(model ? [model] : [])])].filter(Boolean))
    let alive = true
    getApi()
      .listCatalog()
      .then((snap) => {
        if (!alive) return
        setIds(
          [...new Set([...snap.models.map((m) => m.model), ...(defaultModel ? [defaultModel] : []), ...(model ? [model] : [])])].filter(Boolean)
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [model, defaultModel])

  return (
    <div className="model-pop">
      <div className="mp-title">Models</div>
      <div className="mp-list">
        {(ids ?? []).map((id, i) => {
          const on = id === model
          return (
            <button key={id} className={`mp-row${on ? ' on' : ''}`} title={id} onClick={() => onPick(id)}>
              <span className="mp-id">{id}</span>
              {id === defaultModel && id !== model && <span className="mp-def">默认</span>}
              <span className="mp-num">{on ? <IconCheck size={12} /> : i + 1}</span>
            </button>
          )
        })}
        {ids !== null && ids.length === 0 && <div className="mp-err">无可用模型</div>}
      </div>
    </div>
  )
}
