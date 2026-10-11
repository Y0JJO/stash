import { useEffect, useState } from 'react'
import type { LibraryInfo } from '../../../shared/types'
import { api } from '../api'

export function Welcome({ onOpened }: { onOpened(info: LibraryInfo): void }) {
  const [recent, setRecent] = useState<string[]>([])
  useEffect(() => {
    api.recentLibraries().then(setRecent)
  }, [])

  const done = (info: LibraryInfo | null) => {
    if (info) onOpened(info)
  }

  return (
    <div className="welcome">
      <div className="titlebar-drag" />
      <div className="welcome-card">
        <div className="logo">Stash</div>
        <p className="muted">Библиотека референсов, картинок и видео. Всё хранится локально в папке библиотеки.</p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => api.createLibrary().then(done)}>
            Создать библиотеку
          </button>
          <button onClick={() => api.openLibraryDialog().then(done)}>Открыть существующую</button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <div className="insp-label">Недавние</div>
            {recent.map((p) => (
              <button key={p} className="recent-row" onClick={() => api.openLibrary(p).then(done)}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
