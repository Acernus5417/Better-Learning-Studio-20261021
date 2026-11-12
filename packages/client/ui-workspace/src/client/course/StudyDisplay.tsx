import { useEffect, useState } from 'react'
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StudyDisplay } from '@deepseek-ai/dsh-util-course-document'
import css from './study-display.module.css'

/** Present stored media beside its answer, independently of tool-detail expansion. */
export function CourseStudyDisplay({ turn, useProjection, t }: PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'course'>) {
  const displays = useProjection('courseStudyDisplays')?.[String(turn.turn)]
  if (displays === undefined) return null
  return <div className={css.displays}>{displays.map((display, index) => <Display key={index} display={display} t={t} />)}</div>
}

export function Display({ display, t }: { display: StudyDisplay; t: TranslateNS<'course'> }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState<string>()
  const count = display.frames.length
  const current = display.frames[index]
  useEffect(() => {
    if (!playing || index >= count - 1) return
    const timer = window.setTimeout(() => setIndex(index + 1), display.intervalMs)
    const pause = () => { if (document.hidden) setPlaying(false) }
    document.addEventListener('visibilitychange', pause)
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', pause) }
  }, [count, display.intervalMs, index, playing])
  if (current === undefined) return null
  const label = current.label || display.title || t('displayMedia')
  const mediaUrl = `/api/better-learning/study-media?${new URLSearchParams({ id: display.courseId, asset: current.asset })}`
  const select = (next: number) => { setPlaying(false); setIndex(next) }
  const advancing = playing && index < count - 1
  return <figure className={css.display}>
    {display.title && <figcaption>{display.title}</figcaption>}
    {failed === current.asset
      ? <p role="status">{t('displayUnavailable')}</p>
      : <img key={current.asset} src={mediaUrl} alt={label} onError={() => setFailed(current.asset)} />}
    {current.label && current.label !== display.title && <p aria-live="polite">{current.label}</p>}
    {count > 1 && <div className={css.controls}>
      {display.controls === 'choices' && display.frames.map((frame, position) =>
        <button key={position} type="button" aria-pressed={position === index} onClick={() => select(position)}>
          {frame.label || `${t('displayFrame')} ${position + 1}`}
        </button>)}
      {display.controls === 'slider' && <label className={css.slider}>{t('displayFrame')}
          <input type="range" min={0} max={count - 1} value={index} aria-valuetext={current.label || `${index + 1} / ${count}`}
            onChange={event => select(event.currentTarget.valueAsNumber)} />
        </label>}
      {(display.controls === 'steps' || display.controls === 'playback') && <>
        <button type="button" className={css.stepButton} aria-label={t('displayPreviousStep')}
          title={t('displayPreviousStep')} disabled={index === 0} onClick={() => select(index - 1)}>
          <IconChevronLeftOutlineRegular size={16} />
        </button>
        <span className={css.stepProgress} aria-live={current.label ? undefined : 'polite'}>
          {t('displayStepProgress', { step: index + 1, total: count })}
        </span>
        <button type="button" className={css.stepButton} aria-label={t('displayNextStep')}
          title={t('displayNextStep')} disabled={index === count - 1} onClick={() => select(index + 1)}>
          <IconChevronRightOutlineRegular size={16} />
        </button>
      </>}
      {display.controls === 'playback' && <button type="button" onClick={() => {
        if (index === count - 1) setIndex(0)
        setPlaying(!advancing)
      }}>{t(advancing ? 'displayPause' : 'displayPlay')}</button>}
    </div>}
  </figure>
}
