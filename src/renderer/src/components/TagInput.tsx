import { useMemo, useState } from 'react'
import { Icon } from './Icon'

interface Props {
  tags: string[]
  /** Tags set by the auto-tagger; shown differently, clicking one confirms it. */
  autoTags?: string[]
  suggestions: string[]
  onAdd(tag: string): void
  onRemove?(tag: string): void
  placeholder?: string
}

export function TagInput({ tags, autoTags = [], suggestions, onAdd, onRemove, placeholder = 'Добавить тег…' }: Props) {
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase()
    const have = new Set(tags.map((t) => t.toLowerCase()))
    if (!q) return []
    return suggestions.filter((s) => !have.has(s.toLowerCase()) && s.toLowerCase().includes(q)).slice(0, 8)
  }, [text, tags, suggestions])

  const commit = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (v) onAdd(v)
    setText('')
    setActive(0)
  }

  return (
    <div className="tag-input">
      <div className="tag-chips">
        {tags.map((t) => {
          const auto = autoTags.includes(t)
          return (
          <span
            key={t}
            className={`chip${auto ? ' auto' : ''}`}
            title={auto ? 'Автотег — нажмите, чтобы подтвердить' : undefined}
            onClick={auto ? () => onAdd(t) : undefined}
          >
            {auto && <Icon name="sparkle" size={11} className="chip-spark" />}
            {t}
            {onRemove && (
              <button
                className="chip-x"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(t)
                }}
                title="Убрать тег"
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </span>
          )
        })}
        <input
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit(matches[active] ?? text)
            } else if (e.key === 'Tab' && matches.length) {
              e.preventDefault()
              commit(matches[active])
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, matches.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Backspace' && !text && tags.length && onRemove) {
              onRemove(tags[tags.length - 1])
            } else if (e.key === 'Escape') {
              setText('')
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </div>
      {focused && matches.length > 0 && (
        <div className="tag-suggest">
          {matches.map((m, i) => (
            <div key={m} className={i === active ? 'active' : ''} onMouseDown={() => commit(m)}>
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
