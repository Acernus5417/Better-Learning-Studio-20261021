/** Course graph controls reuse Studio menu material, switches and viewport positioning. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  MenuSurface,
  Switch,
  useAnchoredPosition,
  IconRefreshOutlineRegular,
  IconCloseOutlineRegular,
  IconChevronRightOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CourseGraphSettings } from './graph-settings.ts'
import { defaultCourseGraphSettings } from './graph-settings.ts'
import css from './workbench.module.css'

interface GraphSettingsProps {
  readonly open: boolean
  readonly settings: CourseGraphSettings
  readonly change: (value: CourseGraphSettings) => void
  readonly close: () => void
  readonly anchor: RefObject<HTMLButtonElement | null>
  readonly t: TranslateNS<'course'>
  readonly playing: boolean
  readonly play: () => void
  readonly failed: boolean
}
// Matches Studio's fast overlay fade; reduced-motion dismissal is immediate.
const PANEL_FADE_MS = 100
/**
 * Retain the portaled graph settings during its short dismissal transition.
 * @param props - Controlled visibility, course preferences and localized owner actions.
 * @returns The settings card while open or fading out.
 */
export function CourseGraphSettingsPanel(props: GraphSettingsProps) {
  const [retained, setRetained] = useState(props.open)
  useLayoutEffect(() => {
    if (props.open) {
      setRetained(true)
      return
    }
    if (!retained) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetained(false)
      return
    }
    const timer = setTimeout(() => {
      setRetained(false)
    }, PANEL_FADE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [props.open, retained])
  return props.open || retained ? <GraphSettingsCard {...props} closing={!props.open} /> : null
}
/** An inert closed body preserves its height transition without exposing hidden controls. */
function GraphSettingsBody({
  id,
  open,
  children,
}: {
  readonly id: string
  readonly open: boolean
  readonly children: ReactNode
}) {
  return (
    <div id={id} className={css.graphSettingsReveal} data-open={open || undefined} aria-hidden={!open}
      ref={(element) => { if (element !== null) element.inert = !open }}>
      <div className={css.graphSettingsClip}>{children}</div>
    </div>
  )
}
/** Fixed toolbar anchoring remains independent of disclosure and entry animations. */
function GraphSettingsCard({
  settings,
  change,
  close,
  anchor,
  t,
  playing,
  play,
  failed,
  closing,
}: GraphSettingsProps & { readonly closing: boolean }) {
  const latest = useRef(close)
  latest.current = close
  const panel = useRef<HTMLDivElement>(null)
  const sectionId = useId()
  const [sections, setSections] = useState<Record<string, boolean>>({
    filters: false,
    groups: false,
    appearance: false,
    forces: false,
    local: false,
  })
  useLayoutEffect(() => {
    if (panel.current !== null) panel.current.inert = closing
    if (!closing) setSections({ filters: false, groups: false, appearance: false, forces: false, local: false })
  }, [closing])
  const [bounds, setBounds] = useState<{ top: number; maxHeight: number } | null>(null)
  const position = useAnchoredPosition({
    open: true,
    anchorRef: anchor,
    panelRef: panel,
    side: 'bottom',
    align: 'end',
    gap: 6,
    margin: 12,
  })
  useLayoutEffect(() => {
    // This settings card must grow below its trigger, keeping the fixed tools reachable.
    const fit = (): void => {
      const rect = anchor.current?.getBoundingClientRect()
      if (rect === undefined) return
      const top = rect.bottom + 6
      setBounds({ top, maxHeight: Math.min(760, Math.max(0, window.innerHeight - top - 12)) })
    }
    fit()
    window.addEventListener('resize', fit)
    window.addEventListener('scroll', fit, true)
    return () => {
      window.removeEventListener('resize', fit)
      window.removeEventListener('scroll', fit, true)
    }
  }, [anchor])
  useEffect(() => {
    if (closing) return
    const pointer = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !anchor.current?.contains(event.target)
      )
        latest.current()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        latest.current()
        anchor.current?.focus()
      }
    }
    const blur = (): void => {
      if (document.activeElement instanceof HTMLIFrameElement) latest.current()
    }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('blur', blur)
    panel.current?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', blur)
    }
  }, [anchor, closing])
  const patch = (value: Partial<CourseGraphSettings>): void => {
    change({ ...settings, ...value })
  }
  const toggle = (
    key:
      | 'showTags'
      | 'showAttachments'
      | 'hideUnresolved'
      | 'showOrphans'
      | 'showArrow'
      | 'local'
      | 'localForelinks'
      | 'localBacklinks'
      | 'localInterlinks',
    label: Parameters<typeof t>[0],
  ) => (
    <div className={css.graphSettingRow}>
      <span>{t(label)}</span>
      <Switch
        checked={settings[key]}
        label={t(label)}
        onChange={(value) => {
          patch({ [key]: value })
        }}
      />
    </div>
  )
  const range = (
    key:
      | 'textFadeMultiplier'
      | 'nodeSizeMultiplier'
      | 'lineSizeMultiplier'
      | 'centerStrength'
      | 'repelStrength'
      | 'linkStrength'
      | 'linkDistance'
      | 'localJumps',
    label: Parameters<typeof t>[0],
    min: number,
    max: number,
    step: number,
  ) => (
    <label className={css.graphRange}>
      <span>{t(label)}</span>
      <span>
        <output>{settings[key].toFixed(step >= 1 ? 0 : 2)}</output>
        <input
          aria-label={t(label)}
          type="range"
          min={min}
          max={max}
          step={step}
          value={settings[key]}
          style={{
            background: `linear-gradient(to right, var(--dsw-alias-state-business-primary) ${((settings[key] - min) / (max - min)) * 100}%, var(--dsw-alias-border-l2) ${((settings[key] - min) / (max - min)) * 100}%)`,
          }}
          onChange={(event) => {
            patch({ [key]: Number(event.target.value) })
          }}
        />
      </span>
    </label>
  )
  const heading = (id: string, label: Parameters<typeof t>[0]) => (
    <button
      className={css.graphSettingHeading}
      type="button"
      aria-controls={`${sectionId}-${id}`}
      aria-expanded={sections[id] === true}
      onClick={() => {
        setSections({ ...sections, [id]: !sections[id] })
      }}
    >
      <IconChevronRightOutlineRegular size={14} />
      {t(label)}
    </button>
  )
  return createPortal(
    <MenuSurface
      ref={panel}
      className={css.graphSettings}
      role="dialog"
      data-closing={closing || undefined}
      aria-hidden={closing}
      aria-label={t('graphSettings')}
      tabIndex={-1}
      style={{ ...position, ...bounds, visibility: position === null || bounds === null ? 'hidden' : 'visible' }}
    >
      <header className={css.graphSettingsHeader}>
        <span>{t('graphSettings')}</span>
        <div>
          <button
            type="button"
            aria-label={t('graphReset')}
            onClick={() => {
              change(defaultCourseGraphSettings)
            }}
          >
            <IconRefreshOutlineRegular size={16} />
          </button>
          <button type="button" aria-label={t('close')} onClick={close}>
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>
      </header>
      <div className={css.graphSettingsScroll}>
        <section>
          {heading('filters', 'graphFilters')}
          <GraphSettingsBody id={`${sectionId}-filters`} open={sections.filters === true}>
            <div className={css.graphSettingsSection}>
              <input
                className={css.graphSearch}
                type="search"
                aria-label={t('graphSearch')}
                placeholder={t('graphSearch')}
                maxLength={500}
                value={settings.search}
                onChange={(event) => {
                  patch({ search: event.target.value })
                }}
              />
              {toggle('showTags', 'graphTags')}
              {toggle('showAttachments', 'graphAttachments')}
              {toggle('hideUnresolved', 'graphExistingOnly')}
              {toggle('showOrphans', 'graphOrphans')}
            </div>
          </GraphSettingsBody>
        </section>
        <section>
          {heading('groups', 'graphGroups')}
          <GraphSettingsBody id={`${sectionId}-groups`} open={sections.groups === true}>
            <div className={css.graphSettingsSection}>
              {settings.groups.map(group => (
                <div key={group.id} className={css.graphGroupRow}>
                  <input
                    aria-label={t('graphGroupQuery')}
                    maxLength={500}
                    value={group.query}
                    onChange={(event) => {
                      patch({
                        groups: settings.groups.map(item =>
                          item.id === group.id ? { ...item, query: event.target.value } : item,
                        ),
                      })
                    }}
                  />
                  <input
                    type="color"
                    aria-label={t('graphGroupColor')}
                    value={group.color}
                    onChange={(event) => {
                      patch({
                        groups: settings.groups.map(item =>
                          item.id === group.id ? { ...item, color: event.target.value } : item,
                        ),
                      })
                    }}
                  />
                  <button
                    type="button"
                    aria-label={t('graphRemoveGroup')}
                    onClick={() => {
                      patch({ groups: settings.groups.filter(item => item.id !== group.id) })
                    }}
                  >
                    <IconCloseOutlineRegular size={14} />
                  </button>
                </div>
              ))}
              <button
                className={css.graphFullButton}
                type="button"
                disabled={settings.groups.length >= 24}
                onClick={() => {
                  patch({ groups: [...settings.groups, { id: randomUUID(), query: '', color: '#8b72dc' }] })
                }}
              >
                {t('graphAddGroup')}
              </button>
            </div>
          </GraphSettingsBody>
        </section>
        <section>
          {heading('appearance', 'graphAppearance')}
          <GraphSettingsBody id={`${sectionId}-appearance`} open={sections.appearance === true}>
            <div className={css.graphSettingsSection}>
              {toggle('showArrow', 'graphArrows')}
              {range('textFadeMultiplier', 'graphTextFade', 0, 3, 0.01)}
              {range('nodeSizeMultiplier', 'graphNodeSize', 0.1, 5, 0.1)}
              {range('lineSizeMultiplier', 'graphLineSize', 0.1, 5, 0.1)}
              <label className={css.graphSettingRow}>
                {t('graphHighlightColor')}
                <input
                  type="color"
                  aria-label={t('graphHighlightColor')}
                  value={settings.highlightColor || '#8b72dc'}
                  onChange={(event) => {
                    patch({ highlightColor: event.target.value })
                  }}
                />
              </label>
              <button className={css.graphFullButton} type="button" onClick={play}>
                {t(playing ? 'graphStopAnimation' : 'graphPlayAnimation')}
              </button>
            </div>
          </GraphSettingsBody>
        </section>
        <section>
          {heading('forces', 'graphForces')}
          <GraphSettingsBody id={`${sectionId}-forces`} open={sections.forces === true}>
            <div className={css.graphSettingsSection}>
              {range('centerStrength', 'graphCenter', 0, 1, 0.01)}
              {range('repelStrength', 'graphRepel', 0, 20, 0.1)}
              {range('linkStrength', 'graphAttraction', 0, 1, 0.01)}
              {range('linkDistance', 'graphDistance', 30, 500, 1)}
            </div>
          </GraphSettingsBody>
        </section>
        <section>
          {heading('local', 'graphLocal')}
          <GraphSettingsBody id={`${sectionId}-local`} open={sections.local === true}>
            <div className={css.graphSettingsSection}>
              {toggle('local', 'graphCurrentFile')}
              {range('localJumps', 'graphJumps', 1, 4, 1)}
              {toggle('localForelinks', 'graphForelinks')}
              {toggle('localBacklinks', 'graphBacklinks')}
              {toggle('localInterlinks', 'graphInterlinks')}
            </div>
          </GraphSettingsBody>
        </section>
        {failed && (
          <p role="alert" className={css.notice}>
            {t('graphSettingsFailed')}
          </p>
        )}
      </div>
    </MenuSurface>,
    document.body,
  )
}
