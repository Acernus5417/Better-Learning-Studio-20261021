import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CourseProgressResult, FilesInjected } from './face.ts'
import type {} from './locales.ts'
import css from './FilesBody.module.css'

/** A compact view of the course's last durable checkpoint. */
export function CourseProgress({
  sessionId, root, readCourseProgress, t,
}: {
  readonly sessionId: SessionId
  readonly root: string
  readonly readCourseProgress: FilesInjected['readCourseProgress']
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const [progress, setProgress] = useState<CourseProgressResult>({ kind: 'waiting' })
  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const next = await readCourseProgress(sessionId, root, controller.signal)
        if (!controller.signal.aborted) setProgress(next)
      } catch {
        if (!controller.signal.aborted) setProgress({ kind: 'failed' })
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void refresh() }, 4000)
      }
    }
    void refresh()
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer) }
  }, [readCourseProgress, root, sessionId])

  if (progress.kind !== 'ready') {
    const message = progress.kind === 'waiting' ? 'courseProgress.waiting'
      : progress.kind === 'multiple' ? 'courseProgress.multiple' : 'courseProgress.readFailed'
    return <div className={css.courseProgress} data-course-progress={progress.kind}>{t(message)}</div>
  }
  const { stage, completedChapters, completedLessons, blockers, nextAction, completedStages, fontWarnings } = progress.value
  const stageKey = stage === 'intake' || stage === 'needs_update' || stage === 'needs_review'
    || stage === 'paused' || stage === 'working' || stage === 'complete'
    ? `courseProgress.${stage}` as const : 'courseProgress.other'
  return (
    <div className={css.courseProgress} data-course-progress={stage} aria-live="polite">
      <span className={css.courseProgressTitle}>{t(stageKey)}</span>
      {completedStages !== undefined && <span>{t('courseProgress.stages', { count: completedStages })}</span>}
      {completedChapters > 0 && <span>{t('courseProgress.chapters', { count: completedChapters })}</span>}
      {completedLessons > 0 && <span>{t('courseProgress.lessons', { count: completedLessons })}</span>}
      {blockers > 0 && <span className={css.courseProgressIssue}>{t('courseProgress.blockers', { count: blockers })}</span>}
      {fontWarnings !== undefined && fontWarnings > 0
        && <span className={css.courseProgressIssue}>{t('courseProgress.fontWarnings', { count: fontWarnings })}</span>}
      {nextAction && <span className={css.courseProgressNext} title={nextAction}>{nextAction}</span>}
    </div>
  )
}
