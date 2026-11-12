/** Browser-safe Markdown semantics shared by the course reader and Host index. */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { frontmatter } from 'micromark-extension-frontmatter'
import { decodeString } from 'micromark-util-decode-string'
import { parseDocument } from 'yaml'
import type { RootContent, Root } from 'mdast'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identity minted by the course library, never interpreted as a path. */
export type CourseId = Branded<'CourseId'>
/** Stable immutable source reference identity. */
export type CourseQuoteId = Branded<'CourseQuoteId'>
/** UTF-16 source offsets match JavaScript strings and CodeMirror transactions. */
export interface SourceRange {
  readonly start: number
  readonly end: number
}
/** Portable rendering tree. Raw HTML stays inert. */
export interface CourseNode extends SourceRange {
  readonly type: string
  readonly value?: string
  readonly children?: readonly CourseNode[]
  readonly depth?: number
  readonly url?: string
  readonly title?: string | null | undefined
  readonly lang?: string | null | undefined
  readonly checked?: boolean | null | undefined
  readonly ordered?: boolean | null | undefined
  readonly identifier?: string
  readonly embed?: boolean
}
/** One semantic link and the exact source target to rewrite on rename. */
export interface CourseLink extends SourceRange {
  readonly target: string
  readonly anchor: string
  readonly embed: boolean
  readonly wiki: boolean
}
/** One indexed document; the original source always remains the truth. */
export interface CourseDocument {
  readonly nodes: readonly CourseNode[]
  readonly links: readonly CourseLink[]
  readonly headings: readonly (SourceRange & { readonly text: string; readonly depth: number })[]
  readonly blocks: readonly (SourceRange & { readonly id: string })[]
  readonly tags: readonly string[]
  readonly properties: Readonly<Record<string, unknown>>
  readonly propertyError?: string
}
/** Durable managed-course record. */
export interface CourseRecord {
  readonly id: CourseId
  readonly name: string
  readonly createdAt: string
  readonly workspaceId: WorkspaceId
  readonly generationSessionId?: SessionId
  readonly learningSessionId?: SessionId
  /** Imported folders retain their original visible document layout. */
  readonly imported?: true
}
/** A tree row is course-relative and never names a host path. */
export interface CourseFile {
  readonly path: string
  readonly directory: boolean
  readonly bytes: number
}
/** CAS read result. */
export interface CourseFileContent {
  readonly path: string
  readonly text: string
  readonly version: string
  readonly presentation?: import('./presentation.ts').CoursePresentation
  readonly document: CourseDocument
  /** Versioned reading projection; offsets and document metadata remain source-bound. */
  readonly reading?:
    | {
      readonly schemaVersion: 1
      readonly annotations: readonly {
        readonly start: number
        readonly annotation: import('./presentation.ts').PresentationAnnotation
      }[]
    }
    | undefined
}
/** An immutable quote lives outside the rebuildable search index. */
export interface CourseQuote extends SourceRange {
  readonly id: CourseQuoteId
  readonly courseId: CourseId
  readonly path: string
  readonly version: string
  readonly text: string
  readonly createdAt: string
}

function escaped(source: string, index: number): boolean {
  let n = 0
  while (index > 0 && source[--index] === '\\') n++
  return n % 2 === 1
}
function parts(target: string): { target: string; anchor: string } {
  const at = target.indexOf('#')
  return at < 0 ? { target, anchor: '' } : { target: target.slice(0, at), anchor: target.slice(at + 1) }
}
/**
 * Extract plain text without evaluating HTML or markup.
 * @param node - Course semantic node.
 * @returns Text content, including descendant leaves.
 */
export function coursePlainText(node: CourseNode): string {
  return node.value ?? node.children?.map(coursePlainText).join('') ?? ''
}
/**
 * Parse GFM/math/YAML and course syntax with source positions.
 * @param source - Unmodified UTF-8-decoded Markdown.
 * @returns A reading tree and semantic projections.
 */
export function parseCourseDocument(source: string): CourseDocument {
  const parse = (text: string): Root =>
    fromMarkdown(text, {
      extensions: [gfm(), math(), frontmatter(['yaml'])],
      mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown(), frontmatterFromMarkdown(['yaml'])],
    })
  let tree = parse(source)
  const protectedRanges: SourceRange[] = []
  const protect = (node: RootContent | Root): void => {
    if (['code', 'inlineCode', 'html', 'yaml'].includes(node.type))
      protectedRanges.push({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 })
    else if ('children' in node) for (const child of node.children) protect(child)
  }
  protect(tree)
  const comments: SourceRange[] = []
  let commentStart: number | undefined
  for (let i = 0; i < source.length - 1; i++) {
    if (source.slice(i, i + 2) !== '%%' || escaped(source, i)) continue
    if (commentStart === undefined) {
      if (protectedRanges.some(r => i >= r.start && i < r.end)) continue
      commentStart = i
    } else {
      comments.push({ start: commentStart, end: i + 2 })
      commentStart = undefined
    }
    i++
  }
  if (commentStart !== undefined) comments.push({ start: commentStart, end: source.length })
  // Keep alias separators inside a wiki token out of GFM's table delimiter tokenizer.
  // One UTF-16 code unit replaces one code unit, preserving every source coordinate.
  const aliases = [...source.matchAll(/!?\[\[([^\]\n]+)\]\]/gu)].filter(
    match =>
      !escaped(source, match.index) &&
      !protectedRanges.some(range => match.index >= range.start && match.index < range.end),
  )
  let parsedSource = source
  const aliasPositions = new Set<number>()
  for (const match of aliases.reverse()) {
    const start = match.index,
      end = start + match[0].length
    for (let index = start; index < end; index++) if (source[index] === '|') aliasPositions.add(index)
    parsedSource =
      parsedSource.slice(0, start) + parsedSource.slice(start, end).replaceAll('|', '\uE000') + parsedSource.slice(end)
  }
  if (comments.length > 0) {
    // Non-whitespace placeholders prevent a trailing visible link from
    // accidentally becoming an indented code block. One UTF-16 unit stays
    // one unit even when the comment contains surrogate pairs.
    for (const range of [...comments].reverse())
      parsedSource =
        parsedSource.slice(0, range.start) +
        parsedSource.slice(range.start, range.end).replace(/[^\r\n]/g, '\u200b') +
        parsedSource.slice(range.end)
  }
  if (parsedSource !== source) tree = parse(parsedSource)
  const restored = (start: number, end: number): string =>
    parsedSource
      .slice(start, end)
      .split('')
      .map((char, index) => (char === '\uE000' && aliasPositions.has(start + index) ? '|' : char))
      .join('')
  const restoredValue = (value: string, start: number, end: number): string => {
    if (!value.includes('\uE000')) return value
    const symbols = [...parsedSource.slice(start, end).matchAll(/\uE000/gu)].map(match =>
      aliasPositions.has(start + match.index) ? '|' : '\uE000',
    )
    let index = 0
    return value.replaceAll('\uE000', () => symbols[index++] ?? '\uE000')
  }
  const links: CourseLink[] = []
  const headings: (SourceRange & { text: string; depth: number })[] = []
  const blocks: (SourceRange & { id: string })[] = []
  const tags = new Set<string>()
  let properties: Record<string, unknown> = {}
  let propertyError: string | undefined
  const convert = (node: RootContent | Root, inLink = false): CourseNode => {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? source.length
    const value =
      'value' in node
        ? node.type === 'text'
          ? decodeString(restored(start, end)).replaceAll('\u200b', '')
          : restoredValue(node.value, start, end)
        : undefined
    if (node.type === 'yaml') {
      const yaml = parseDocument(node.value, { uniqueKeys: true })
      if (yaml.errors.length > 0) propertyError = yaml.errors.map(e => e.message).join('\n')
      else {
        try {
          const parsed: unknown = yaml.toJS({ maxAliasCount: 50 })
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // Reject circular alias projections; every API result must be JSON-safe.
            properties = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
          }
        } catch (error) {
          propertyError = error instanceof Error ? error.message : String(error)
        }
      }
    }
    const children: CourseNode[] = []
    if ('children' in node) {
      for (const child of node.children) {
        const item = convert(child, inLink || node.type === 'link' || node.type === 'linkReference')
        // Operate only on parser-recognized text leaves. Code, HTML, math,
        // destinations and escaped delimiters cannot become semantic links.
        if (child.type !== 'text' || inLink || node.type === 'link' || node.type === 'linkReference') {
          children.push(item)
          continue
        }
        const raw = restored(item.start, item.end)
        const pattern = /!?\[\[([^\]\n]+)\]\]|%%[\s\S]*?%%|==([^=\n]+)==/gu
        let cursor = 0
        let found = false
        for (const match of raw.matchAll(pattern)) {
          if (escaped(raw, match.index)) continue
          found = true
          if (match.index > cursor)
            children.push({
              type: 'text',
              value: decodeString(raw.slice(cursor, match.index).replaceAll('\u200b', '')),
              start: item.start + cursor,
              end: item.start + match.index,
            })
          const a = item.start + match.index
          const b = a + match[0].length
          if (match[1] !== undefined) {
            const embed = match[0].startsWith('!')
            const content = match[1].replaceAll('\\|', '|')
            const bar = content.indexOf('|')
            const destination = (bar < 0 ? content : content.slice(0, bar)).trim()
            const link = parts(destination)
            const targetStart = a + (embed ? 3 : 2) + match[1].indexOf(destination)
            links.push({ ...link, start: targetStart, end: targetStart + link.target.length, embed, wiki: true })
            children.push({
              type: 'wiki',
              url: destination,
              value: bar < 0 ? destination : content.slice(bar + 1),
              embed,
              start: a,
              end: b,
            })
          } else
            children.push({
              type: match[2] === undefined ? 'comment' : 'highlight',
              value: match[2] ?? '',
              start: a,
              end: b,
            })
          cursor = match.index + match[0].length
        }
        if (!found) children.push(item)
        else if (cursor < raw.length)
          children.push({
            type: 'text',
            value: decodeString(raw.slice(cursor).replaceAll('\u200b', '')),
            start: item.start + cursor,
            end: item.end,
          })
      }
    }
    const result: CourseNode = {
      type: node.type,
      start,
      end,
      ...(value === undefined ? {} : { value }),
      ...('children' in node ? { children } : {}),
      ...('depth' in node ? { depth: node.depth } : {}),
      ...('url' in node ? { url: node.url } : {}),
      ...('title' in node ? { title: node.title } : {}),
      ...('lang' in node ? { lang: node.lang } : {}),
      ...('checked' in node ? { checked: node.checked } : {}),
      ...('ordered' in node ? { ordered: node.ordered } : {}),
      ...('identifier' in node ? { identifier: node.identifier } : {}),
    }
    if (node.type === 'heading') headings.push({ start, end, text: coursePlainText(result), depth: node.depth })
    if (node.type === 'paragraph') {
      const id = /(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/u.exec(source.slice(start, end))?.[1]
      if (id !== undefined) blocks.push({ start, end, id })
    }
    if (node.type === 'text' && !inLink)
      for (const tag of node.value.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
        if (tag[1] !== undefined) tags.add(tag[1])
      }
    if ((node.type === 'link' || node.type === 'image') && !/^(?:[a-z][\w+.-]*:|\/\/)/iu.test(node.url)) {
      const raw = source.slice(start, end)
      // Destination offsets belong to the AST link, not a global source scan.
      const begin = raw.indexOf('](')
      if (begin >= 0 && !raw.slice(begin + 2).startsWith('<')) {
        const loc = start + begin + 2
        const target = parts(node.url)
        links.push({
          ...target,
          start: loc,
          end:
            loc +
            (raw
              .slice(begin + 2)
              .split(/[\s)]/u)[0]
              ?.split('#')[0]?.length ?? 0),
          embed: node.type === 'image',
          wiki: false,
        })
      }
    }
    return result
  }
  const nodes = convert(tree).children ?? []
  return {
    nodes,
    links,
    headings: headings.sort((a, b) => a.start - b.start),
    blocks,
    tags: [...tags],
    properties,
    ...(propertyError === undefined ? {} : { propertyError }),
  }
}

/**
 * Resolve a link within one course while retaining ambiguity.
 * @param from - Originating course-relative file path.
 * @param target - Destination without its anchor.
 * @param paths - Course-relative file inventory.
 * @param wiki - Whether basename fallback is allowed.
 * @returns A resolved path or explicit ambiguous candidates.
 */
export function resolveCourseLink(
  from: string,
  target: string,
  paths: readonly string[],
  wiki = true,
): { path?: string; ambiguous: readonly string[] } {
  return resolveIndexedCourseLink(
    from,
    target,
    wiki,
    candidate => paths.filter(path => path === candidate || path === candidate + '.md'),
    name =>
      paths.filter((path) => {
        const base = path.split('/').pop() ?? path
        return base === name || base === name + '.md'
      }),
  )
}

/**
 * Build exact-path and basename lookups once for a batch of course-local links.
 * @param paths - Admitted file inventory, preserving its ambiguity order.
 * @returns A resolver with the same relative-path priority as resolveCourseLink.
 */
export function createCourseLinkResolver(
  paths: readonly string[],
): (from: string, target: string, wiki?: boolean) => { path?: string; ambiguous: readonly string[] } {
  const exact = new Map<string, string[]>(),
    names = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, key: string, path: string): void => {
    const entries = map.get(key)
    if (entries === undefined) map.set(key, [path])
    else entries.push(path)
  }
  for (const path of paths) {
    add(exact, path, path)
    if (path.endsWith('.md')) add(exact, path.slice(0, -3), path)
    const name = path.split('/').pop() ?? path
    add(names, name, path)
    if (name.endsWith('.md')) add(names, name.slice(0, -3), path)
  }
  return (from, target, wiki = true) =>
    resolveIndexedCourseLink(
      from,
      target,
      wiki,
      candidate => exact.get(candidate) ?? [],
      name => names.get(name) ?? [],
    )
}

function resolveIndexedCourseLink(
  from: string,
  target: string,
  wiki: boolean,
  exactPaths: (candidate: string) => readonly string[],
  basenames: (name: string) => readonly string[],
): { path?: string; ambiguous: readonly string[] } {
  let decoded: string
  try {
    decoded = decodeURIComponent(target).replaceAll('\\', '/')
  } catch {
    return { ambiguous: [] }
  }
  if (/^(?:[a-z][\w+.-]*:|\/\/)/iu.test(decoded)) return { ambiguous: [] }
  if (decoded === '') return { path: from, ambiguous: [] }
  const normalize = (value: string): string | undefined => {
    const result: string[] = []
    for (const part of value.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (result.length === 0) return
        result.pop()
      } else result.push(part)
    }
    return result.join('/')
  }
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
  const candidates = wiki ? [normalize(base + decoded), normalize(decoded)] : [normalize(base + decoded)]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const exact = exactPaths(candidate)
    const first = exact[0]
    if (exact.length === 1 && first !== undefined) return { path: first, ambiguous: [] }
  }
  if (!wiki || decoded.includes('/')) return { ambiguous: [] }
  const matches = basenames(decoded)
  const first = matches[0]
  return matches.length === 1 && first !== undefined ? { path: first, ambiguous: [] } : { ambiguous: matches }
}

/**
 * Serialize a Host-verified quote for the model and durable chip replay.
 * The closing identity is minted after the quoted source text.
 * @param quote - Saved source text and its versioned coordinates.
 * @returns Model-visible source with complete provenance.
 */
export function serializeCourseQuote(quote: CourseQuote): string {
  const provenance = {
    courseId: quote.courseId,
    quoteId: quote.id,
    path: quote.path,
    version: quote.version,
    start: quote.start,
    end: quote.end,
  }
  return `<course-quote ${JSON.stringify(provenance)}>\n${quote.text}\n</course-quote:${quote.id}>`
}

export { isCourseStudyAction, studyActionSkill, type ActiveCourseStudyAction, type CourseStudyAction } from './study-actions.ts'
export * from './study-display.ts'

export { organizeCourseNotes } from './study-notes.ts'
export type { CourseStudyReply } from './study-notes.ts'

export {
  presentationBlocks,
  presentationSignature,
  validatePresentationAnnotations,
  readCoursePresentation,
} from './presentation.ts'
export type {
  CoursePresentation,
  PresentationAnnotation,
  PresentationBlock,
  PresentationDecision,
  PresentationRole,
} from './presentation.ts'

export type { CourseGraphData, CourseGraphNote, CourseGraphLayout } from './graph.ts'
export { courseReadingTree } from './reading.ts'
export type { ReadingNode } from './reading.ts'
