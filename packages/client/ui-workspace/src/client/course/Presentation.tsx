/** Persistent Studio Markdown presentation, shared by reading and both chats. */
import { useState } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './workbench.module.css'

const KEY = 'better-learning.markdown-styling'
/**
 * Create a display preference whose successful writes persist before publication.
 * @returns The accepted local preference and its explicit writer.
 */
export function createStudioMarkdownPreference() {
  const load = (): boolean => localStorage.getItem(KEY) !== 'false'
  const source = createSnapshotStore(load())
  return {
    source,
    set: (value: boolean): void => {
      localStorage.setItem(KEY, String(value))
      source.set(value)
    },
  }
}
/** Settings receive only the shared accepted fact and the write action. */
export interface MarkdownPreferenceInjected {
  readonly hooks: { readonly markdownBeauty: HostObservable<boolean> }
  readonly setEnabled: (value: boolean) => void
}
/**
 * Render the General Settings toggle without duplicating Markdown parsing.
 * @param props - Accepted styling preference, writer and localized label.
 * @returns A persisted on/off switch with a recoverable save error.
 */
export function MarkdownPreference({
  useMarkdownBeauty,
  setEnabled,
  t,
}: InjectFace<MarkdownPreferenceInjected> & PropsLocale<'course'>) {
  const enabled = useMarkdownBeauty(value => value)
  const [failed, setFailed] = useState(false)
  return (
    <div className={css.markdownSetting}>
      <div>
        <span>{t('markdownBeauty')}</span>
        {failed && <p role="alert">{t('markdownBeautyError')}</p>}
      </div>
      <Switch
        checked={enabled}
        label={t('markdownBeauty')}
        onChange={(value) => {
          setFailed(false)
          try {
            setEnabled(value)
          } catch {
            setFailed(true)
          }
        }}
      />
    </div>
  )
}
