import { useEffect, useState } from 'react'
import type { AiStatus } from '../../../shared/types'
import { api } from '../api'

/** Sidebar footer: auto-tagging on/off switch plus model / queue progress. */
export function AiStatusBar() {
  const [status, setStatus] = useState<AiStatus>({ phase: 'idle' })
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    api.aiStatus().then(setStatus)
    api.aiEnabled().then(setEnabled)
    return api.onAiStatus(setStatus)
  }, [])

  let text = 'Автотеги'
  let pct: number | null = null
  if (enabled) {
    if (status.phase === 'loading') {
      pct = status.progress ?? 0
      text = pct > 0 && pct < 1 ? `Загрузка модели… ${Math.round(pct * 100)}%` : 'Запуск модели…'
    } else if (status.phase === 'working') {
      text = `Теги: ${status.done ?? 0} / ${status.total ?? 0}`
      pct = status.total ? (status.done ?? 0) / status.total : 0
    } else if (status.phase === 'error') text = 'Автотеги: ошибка'
  }

  return (
    <div className="ai-bar" title={status.phase === 'error' ? status.message : 'Автоматические теги через локальную модель CLIP'}>
      <div className="ai-row">
        <span className={`ai-dot ${enabled ? status.phase : 'off'}`} />
        <span className="ai-text">{text}</span>
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked)
              api.setAiEnabled(e.target.checked)
            }}
          />
          <span />
        </label>
      </div>
      {pct !== null && (
        <div className="progress-bar">
          <div style={{ width: `${pct * 100}%` }} />
        </div>
      )}
    </div>
  )
}
