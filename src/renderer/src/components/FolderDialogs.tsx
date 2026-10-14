import { useState } from 'react'
import { Icon } from './Icon'
import type { Folder } from '../../../shared/types'
import { api } from '../api'
import { TagInput } from './TagInput'

/** "Set Auto-Tag": tags every file that lands in the folder gets. */
export function AutoTagDialog({ folder, allTags, onClose }: { folder: Folder; allTags: string[]; onClose(): void }) {
  const [tags, setTags] = useState<string[]>(folder.autoTags)
  const [applyNow, setApplyNow] = useState(true)
  const save = async () => {
    await api.updateFolder(folder.id, { autoTags: tags })
    if (applyNow && tags.length) await api.applyFolderAutoTags(folder.id)
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="insp-title">Автотег папки «{folder.name}»</div>
        <div className="muted dialog-note">Эти теги автоматически получат все файлы, которые попадут в папку.</div>
        <div className="insp-label">Теги</div>
        <TagInput tags={tags} suggestions={allTags} onAdd={(t) => setTags((x) => [...new Set([...x, t])])} onRemove={(t) => setTags((x) => x.filter((y) => y !== t))} />
        <label className="check-row" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={applyNow} onChange={(e) => setApplyNow(e.target.checked)} />
          Применить к файлам, которые уже лежат в папке
        </label>
        <div className="dialog-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="primary" onClick={save}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Folder password: set / change / remove, or unlock to view.
 * The lock hides the folder's view behind a password; files themselves are not encrypted.
 */
export function PasswordDialog({
  folder,
  mode,
  onClose,
  onUnlocked
}: {
  folder: Folder
  mode: 'set' | 'unlock' | 'remove'
  onClose(): void
  onUnlocked?(): void
}) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (mode === 'set') {
      if (pw.length < 1) return setError('Введите пароль')
      if (pw !== pw2) return setError('Пароли не совпадают')
      await api.setFolderPassword(folder.id, pw)
      onClose()
    } else {
      if (!(await api.checkFolderPassword(folder.id, pw))) return setError('Неверный пароль')
      if (mode === 'remove') await api.setFolderPassword(folder.id, null)
      onUnlocked?.()
      onClose()
    }
  }

  const title = mode === 'set' ? (folder.locked ? 'Сменить пароль' : 'Пароль на папку') : mode === 'remove' ? 'Снять пароль' : 'Папка защищена паролем'
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="dialog" style={{ width: 360 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="insp-title dialog-title">
          <Icon name="lock" size={17} />
          {title}
        </div>
        <div className="muted dialog-note">«{folder.name}»</div>
        <input
          type="password"
          autoFocus
          placeholder={mode === 'set' && folder.locked ? 'Новый пароль' : 'Пароль'}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{ marginTop: 10 }}
        />
        {mode === 'set' && (
          <input type="password" placeholder="Повторите пароль" value={pw2} onChange={(e) => setPw2(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        )}
        {mode === 'set' && <div className="muted dialog-note">Пароль закрывает просмотр папки в D3S3RT. Сами файлы на диске не шифруются.</div>}
        {error && <div className="warn dialog-note">{error}</div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="primary" onClick={submit}>
            {mode === 'unlock' ? 'Открыть' : mode === 'remove' ? 'Снять пароль' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
