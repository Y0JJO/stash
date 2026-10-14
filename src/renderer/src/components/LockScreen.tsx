import { useState } from 'react'
import { api } from '../api'
import { Icon } from './Icon'

/** Shown instead of the app while it is locked with a password. */
export function LockScreen({ onUnlock }: { onUnlock(): void }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState(false)

  const submit = async () => {
    if (await api.checkLock(pw)) onUnlock()
    else {
      setError(true)
      setPw('')
    }
  }

  return (
    <div className="lock-screen">
      <div className="titlebar-drag" />
      <div className="lock-card">
        <div className="lock-icon">
          <Icon name="lock" size={26} />
        </div>
        <div className="insp-title">D3S3RT заблокирован</div>
        <input
          type="password"
          autoFocus
          placeholder="Пароль"
          value={pw}
          className={error ? 'shake' : ''}
          onChange={(e) => {
            setPw(e.target.value)
            setError(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="warn">Неверный пароль</div>}
        <button className="primary" onClick={submit}>
          Открыть
        </button>
      </div>
    </div>
  )
}
