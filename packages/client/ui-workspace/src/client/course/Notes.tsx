/** Single and multiple answer selection, editable preview, and lazy note writes. */
import { useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, Modal, Tooltip, Toast, IconEditOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { organizeCourseNotes, type CourseStudyReply } from '@deepseek-ai/dsh-util-course-document'
import type {
  PropsRuntime,
  PropsLocale,
  InjectFace,
  HostObservable,
  TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { CourseInjected } from './Workbench.tsx'
import css from './workbench.module.css'

/** Immutable document and tutor identity captured when the note picker opens. */
export interface CourseNoteTarget {
  readonly id: string
  readonly path: string
  readonly sessionId: string
}
/** Session entries read source identity through a root-owned, read-only observable. */
export interface CourseNotesInjected {
  readonly hooks: { readonly courseNoteTarget: HostObservable<CourseNoteTarget | undefined> }
  readonly request: CourseInjected['request']
  readonly refresh: () => void
  readonly saved: (path: string) => void
}
type NoteProps = PropsRuntime<'conversation.chat.assistant-actions'> &
  PropsLocale<'course'> &
  InjectFace<CourseNotesInjected>

/**
 * Render the note entry for the tutor bound to the current document.
 * @param props - Message identity, published replies and document selection.
 * @returns The note icon and its retained picker, or null outside the managed tutor.
 */
export function CourseNoteAction(props: NoteProps) {
  const target = props.useCourseNoteTarget(value => value)
  const replies = props.useProjection('courseStudyReplies')
  const [selection, setSelection] = useState<{
    target: CourseNoteTarget
    replies: readonly CourseStudyReply[]
    initial: string
  }>()
  if (target?.sessionId !== props.sessionId) return null
  return (
    <>
      <Tooltip label={props.t('takeNote')} side="bottom">
        <button
          type="button"
          className={css.noteAction}
          aria-label={props.t('takeNote')}
          disabled={!replies?.some(reply => reply.id === props.messageId)}
          onClick={() => {
            setSelection({ target, replies: replies ?? [], initial: props.messageId })
          }}
        >
          <IconEditOutlineRegular size={16} />
        </button>
      </Tooltip>
      {selection !== undefined && (
        <CourseNotePicker
          {...selection}
          t={props.t}
          request={props.request}
          close={() => {
            setSelection(undefined)
          }}
          saved={(path) => {
            props.refresh()
            props.saved(path)
            setSelection(undefined)
          }}
        />
      )}
    </>
  )
}

/**
 * Select one or more answers and review the Markdown before appending it.
 * @param props - Captured source document, final answers and save operations.
 * @returns The answer-selection and editable-preview dialog.
 */
export function CourseNotePicker({
  target,
  replies,
  initial,
  request,
  t,
  close,
  saved,
}: {
  readonly target: CourseNoteTarget
  readonly replies: readonly CourseStudyReply[]
  readonly initial: string
  readonly request: CourseInjected['request']
  readonly t: TranslateNS<'course'>
  readonly close: () => void
  readonly saved: (path: string) => void
}) {
  const [multiple, setMultiple] = useState(false)
  const [ids, setIds] = useState<readonly string[]>([initial])
  const [preview, setPreview] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [operationId, setOperationId] = useState(() => randomUUID())
  const name =
    target.path
      .split('/')
      .at(-1)
      ?.replace(/\.(?:md|markdown|txt)$/iu, '') ?? ''
  const choose = (id: string): void => {
    setIds(current =>
      multiple ? (current.includes(id) ? current.filter(value => value !== id) : [...current, id]) : [id],
    )
  }
  const save = (): void => {
    if (busy || preview === undefined || preview.trim() === '') return
    setBusy(true)
    setError('')
    void request<{ path: string }>({ action: 'append-note', ...target, messageIds: ids, text: preview, operationId })
      .then((result) => {
        saved(result.path)
      })
      .catch(() => {
        setError(t('noteFailed'))
      })
      .finally(() => {
        setBusy(false)
      })
  }
  return (
    <Modal
      open
      title={t('takeNote')}
      className={css.notesDialog ?? ''}
      closeLabel={t('cancel')}
      onClose={() => {
        if (!busy) close()
      }}
      footer={
        <div className={css.noteFooter}>
          <Button
            disabled={busy}
            onClick={
              preview === undefined
                ? close
                : () => {
                  setPreview(undefined)
                  setError('')
                }
            }
          >
            {preview === undefined ? t('cancel') : t('noteBack')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || ids.length === 0 || preview?.trim() === ''}
            onClick={
              preview === undefined
                ? () => {
                  setPreview(organizeCourseNotes(replies.filter(reply => ids.includes(reply.id))))
                  setOperationId(randomUUID())
                }
                : save
            }
          >
            {busy ? t('noteSaving') : preview === undefined ? t('noteOrganize') : t('noteSave')}
          </Button>
        </div>
      }
    >
      <div className={css.noteDestination}>{t('noteDestination', { name })}</div>
      {preview === undefined ? (
        <>
          <div className={css.noteModes} role="group" aria-label={t('noteSelectionMode')}>
            <Button
              aria-pressed={!multiple}
              onClick={() => {
                setMultiple(false)
                setIds(current => current.slice(0, 1))
              }}
            >
              {t('noteSingle')}
            </Button>
            <Button
              aria-pressed={multiple}
              onClick={() => {
                setMultiple(true)
              }}
            >
              {t('noteMultiple')}
            </Button>
          </div>
          <div className={css.noteAnswers} role="group" aria-label={t('noteAnswers')}>
            {replies.map((reply, index) => (
              <label key={reply.id} className={css.noteChoice} data-selected={ids.includes(reply.id)}>
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name="course-note-answer"
                  checked={ids.includes(reply.id)}
                  aria-label={`${t('noteAnswer')} ${index + 1}`}
                  onChange={() => {
                    choose(reply.id)
                  }}
                />
                <span>{reply.text}</span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <textarea
          className={css.notePreview}
          aria-label={t('notePreview')}
          value={preview}
          disabled={busy}
          onChange={(event) => {
            setPreview(event.target.value)
          }}
        />
      )}
      {error !== '' && (
        <p role="alert" className={css.notice}>
          {error}
        </p>
      )}
    </Modal>
  )
}

/** Root-owned toast survives a tutor panel closing or a course switch. */
export interface CourseNoteToastInjected {
  readonly hooks: { readonly courseNoteToast: HostObservable<{ readonly path: string; readonly seq: number } | null> }
  readonly dismiss: () => void
}
/**
 * Report a completed note write without moving the reading document.
 * @param props - Root-owned transient result and dismissal action.
 * @returns A toast showing the actual destination, or null.
 */
export function CourseNoteToast({
  useCourseNoteToast,
  dismiss,
  t,
}: InjectFace<CourseNoteToastInjected> & PropsLocale<'course'>) {
  const toast = useCourseNoteToast(value => value)
  return toast === null ? null : (
    <Toast key={toast.seq} text={t('noteSaved') + ' · ' + toast.path} tone="success" onDone={dismiss} />
  )
}
