import { createElement } from 'react'
import { iconNode } from '../../../shared/icons'

interface Props {
  name?: string
  size?: number
  className?: string
  /** Solid icon (e.g. rating stars). */
  filled?: boolean
  strokeWidth?: number
}

/** Lucide icon by name (see shared/icons.ts for Stash's aliases). Unknown names render an empty box. */
export function Icon({ name, size = 16, className, filled, strokeWidth = 1.75 }: Props) {
  const node = iconNode(name)
  if (!node) return <span className={`icon ${className ?? ''}`} style={{ width: size, height: size }} />
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {node.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  )
}

/**
 * Folder / sticker glyph: "i:<name>" is a Lucide icon, anything else is legacy emoji text.
 */
export function Glyph({ value, size = 15, className }: { value: string; size?: number; className?: string }) {
  if (value.startsWith('i:')) return <Icon name={value.slice(2)} size={size} className={className} />
  return (
    <span className={className} style={{ fontSize: size * 0.9, lineHeight: 1 }}>
      {value}
    </span>
  )
}
