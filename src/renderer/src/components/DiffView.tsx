/** 统一 diff 渲染（红/绿行，等宽）；ToolBlock 的 edit 结果与 DiffPane 共用 */
export function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return 'diff-ctx'
}

export function DiffView({ text, onLineClick }: { text: string; onLineClick?: (lineNo: number, line: string) => void }) {
  const lines = text.split('\n')
  return (
    <div className="tool-result sunken mono diff">
      {lines.map((l, i) => (
        <div
          key={i}
          className={diffLineClass(l)}
          onClick={onLineClick ? () => onLineClick(i + 1, l) : undefined}
          style={onLineClick ? { cursor: 'pointer' } : undefined}
        >
          {l.length > 0 ? l : ' '}
        </div>
      ))}
    </div>
  )
}
