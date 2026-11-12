/** Folder import keeps its source intact and copies into the managed course library. */
import { useRef, useState } from 'react'
import { Modal, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CourseRecord } from '@deepseek-ai/dsh-util-course-document'
import { CourseRequestError } from './resources.ts'
import type { CourseInjected } from './Workbench.tsx'
import css from './workbench.module.css'

/**
 * Import one dropped folder after host validation, without another confirmation.
 * @param props - Localized copy, safe path bridge and course API.
 * @returns The drop-only dialog, reporting failures and blocking duplicate imports.
 */
export function CourseImportDialog({
  t,
  request,
  droppedPath,
  imported,
  close,
}: {
  readonly t: TranslateNS<'course'>
  readonly request: CourseInjected['request']
  readonly droppedPath: (file: File) => string
  readonly imported: (course: CourseRecord) => void
  readonly close: () => void
}) {
  const active = useRef(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const fail = (reason: unknown): void => {
    const code = reason instanceof CourseRequestError ? reason.code : undefined
    setError(
      code === 'IMPORT_MARKDOWN'
        ? t('importNoMarkdown')
        : code === 'IMPORT_CHANGED'
          ? t('importChanged')
          : code === 'IMPORT_LINK'
            ? t('importLinks')
            : code === 'IMPORT_LIMIT'
              ? t('importLimit')
              : t('importFailed'),
    )
  }
  const importFolder = async (source: string): Promise<void> => {
    if (active.current) return
    setError('')
    if (source === '') {
      setError(t('importDropUnavailable'))
      return
    }
    active.current = true
    setBusy(true)
    try {
      const course = await request<CourseRecord>({ action: 'import', source })
      imported(course)
    } catch (reason) {
      fail(reason)
    } finally {
      active.current = false
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={t('importCourse')}
      closeLabel={t('close')}
      className={css.importDialog ?? ''}
      contentClassName={css.importContent ?? ''}
      onClose={() => {
        if (!active.current) close()
      }}
    >
      <div
        className={css.importDrop}
        data-dragging={dragging || undefined}
        aria-busy={busy}
        onDragOver={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!active.current) setDragging(true)
        }}
        onDragLeave={() => {
          setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          if (active.current) return
          const file = event.dataTransfer.files.item(0)
          if (file === null || event.dataTransfer.files.length !== 1) {
            setError(t('importChooseOne'))
            return
          }
          try {
            void importFolder(droppedPath(file))
          } catch (reason) {
            fail(reason)
          }
        }}
      >
        <IconFolderCloseRegular size={32} />
        <strong role="status">{busy ? t('importWorking') : t('importDropTitle')}</strong>
      </div>
      {error !== '' && (
        <p className={css.notice} role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
