/** Isolated graph engine lifetime bound to one course and reading navigation. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { CourseGraphData, CourseGraphLayout } from '@deepseek-ai/dsh-util-course-document'
import { isCourseGraphLayout } from './graph-layout.ts'
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { courseAddress } from './resources.ts'
import type { CourseGraphSettings } from './graph-settings.ts'
import css from './workbench.module.css'

/**
 * Render the supplied graph using the current course's admitted metadata.
 * @param props - Resource hook, preferences, theme revision and owner navigation.
 * @returns An isolated graph with localized loading, failure and empty states.
 */
export function CourseGraph(
  props: Pick<PropsRuntime<'rightbar.panel'>, 'useResource'> & {
    readonly id: string
    readonly path: string
    readonly settings: CourseGraphSettings
    readonly playing: boolean
    readonly animationRevision: number
    readonly stopped: () => void
    readonly open: (path: string) => void
    readonly t: TranslateNS<'course'>
    readonly themeRevision: number
    readonly refresh: () => void
    readonly saveLayout: (layout: CourseGraphLayout) => void
  },
) {
  const data = props.useResource<'coursework'>(courseAddress('graph', props.id))
  const mount = useRef<HTMLIFrameElement>(null),
    root = useRef<HTMLElement>(null)
  const [channel, setChannel] = useState(() => randomUUID()),
    [ready, setReady] = useState(false),
    [failed, setFailed] = useState(false)
  const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null)
  const latest = useRef(props)
  latest.current = props
  const paths = useRef(new Set<string>())
  const sent = useRef<{
    channel: string
    notes?: CourseGraphData['notes']
    graphRevision?: string | undefined
    theme: number
    revision: number
  }>({
    channel: '',
    theme: -1,
    revision: 0,
  })
  paths.current = new Set(data.value?.graph?.notes.map(note => note.path))
  useEffect(() => {
    const frame = mount.current
    const timeout = setTimeout(() => {
      setFailed(true)
    }, 15_000)
    const receive = (event: MessageEvent<unknown>): void => {
      if (!frame?.isConnected || event.source !== frame.contentWindow || event.origin !== location.origin) return
      const value = event.data
      if (
        value === null ||
        typeof value !== 'object' ||
        !('protocol' in value) ||
        value.protocol !== 'studio-course-graph-v1' ||
        !('channel' in value) ||
        value.channel !== channel ||
        !('type' in value)
      )
        return
      if (value.type === 'ready') {
        clearTimeout(timeout)
        setReady(true)
        setFailed(false)
      } else if (value.type === 'error') {
        setFailed(true)
        latest.current.stopped()
      } else if (value.type === 'stopped') latest.current.stopped()
      else if (value.type === 'layout' && 'layout' in value && isCourseGraphLayout(value.layout, paths.current))
        latest.current.saveLayout(value.layout)
      else if (
        value.type === 'open' &&
        'path' in value &&
        typeof value.path === 'string' &&
        paths.current.has(value.path)
      )
        latest.current.open(value.path)
      else if (
        value.type === 'stats' &&
        'nodes' in value &&
        typeof value.nodes === 'number' &&
        'edges' in value &&
        typeof value.edges === 'number'
      ) {
        const nodes = value.nodes,
          edges = value.edges
        setStats(previous => (previous?.nodes === nodes && previous.edges === edges ? previous : { nodes, edges }))
      }
    }
    window.addEventListener('message', receive)
    frame?.contentWindow?.postMessage(
      { protocol: 'studio-course-graph-v1', channel, type: 'hello' },
      location.origin === 'null' ? '*' : location.origin,
    )
    return () => {
      window.removeEventListener('message', receive)
      clearTimeout(timeout)
      frame?.contentWindow?.postMessage(
        { protocol: 'studio-course-graph-v1', channel, type: 'dispose' },
        location.origin === 'null' ? '*' : location.origin,
      )
    }
  }, [channel])
  useEffect(() => {
    const frame = mount.current,
      notes = data.value?.graph?.notes
    if (!ready || frame === null || root.current === null || notes === undefined) return
    const container = root.current,
      canvas = document.createElement('canvas'),
      context = canvas.getContext('2d')
    const color = (token: string): string => {
      const probe = document.createElement('span')
      probe.style.color = `var(${token})`
      container.appendChild(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      if (context === null) return value
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${(pixel[3] ?? 255) / 255})`
    }
    const graphRevision = data.value?.graphRevision
    const changedNotes =
      sent.current.channel !== channel ||
      (graphRevision === undefined ? sent.current.notes !== notes : sent.current.graphRevision !== graphRevision)
    const changedTheme = sent.current.channel !== channel || sent.current.theme !== props.themeRevision
    const colors = changedTheme
      ? {
        '--kgv-color-fill': color('--dsw-alias-label-secondary'),
        '--kgv-color-fill-focused': color('--dsw-alias-state-business-primary'),
        '--kgv-color-fill-tag': color('--dsw-alias-state-business-primary'),
        '--kgv-color-fill-unresolved': color('--dsw-alias-label-tertiary'),
        '--kgv-color-fill-attachment': color('--dsw-alias-state-success-primary'),
        '--kgv-color-fill-highlight': color('--dsw-alias-state-business-primary'),
        '--kgv-color-line': color('--dsw-alias-border-l2'),
        '--kgv-color-line-highlight': color('--dsw-alias-label-secondary'),
        '--kgv-color-circle': color('--dsw-alias-label-primary'),
        '--kgv-color-text': color('--dsw-alias-label-primary'),
        '--kgv-color-arrow': color('--dsw-alias-label-secondary'),
      }
      : undefined
    if (changedNotes) sent.current.revision++
    frame.contentWindow?.postMessage(
      {
        protocol: 'studio-course-graph-v1',
        channel,
        type: 'update',
        revision: sent.current.revision,
        ...(changedNotes ? { notes, layout: data.value?.graphLayout } : {}),
        settings: props.settings,
        currentPath: props.path,
        ...(changedTheme ? { background: color('--dsw-alias-bg-base'), colors } : {}),
        playing: props.playing,
        animationRevision: props.animationRevision,
      },
      location.origin === 'null' ? '*' : location.origin,
    )
    sent.current = { channel, notes, graphRevision, theme: props.themeRevision, revision: sent.current.revision }
  }, [
    channel,
    ready,
    data.value?.graph,
    data.value?.graphRevision,
    props.settings,
    props.path,
    props.playing,
    props.animationRevision,
    props.themeRevision,
  ])
  return (
    <section ref={root} className={css.graphPane} aria-label={props.t('graph')}>
      <iframe
        key={channel}
        ref={mount}
        className={css.graphFrame}
        title={props.t('graph')}
        src={`course-graph/index.html#${channel}`}
        onError={() => {
          setFailed(true)
        }}
      />
      {(failed || data.failure !== undefined) && (
        <div className={!failed && stats !== null && stats.nodes > 0 ? css.graphError : css.graphState} role="alert">
          <span>{props.t('graphLoadFailed')}</span>
          <button
            type="button"
            onClick={() => {
              setReady(false)
              setFailed(false)
              setStats(null)
              setChannel(randomUUID())
              props.refresh()
            }}
          >
            {props.t('refresh')}
          </button>
        </div>
      )}
      {!failed &&
        data.failure === undefined &&
        (!ready || stats === null || (stats.nodes === 0 && data.value?.graphPending)) && (
        <div className={css.graphState} role="status">
          {props.t('loading')}
        </div>
      )}
      {!failed && stats?.nodes === 0 && !data.value?.graphPending && (
        <div className={css.graphState} role="status">
          {props.t('graphEmpty')}
        </div>
      )}
      {stats !== null && stats.nodes > 0 && (
        <output className={css.graphCount} aria-live="polite">
          {stats.nodes} {props.t('graphNodes')} · {stats.edges} {props.t('graphEdges')}
        </output>
      )}
    </section>
  )
}
