/** Source-mapped reading and persistent CodeMirror editor instances. */
import { Fragment, createElement, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import {
  CodeBlock,
  IconChevronRightOutlineRegular,
  IconLightOutlineRegular,
  IconWarningTriangleOutlineRegular,
  IconCheckCircleOutlineRegular,
  IconQuestionOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  parseCourseDocument,
  resolveCourseLink,
  coursePlainText,
  presentationBlocks,
} from '@deepseek-ai/dsh-util-course-document'
import type {
  CourseFileContent,
  CourseNode,
  CourseFile,
  PresentationAnnotation,
} from '@deepseek-ai/dsh-util-course-document'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { courseAddress } from './resources.ts'
import css from './workbench.module.css'
import { courseReadingTree, type ReadingNode } from './reading-tree.ts'
import { CourseMath, CourseMathQueue } from './Math.tsx'
import { CourseChunk, courseReadingChunks } from './Chunks.tsx'

export interface SelectedCourseText {
  readonly path: string
  readonly version: string
  readonly start: number
  readonly end: number
}
type ReaderProps = Pick<PropsRuntime<'main'>, 'useResource'> & {
  readonly id: string
  readonly file: CourseFileContent
  readonly files: readonly CourseFile[]
  readonly t: TranslateNS<'course'>
  readonly open: (path: string, anchor?: string) => void
  readonly select: (range: SelectedCourseText | undefined) => void
  readonly trail?: readonly string[] | undefined
  readonly focus?: number | undefined
  readonly navigation?: number | undefined
}

function mappedPoint(container: Node, offset: number, end: boolean, root: HTMLElement): number | undefined {
  const element = container instanceof Element ? container : container.parentElement
  const leaf = element?.closest<HTMLElement>('[data-source-start]')
  if (leaf === null || leaf === undefined || !root.contains(leaf)) return
  const start = Number(leaf.dataset.sourceStart),
    finish = Number(leaf.dataset.sourceEnd)
  if (leaf.dataset.sourceExact !== 'true') return end ? finish : start
  const range = document.createRange()
  range.selectNodeContents(leaf)
  try {
    range.setEnd(container, offset)
  } catch {
    return end ? finish : start
  }
  return Math.min(finish, start + range.toString().length)
}
function selectedRange(root: HTMLElement, file: CourseFileContent): SelectedCourseText | undefined {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
  const closest = (node: Node): Element | null =>
    (node instanceof Element ? node : node.parentElement)?.closest('[data-course-document]') ?? null
  if (closest(range.startContainer) !== root || closest(range.endContainer) !== root) return
  const start = mappedPoint(range.startContainer, range.startOffset, false, root)
  const end = mappedPoint(range.endContainer, range.endOffset, true, root)
  return start === undefined || end === undefined || end <= start
    ? undefined
    : { path: file.path, version: file.version, start, end }
}
function Embed(props: ReaderProps & { readonly node: CourseNode }) {
  const { node, file, files, trail = [], id, t } = props
  const [target = '', anchor = ''] = (node.url ?? '').split('#', 2)
  const resolved = resolveCourseLink(
    file.path,
    target,
    files.filter(f => !f.directory).map(f => f.path),
  )
  const resource = props.useResource<'coursework'>(courseAddress('read', id, resolved.path ?? ''))
  if (resolved.path === undefined)
    return (
      <span className={css.notice}>
        {resolved.ambiguous.length > 0 ? t('ambiguous') : t('missing')} {node.url}
      </span>
    )
  const path = resolved.path
  if (trail.length >= 3 || trail.includes(path) || path === file.path)
    return <span className={css.notice}>{t('embedCycle')}</span>
  const url = `/api/better-learning/course-asset?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/iu.test(path))
    return <img className={css.image} src={url} alt={node.value ?? path} loading="lazy" />
  if (/\.pdf$/iu.test(path)) return <iframe className={css.pdf} src={url} title={path} />
  const embedded = resource.value?.file
  if (embedded === undefined) return <span className={css.notice}>{resource.failure?.message ?? t('loading')}</span>
  if (embedded.text.length > 250_000) return <span className={css.notice}>{t('embedCycle')}</span>
  let nodes = embedded.document.nodes
  if (anchor !== '') {
    const location = anchor.startsWith('^')
      ? embedded.document.blocks.find(b => b.id === anchor.slice(1))
      : embedded.document.headings.find(h => h.text === anchor)
    if (location !== undefined) {
      const next = anchor.startsWith('^')
        ? location.end
        : (embedded.document.headings.find(
          h => h.start > location.start && h.depth <= ('depth' in location ? location.depth : 6),
        )?.start ?? embedded.text.length)
      nodes = nodes.filter(n => n.start >= location.start && n.start < next)
    }
  }
  return (
    <section className={css.embed}>
      <button
        onClick={() => {
          props.open(path, anchor)
        }}
      >
        {t('jump')} · {path}
      </button>
      <CourseReader
        {...props}
        focus={undefined}
        file={{ ...embedded, document: { ...embedded.document, nodes } }}
        trail={[...trail, file.path]}
      />
    </section>
  )
}
function CourseCallout({
  title,
  initialOpen,
  children,
  mapping,
  kind,
  reveal,
}: {
  readonly title: string
  readonly initialOpen: boolean
  readonly children: ReactNode | (() => ReactNode)
  readonly mapping: Readonly<Record<string, number | boolean>>
  readonly kind: string
  readonly reveal?: number | undefined
}) {
  const [disclosure, setDisclosure] = useState({ open: initialOpen, reveal, immediate: reveal !== undefined })
  const revealing = reveal !== undefined && reveal !== disclosure.reveal
  if (revealing) setDisclosure({ open: true, reveal, immediate: true })
  const open = revealing || disclosure.open
  const [prepared, setPrepared] = useState(initialOpen)
  if (open && !prepared) setPrepared(true)
  const bodyId = useId()
  const tone = /^(?:tip|hint|success|check|done)$/u.test(kind)
    ? 'success'
    : /^(?:warning|caution|attention|question|help|faq)$/u.test(kind)
      ? 'warning'
      : /^(?:failure|fail|missing|danger|error|bug)$/u.test(kind)
        ? 'error'
        : /^(?:quote|cite)$/u.test(kind)
          ? 'quote'
          : kind === 'example'
            ? 'example'
            : 'info'
  const Icon = /^(?:tip|hint)$/u.test(kind)
    ? IconLightOutlineRegular
    : tone === 'success'
      ? IconCheckCircleOutlineRegular
      : /^(?:question|help|faq)$/u.test(kind)
        ? IconQuestionOutlineRegular
        : tone === 'warning' || tone === 'error'
          ? IconWarningTriangleOutlineRegular
          : undefined
  return (
    <section
      {...mapping}
      className={css.callout}
      data-callout={kind}
      data-tone={tone}
      data-callout-icon={Icon === undefined ? undefined : true}
      data-open={open || undefined}
      data-navigation-reveal={revealing || disclosure.immediate || undefined}
    >
      <button
        type="button"
        className={css.calloutToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          setDisclosure({ ...disclosure, open: !open, immediate: false })
        }}
      >
        <IconChevronRightOutlineRegular className={css.calloutChevron} size={16} />
        {Icon !== undefined && <Icon className={css.calloutTypeIcon} size={18} />}
        <span>{title}</span>
      </button>
      <div
        id={bodyId}
        className={css.calloutReveal}
        data-open={open || undefined}
        aria-hidden={!open}
        ref={(element) => {
          if (element !== null) element.inert = !open
        }}
      >
        <div className={css.calloutClip}>
          <div className={css.calloutBody}>
            {prepared ? (typeof children === 'function' ? children() : children) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
/** Rendering uses only React elements; HTML source and unsafe URLs stay inert. */
export function CourseReader(props: ReaderProps) {
  const latest = useRef(props)
  latest.current = props
  const open = useCallback((path: string, anchor?: string) => {
    latest.current.open(path, anchor)
  }, [])
  const select = useCallback((range: SelectedCourseText | undefined) => {
    latest.current.select(range)
  }, [])
  return (
    <CourseReaderContent
      id={props.id}
      file={props.file}
      files={props.files}
      t={props.t}
      useResource={props.useResource}
      focus={props.focus}
      navigation={props.navigation}
      trail={props.trail}
      open={open}
      select={select}
      copyLocale={props.t('copy')}
    />
  )
}
const CourseReaderContent = memo(function CourseReaderContent(props: ReaderProps & { readonly copyLocale: string }) {
  const { file, t } = props
  const root = useRef<HTMLElement>(null)
  const queue = useMemo(() => new CourseMathQueue(), [file.path, file.version])
  const paths = useMemo(() => props.files.filter(f => !f.directory).map(f => f.path), [props.files])
  const nodes = useMemo(
    () =>
      file.reading === undefined
        ? courseReadingTree(file.text, file.document.nodes, file.presentation)
        : file.document.nodes,
    [file.text, file.document.nodes, file.presentation, file.reading],
  )
  const chunks = useMemo(() => courseReadingChunks(nodes), [nodes])
  const progressive = file.text.length > 128_000 || nodes.length > 500
  const [prepared, setPrepared] = useState(progressive ? 2 : chunks.length)
  const complete = useCallback((): void => {
    flushSync(() => {
      setPrepared(chunks.length)
    })
  }, [chunks.length])
  useEffect(() => {
    if (prepared >= chunks.length) return
    const frame = requestAnimationFrame(() => {
      setPrepared(value => Math.min(value + 1, chunks.length))
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [prepared, chunks.length])
  useEffect(() => {
    queue.resume()
    const print = (): void => {
      complete()
      flushSync(() => {
        queue.flush()
      })
    }
    const find = (event: KeyboardEvent): void => {
      const editable =
        event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"]') !== null
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === 'f' || (event.key.toLowerCase() === 'a' && !editable))
      )
        complete()
    }
    window.addEventListener('beforeprint', print)
    window.addEventListener('keydown', find, true)
    return () => {
      window.removeEventListener('beforeprint', print)
      window.removeEventListener('keydown', find, true)
      queue.dispose()
    }
  }, [queue, complete])
  const annotations = useMemo(() => {
    if (file.reading !== undefined)
      return new Map(file.reading.annotations.map(item => [item.start, item.annotation]))
    if (!file.presentation?.annotations.length) return new Map<number | undefined, PresentationAnnotation>()
    const blocks = presentationBlocks(file.text)
    return new Map(
      file.presentation.annotations.map(item => [blocks.find(block => block.id === item.block)?.start, item]),
    )
  }, [file.text, file.presentation, file.reading])
  const embeds = useMemo(() => {
    const slots = new Map<string, number>()
    const walk = (node: ReadingNode): void => {
      if (node.embed) slots.set(`${node.start}:${node.end}`, slots.size)
      for (const child of node.children ?? []) walk(child)
    }
    for (const node of nodes) walk(node)
    return slots
  }, [nodes])
  const render = useCallback(
    (node: ReadingNode): ReactNode => {
      const children = () =>
        node.children?.map(child => (
          <Fragment key={`${child.start}:${child.end}:${child.type}`}>{render(child)}</Fragment>
        ))
      const mapping = {
        'data-source-start': node.start,
        'data-source-end': node.end,
        'data-source-exact': node.type === 'text' && node.value === file.text.slice(node.start, node.end),
        'data-block-start': node.start,
      }
      const text = node.value ?? ''
      const reveal =
        props.focus !== undefined && props.focus >= node.start && props.focus < node.end
          ? (props.navigation ?? props.focus)
          : undefined
      switch (node.type) {
        case 'learningSection':
          return (
            <section className={css.learningSection} data-learning-section={node.learningRole}>
              {children()}
            </section>
          )
        case 'details':
          return (
            <CourseCallout
              mapping={mapping}
              kind={node.cardDisclosure ? 'card' : 'details'}
              title={node.cardMetadata ? t('cardMetadata') : node.title || t('details')}
              initialOpen={
                node.initialOpen === true ||
                (props.focus !== undefined && props.focus >= node.start && props.focus < node.end)
              }
              reveal={reveal}
            >
              {children}
            </CourseCallout>
          )
        case 'yaml':
        case 'comment':
          return null
        case 'text': {
          const annotation = annotations.get(node.start)
          const at = annotation === undefined ? -1 : text.indexOf(annotation.quote)
          if (annotation === undefined || at < 0) return <span {...mapping}>{text}</span>
          const Tag = annotation.emphasis === 'highlight' ? 'mark' : 'strong'
          return (
            <span {...mapping}>
              {text.slice(0, at)}
              <Tag className={css.semanticEmphasis} data-role={annotation.role}>
                {annotation.quote}
              </Tag>
              {text.slice(at + annotation.quote.length)}
            </span>
          )
        }
        case 'html':
          return /^\s*<!--[\s\S]*-->\s*$/u.test(text) ? null : <code {...mapping}>{text}</code>
        case 'paragraph':
          if (
            node.children?.every(
              child =>
                child.type === 'comment' ||
                (child.type === 'text' && (child.value ?? '').trim() === '') ||
                (child.type === 'inlineCode' && /^\s*<!--\s*BLS?-[\s\S]*-->\s*$/u.test(child.value ?? '')) ||
                (child.type === 'html' && /^\s*<!--[\s\S]*-->\s*$/u.test(child.value ?? '')),
            )
          )
            return null
          return <p {...mapping}>{children()}</p>
        case 'heading':
          return createElement(`h${node.depth ?? 1}`, mapping, children())
        case 'strong':
          return <strong {...mapping}>{children()}</strong>
        case 'emphasis':
          return <em {...mapping}>{children()}</em>
        case 'delete':
          return <del {...mapping}>{children()}</del>
        case 'highlight': {
          const colors: Readonly<Record<string, string>> = {
            '🔴': 'red',
            '🟠': 'orange',
            '🟡': 'yellow',
            '🟢': 'green',
            '🔵': 'blue',
            '🟣': 'purple',
          }
          const prefix = Array.from(text)[0] ?? ''
          const color = colors[prefix]
          return (
            <mark {...mapping} data-highlight={color ?? 'yellow'}>
              {color === undefined ? text : text.slice(prefix.length)}
            </mark>
          )
        }
        case 'inlineCode':
          return /^\s*<!--\s*BLS?-[\s\S]*-->\s*$/u.test(text) ? null : <code {...mapping}>{text}</code>
        case 'break':
          return <br />
        case 'thematicBreak':
          return <hr />
        case 'list':
          return node.ordered ? <ol {...mapping}>{children()}</ol> : <ul {...mapping}>{children()}</ul>
        case 'listItem':
          return (
            <li {...mapping}>
              {node.checked === undefined || node.checked === null ? null : (
                <input type="checkbox" checked={node.checked} readOnly />
              )}
              {children()}
            </li>
          )
        case 'blockquote': {
          const title = /^\[!([^\]]+)\]([+-])?(.*)$/u.exec(
            coursePlainText(node.children?.[0] ?? node).split('\n')[0] ?? '',
          )
          if (title === null) return <blockquote {...mapping}>{children()}</blockquote>
          const first = node.children?.[0]
          const rest = node.children?.slice(1) ?? []
          const body: CourseNode[] = []
          let afterTitle = false
          for (const child of first?.children ?? []) {
            if (afterTitle) {
              body.push(child)
              continue
            }
            if (child.type !== 'text') continue
            const newline = child.value?.indexOf('\n') ?? -1
            if (newline < 0) continue
            afterTitle = true
            const rawStart = file.text.indexOf('\n', child.start) + 1
            const prefix = /^(?:[ \t]*>[ \t]?)+/u.exec(file.text.slice(rawStart))?.[0].length ?? 0
            const value = child.value?.slice(newline + 1) ?? ''
            if (value !== '') body.push({ ...child, start: rawStart + prefix, value })
          }
          return (
            <CourseCallout
              mapping={mapping}
              kind={(title[1] ?? 'note').toLowerCase()}
              initialOpen={
                title[2] !== '-' || (props.focus !== undefined && props.focus >= node.start && props.focus < node.end)
              }
              reveal={reveal}
              title={title[3]?.trim() || title[1] || ''}
            >
              {() => (
                <>
                  {body.length === 0 ? null : (
                    <p>
                      {body.map(child => (
                        <Fragment key={child.start}>{render(child)}</Fragment>
                      ))}
                    </p>
                  )}
                  {rest.map(child => (
                    <Fragment key={child.start}>{render(child)}</Fragment>
                  ))}
                </>
              )}
            </CourseCallout>
          )
        }
        case 'table':
          return (
            <div className={css.tableScroll}>
              <table
                {...mapping}
                data-columns={node.children?.[0]?.children?.length}
                data-wide={(node.children?.[0]?.children?.length ?? 0) > 4 || undefined}
              >
                <thead>
                  {node.children?.slice(0, 1).map(row => (
                    <tr key={row.start}>
                      {row.children?.map(cell => (
                        <th key={cell.start} scope="col" data-source-start={cell.start} data-source-end={cell.end}>
                          {cell.children?.map(child => (
                            <Fragment key={child.start}>{render(child)}</Fragment>
                          ))}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {node.children?.slice(1).map(row => (
                    <Fragment key={row.start}>{render(row)}</Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        case 'tableRow':
          return <tr {...mapping}>{children()}</tr>
        case 'tableCell':
          return <td {...mapping}>{children()}</td>
        case 'code':
          return (
            <div {...mapping}>
              <CodeBlock code={text} lang={node.lang ?? undefined} copyLabel={t('copy')} copiedLabel={t('copied')} />
            </div>
          )
        case 'math':
          return (
            <div {...mapping}>
              <CourseMath
                source={text}
                display
                start={node.start}
                end={node.end}
                queue={queue}
                force={props.focus !== undefined && node.start <= props.focus}
              />
            </div>
          )
        case 'inlineMath':
          return (
            <CourseMath
              source={text}
              display={false}
              start={node.start}
              end={node.end}
              queue={queue}
              force={props.focus !== undefined && node.start <= props.focus}
            />
          )
        case 'wiki':
        case 'link':
        case 'image': {
          if (node.embed) {
            const key = `${node.start}:${node.end}`
            const slot = embeds.get(key) ?? 20
            if (slot >= 20) return <span className={css.notice}>{t('embedCycle')}</span>
            return <Embed {...props} node={node} />
          }
          const url = node.url ?? ''
          if (/^(?:https?:|mailto:)/iu.test(url))
            return (
              <a {...mapping} href={url} target="_blank" rel="noopener noreferrer">
                {children() ?? (text || url)}
              </a>
            )
          if (/^(?:[a-z][\w+.-]*:|\/\/)/iu.test(url)) return <span {...mapping}>{children() ?? text}</span>
          const [target = '', anchor = ''] = url.split('#', 2)
          const resolved = resolveCourseLink(file.path, target, paths, node.type === 'wiki')
          if (node.type === 'image' && resolved.path !== undefined)
            return (
              <img
                {...mapping}
                className={css.image}
                alt={text}
                src={`/api/better-learning/course-asset?id=${encodeURIComponent(props.id)}&path=${encodeURIComponent(resolved.path)}`}
                loading="lazy"
              />
            )
          return (
            <button
              {...mapping}
              className={resolved.path === undefined ? css.unresolved : css.link}
              title={resolved.path ?? (resolved.ambiguous.length > 0 ? t('ambiguous') : t('missing'))}
              onClick={() => {
                if (resolved.path !== undefined) props.open(resolved.path, anchor)
              }}
            >
              {children() ?? (text || url)}
            </button>
          )
        }
        case 'footnoteReference':
          return <sup {...mapping}>{node.identifier}</sup>
        case 'footnoteDefinition':
          return (
            <aside {...mapping}>
              {node.identifier} {children()}
            </aside>
          )
        default:
          return <span {...mapping}>{children() ?? text}</span>
      }
    },
    [props, file, t, annotations, paths, queue, embeds],
  )
  return (
    <article
      ref={root}
      className={css.reader}
      data-course-document={file.path}
      onMouseDown={(event) => {
        if (prepared < chunks.length && event.target instanceof Element && !event.target.closest('button,a,input'))
          complete()
      }}
      onMouseUp={(event) => {
        event.stopPropagation()
        props.select(selectedRange(event.currentTarget, file))
      }}
      onKeyUp={(event) => {
        props.select(event.key === 'Escape' ? undefined : selectedRange(event.currentTarget, file))
      }}
    >
      {progressive
        ? chunks.map((chunk, index) => (
          <CourseChunk
            key={`${chunk.start}:${chunk.end}`}
            chunk={chunk}
            prepared={index < prepared}
            queue={queue}
            render={render}
          />
        ))
        : nodes.map(node => <Fragment key={`${node.start}:${node.end}:${node.type}`}>{render(node)}</Fragment>)}
    </article>
  )
})

type EditorProps = {
  readonly file: CourseFileContent
  readonly mode: 'read' | 'live' | 'source'
  readonly onChange: (text: string, start: number, end: number) => void
  readonly onSave: () => void
}
/** An EditorView lives for the document occurrence, including mode changes. */
export function CourseEditor({ file, mode, onChange, onSave }: EditorProps) {
  const mount = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onChange, onSave })
  callbacks.current = { onChange, onSave }
  useEffect(() => {
    if (mount.current === null) return
    const view = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: file.text,
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightActiveLine(),
          history(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                callbacks.current.onSave()
                return true
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged || update.selectionSet) {
              const range = update.state.selection.main
              callbacks.current.onChange(update.state.doc.toString(), range.from, range.to)
            }
          }),
          EditorView.theme({
            '&': { height: '100%', background: 'transparent', color: 'inherit' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--dsw-font-family-mono, monospace)' },
            '.cm-content': { padding: '24px' },
            '.cm-gutters': { background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', border: 'none' },
            '&.cm-focused': { outline: 'none' },
          }),
        ],
      }),
    })
    return () => {
      view.destroy()
    }
  }, [file.path])
  return <div ref={mount} className={css.editor} hidden={mode === 'read'} />
}

type DocumentProps = ReaderProps & {
  readonly mode: 'read' | 'live' | 'source'
  readonly save: (text: string, version: string) => Promise<CourseFileContent>
  readonly dirty: (value: boolean) => void
  readonly reload: () => void
}
/** A newer resource frame cannot replace an in-progress local draft. */
export function CourseDocumentView(props: DocumentProps) {
  const [base, setBase] = useState(props.file)
  // Metadata for the same immutable source can refresh without replacing an in-progress draft.
  if (
    props.file.version === base.version &&
    props.file.text === base.text &&
    (props.file.reading !== base.reading || props.file.presentation !== base.presentation)
  )
    setBase(props.file)
  const [text, setText] = useState(base.text)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const latestText = useRef(text)
  latestText.current = text
  const saving = useRef(false)
  const saveRef = useRef<() => void>(() => {})
  const changed = text !== base.text
  const live = useMemo(
    () =>
      props.mode === 'live' && changed
        ? { ...base, text, document: parseCourseDocument(text), reading: undefined }
        : base,
    [base, text, props.mode, changed],
  )
  const [editorLoaded, setEditorLoaded] = useState(props.mode !== 'read')
  if (props.mode !== 'read' && !editorLoaded) setEditorLoaded(true)
  const save = async (): Promise<void> => {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError('')
    try {
      const next = await props.save(latestText.current, base.version)
      setBase(next)
      props.dirty(latestText.current !== next.text)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  saveRef.current = () => {
    void save()
  }
  return (
    <section className={css.documentArea}>
      {props.mode !== 'read' && (
        <div className={css.saveBar}>
          <span>{changed ? props.t('dirty') : props.t('saved')}</span>
          <button
            disabled={busy || !changed}
            onClick={() => {
              void save()
            }}
          >
            {props.t('save')}
          </button>
        </div>
      )}
      {props.file.version !== base.version && (
        <div role="status" className={css.notice}>
          {props.t('changed')} <button onClick={props.reload}>{props.t('reload')}</button>
        </div>
      )}
      {error !== '' && (
        <div role="alert" className={css.notice}>
          {error}
        </div>
      )}
      <div className={props.mode === 'live' ? css.splitDocument : css.singleDocument}>
        {editorLoaded && (
          <CourseEditor
            file={base}
            mode={props.mode}
            onSave={() => {
              saveRef.current()
            }}
            onChange={(next, start, end) => {
              latestText.current = next
              setText(next)
              props.dirty(next !== base.text)
              props.select(
                next === base.text && end > start ? { path: base.path, version: base.version, start, end } : undefined,
              )
            }}
          />
        )}
        {props.mode !== 'source' && (
          <CourseReader
            {...props}
            file={props.mode === 'live' ? live : base}
            select={(range) => {
              props.select(changed ? undefined : range)
            }}
          />
        )}
      </div>
    </section>
  )
}
