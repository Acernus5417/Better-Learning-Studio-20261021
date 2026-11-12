/** Source-mapped learning actions anchored beside a saved-document selection. */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  MenuSurface,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
  IconSparkleRegular,
  IconQuestionOutlineRegular,
  IconThinkOutlineRegular,
  IconLightOutlineRegular,
  IconFlatListOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActiveCourseStudyAction } from '@deepseek-ai/dsh-util-course-document'
import type { SelectedCourseText } from './DocumentView.tsx'
import css from './workbench.module.css'

/** A selection and its immutable navigation owner, captured in one pointer event. */
export interface CourseSelection {
  readonly range: SelectedCourseText
  readonly owner: string
  readonly revision: number
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}
/** Floating actions use shared menu material and viewport placement. */
export function SelectionActions({
  selection,
  t,
  busy,
  dismiss,
  run,
}: {
  readonly selection: CourseSelection
  readonly t: TranslateNS<'course'>
  readonly busy: boolean
  readonly dismiss: () => void
  readonly run: (action: ActiveCourseStudyAction) => void
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open: true,
    anchorRef: anchor,
    panelRef: surface,
    side: 'top',
    gap: 6,
    margin: 12,
  })
  useDismissOnOutsidePointer(
    anchor,
    true,
    () => {
      dismiss()
    },
    surface,
  )
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [dismiss])
  return createPortal(
    <>
      <span
        ref={anchor}
        aria-hidden="true"
        className={css.selectionAnchor}
        style={{
          left: selection.rect.x,
          top: selection.rect.y,
          width: selection.rect.width,
          height: selection.rect.height,
        }}
      />
      <MenuSurface
        ref={surface}
        compact
        className={css.selectionToolbar}
        role="toolbar"
        aria-label={t('selectionActions')}
        style={position ?? { visibility: 'hidden' }}
        onMouseDown={(event) => {
          event.preventDefault()
        }}
      >
        <button type="button" disabled={busy} onClick={() => { run('explain') }}>
          <IconSparkleRegular size={15} />
          {t('explain')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run('example')
          }}
        >
          <IconLightOutlineRegular size={15} />
          {t('example')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run('summarize')
          }}
        >
          <IconFlatListOutlineRegular size={15} />
          {t('summarize')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run('quiz')
          }}
        >
          <IconQuestionOutlineRegular size={15} />
          {t('quiz')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            run('discuss')
          }}
        >
          <IconThinkOutlineRegular size={15} />
          {t('discuss')}
        </button>
      </MenuSurface>
    </>,
    document.body,
  )
}
