// src/renderer/src/components/CodeBlock.tsx
/** Markdown 代码块：头部条（语言标签 + 悬停复制钮）+ 代码体。react-markdown 的自定义 pre 渲染器。 */
import { useRef, useState } from 'react'
import { IconCheck, IconCopy } from './icons'

/** 从 <code> 元素上抠出 language-xxx（rehype-highlight 产物）；无高亮时回落 text */
function langOf(children: React.ReactNode): string {
  const el = Array.isArray(children) ? children[0] : children
  if (!el || typeof el !== 'object' || !('props' in el)) return ''
  const cls = (el as React.ReactElement<{ className?: string }>).props.className ?? ''
  return /language-([\w-]+)/.exec(cls)?.[1] ?? ''
}

export function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const lang = langOf(children)

  const copy = (): void => {
    void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang mono">{lang || 'text'}</span>
        <button className="code-copy" onClick={copy} title="复制代码">
          {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}
