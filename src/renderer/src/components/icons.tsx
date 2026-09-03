/** 内联 SVG 图标集（16 网格 / stroke 1.5 / currentColor）——替代 emoji，零依赖。
 *  用法：<IconSearch size={14} />；颜色随 color/stroke 继承。 */
import type { CSSProperties } from 'react'

interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
}

function base(size: number | undefined, style: CSSProperties | undefined): CSSProperties {
  return { width: size ?? 15, height: size ?? 15, flexShrink: 0, ...style }
}

const svgProps = (className?: string) => ({
  viewBox: '0 0 16 16',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className
})

export function IconFolder({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M2 3.5h4l1.5 2H14v7.5H2z" /></svg>
}

export function IconSearch({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
}

export function IconBranch({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><circle cx="4.5" cy="4" r="1.8" /><circle cx="4.5" cy="12" r="1.8" /><circle cx="11.5" cy="8" r="1.8" /><path d="M4.5 5.8v4.4M6.3 4.5H9a2 2 0 0 1 2 2v0" /></svg>
}

export function IconTerminal({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10H12" /></svg>
}

export function IconFile({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></svg>
}

export function IconClose({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M4 4l8 8M12 4l-8 8" /></svg>
}

export function IconMinus({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M3.5 8h9" /></svg>
}

export function IconPlus({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M8 3.5v9M3.5 8h9" /></svg>
}

export function IconPaperclip({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M11 5.5a3 3 0 0 0-5-2L4 5.5a3 3 0 0 0 4 4.5M5 10.5a3 3 0 0 0 5 2l2-2a3 3 0 0 0-4-4.5" /></svg>
}

export function IconGear({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" /></svg>
}

export function IconCopy({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></svg>
}

export function IconCheck({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M3 8.5l3.5 3.5L13 4.5" /></svg>
}

export function IconAlert({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M8 2.5L14.5 13h-13z" /><path d="M8 6.5v3M8 11.2v.3" /></svg>
}

export function IconSend({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M2.5 8h10M9 4.5L12.5 8 9 11.5" /></svg>
}

export function IconChevronDown({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M4 6l4 4 4-4" /></svg>
}

export function IconChevronRight({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M6 4l4 4-4 4" /></svg>
}

export function IconRefresh({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5V4.5h-2" /></svg>
}

export function IconPanelLeft({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6.5 3v10" /></svg>
}

export function IconMoon({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" /></svg>
}

export function IconSun({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" /></svg>
}

export function IconStop({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><rect x="4" y="4" width="8" height="8" rx="1" /></svg>
}

export function IconDownload({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M8 2.5v8M5 7.5l3 3 3-3M3 13.5h10" /></svg>
}

export function IconTrash({ size, className, style }: IconProps) {
  return <svg {...svgProps(className)} style={base(size, style)}><path d="M3 4.5h10M6.5 4.5V2.8h3v1.7M4.5 4.5l.6 9h5.8l.6-9" /></svg>
}
