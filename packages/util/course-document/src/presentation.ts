/** Versioned, source-preserving semantic decorations shared by Host and reader. */
import { coursePlainText, parseCourseDocument } from './index.ts'
import type { CourseNode } from './index.ts'

/** Fixed semantic roles; model output cannot supply styles, HTML, or new prose. */
export type PresentationRole = 'definition' | 'conclusion' | 'condition' | 'pitfall' | 'contrast' | 'step'
/** An exact plain-text leaf eligible for a bounded model annotation. */
export interface PresentationBlock {
  readonly id: string
  readonly text: string
  readonly start: number
  readonly end: number
  readonly unit: string
  readonly section: string
  readonly protected: boolean
  readonly metadata?: true
}
/** Model-selected emphasis bound to an existing leaf and verbatim quote. */
export interface PresentationAnnotation {
  readonly id: string
  readonly block: string
  readonly quote: string
  readonly role: PresentationRole
  readonly emphasis: 'bold' | 'highlight'
  readonly evidence: string
}
/** Each complete teaching unit/card receives a visible machine-readable decision. */
export interface PresentationDecision {
  readonly unit: string
  readonly status: 'passed' | 'basic'
  readonly reason: string
}
/** Portable metadata; Markdown bytes and existing content fingerprints remain unchanged. */
export interface CoursePresentation {
  readonly schemaVersion: 1
  readonly profile: 'semantic-v1'
  readonly kind: 'lesson' | 'cards'
  readonly signature: string
  readonly evidenceHash?: string
  readonly annotations: readonly PresentationAnnotation[]
  readonly decisions: readonly PresentationDecision[]
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function key(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36)
}
/**
 * Identify immutable text leaves and protect metadata, navigation, questions, code and formulae.
 * IDs survive derived BL-REL rewrites because they do not contain absolute offsets.
 * @param source - Exact candidate Markdown.
 * @returns Complete ordered model targets, including protected leaves for context.
 */
export function presentationBlocks(source: string): readonly PresentationBlock[] {
  const protectedRanges = [...source.matchAll(/<!-- BL-REL:BEGIN[^>]*-->[\s\S]*?<!-- BL-REL:END[^>]*-->/gu)].map(
    match => ({ start: match.index, end: match.index + match[0].length }),
  )
  const blocks: PresentationBlock[] = []
  const counts = new Map<string, number>()
  const cardMarkers = [
    ...source.matchAll(/<!-- BL-KP:BEGIN\s+(KP-[A-Z0-9-]+)[^>]*-->|^(KP-[A-Z0-9-]+)\s+\^[A-Z0-9-]+\s*$/gmu),
  ]
  let section = '',
    unit = 'document',
    guardedSection = false,
    guardedDepth = 7
  const walk = (node: CourseNode, protectedParent = false, metadataParent = false): void => {
    if (protectedRanges.some(range => node.start >= range.start && node.end <= range.end)) return
    if (node.type === 'heading') {
      section = coursePlainText(node)
      const identity = /(?:KP-[A-Z0-9-]+|TU-[A-Z0-9-]+|K-\d{6})/u.exec(
        source.slice(Math.max(0, node.start - 150), node.end),
      )?.[0]
      const marker = cardMarkers.findLast(match => match.index <= node.end)
      const card = marker?.[1] || marker?.[2]
      if (card !== undefined) unit = card
      else if (identity !== undefined) unit = identity
      else if ((node.depth ?? 1) <= 2) unit = 'section-' + key(section)
      if ((node.depth ?? 1) <= guardedDepth) guardedSection = false
      if (
        /检索|诊断|自测|练习|测验|题目|来源|元信息|掌握|入口|目录|导航|关系|目标|retrieval|quiz|source|mastery/iu.test(
          section,
        )
      ) {
        guardedSection = true
        guardedDepth = node.depth ?? 1
      }
      return
    }
    const raw = source.slice(node.start, node.end)
    const metadataTable = node.type === 'table' && /字段.*内容/u.test(coursePlainText(node.children?.[0] ?? node))
    const metadata = metadataParent || metadataTable || /^(?:掌握度|来源|元信息)/u.test(section)
    const guarded =
      protectedParent ||
      metadataTable ||
      [
        'yaml',
        'html',
        'comment',
        'code',
        'inlineCode',
        'math',
        'inlineMath',
        'wiki',
        'link',
        'linkReference',
        'image',
        'highlight',
        'strong',
        'emphasis',
      ].includes(node.type) ||
      /^\s*[A-Z][\w-]*\s+\^[\w-]+\s*$/u.test(raw)
    if (['code', 'inlineCode', 'math', 'inlineMath', 'yaml'].includes(node.type)) {
      const hash = key(node.type + raw),
        count = (counts.get(hash) ?? 0) + 1
      counts.set(hash, count)
      blocks.push({
        id: `p-${hash}-${count}`,
        text: raw,
        start: node.start,
        end: node.end,
        unit,
        section,
        protected: true,
      })
    }
    if (node.type === 'text' && node.value === raw && raw.trim() !== '') {
      const hash = key(unit + '\n' + section + '\n' + raw)
      const count = (counts.get(hash) ?? 0) + 1
      counts.set(hash, count)
      blocks.push({
        id: `b-${hash}-${count}`,
        text: raw,
        start: node.start,
        end: node.end,
        unit,
        section,
        protected: guarded || guardedSection,
        ...(metadata ? { metadata: true } : {}),
      })
    }
    for (const child of node.children ?? []) walk(child, guarded, metadata)
  }
  for (const node of parseCourseDocument(source).nodes) walk(node)
  return blocks
}
/**
 * Validate untrusted model/portable annotations against current source; unknown fields never become markup.
 * @param value - Parsed JSON annotation array.
 * @param blocks - Current source targets.
 * @param kind - Selects the stricter card emphasis budget.
 * @returns Validated plan, or throws before publication.
 */
export function validatePresentationAnnotations(
  value: unknown,
  blocks: readonly PresentationBlock[],
  kind: 'lesson' | 'cards',
): readonly PresentationAnnotation[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('presentation: invalid annotation array')
  const result: PresentationAnnotation[] = [],
    ids = new Set<string>(),
    used = new Set<string>(),
    highlighted = new Set<string>()
  let highlightSize = 0
  const total = blocks.filter(block => !block.protected).reduce((sum, block) => sum + block.text.length, 0)
  for (const item of value as readonly unknown[]) {
    if (!object(item))
      throw new Error('presentation: invalid annotation')
    const row: Record<string, unknown> = item
    const { id, block, quote, role, emphasis, evidence } = row
    if (
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/u.test(id) ||
      ids.has(id) ||
      typeof block !== 'string' ||
      used.has(block) ||
      typeof quote !== 'string' ||
      quote.length < 2 ||
      quote.length > 180 ||
      !['definition', 'conclusion', 'condition', 'pitfall', 'contrast', 'step'].includes(String(role)) ||
      (emphasis !== 'bold' && emphasis !== 'highlight') ||
      typeof evidence !== 'string' ||
      evidence.length < 4 ||
      evidence.length > 1000
    )
      throw new Error('presentation: invalid or duplicate annotation fields')
    const target = blocks.find(candidate => candidate.id === block)
    if (
      target === undefined ||
      target.protected ||
      /\b(?:KP|K|EX|L|TU)-[A-Z0-9-]+\b/u.test(quote) ||
      !target.text.includes(quote) ||
      target.text.indexOf(quote) !== target.text.lastIndexOf(quote)
    )
      throw new Error('presentation: protected or ambiguous quote')
    // Conditions and negations must retain their complete sentence, never a misleading fragment.
    const sentence = target.text.split(/(?<=[。！？.!?])/u).find(part => part.includes(quote))
    if (
      sentence === undefined ||
      (/(?:不|无|非|只有|除非|如果|仅当|必须|unless|only if|must not|\b(?:not|no|never|except|without)\b)/iu.test(sentence) &&
        quote.trim() !== sentence.trim())
    )
      throw new Error('presentation: incomplete conditional sentence')
    if (emphasis === 'highlight') {
      const owner = kind === 'cards' ? target.unit : target.id
      if (highlighted.has(owner)) throw new Error('presentation: highlight density per unit exceeded')
      highlighted.add(owner)
      highlightSize += quote.length
    }
    ids.add(id)
    used.add(block)
    result.push({ id, block, quote, role: role as PresentationRole, emphasis, evidence })
  }
  if (highlightSize > total * (kind === 'cards' ? 0.06 : 0.08))
    throw new Error('presentation: highlight budget exceeded')
  return result
}
/**
 * Decode portable metadata and reject stale or malformed source bindings.
 * @param value - Untrusted file JSON.
 * @param source - Current Markdown.
 * @returns A fully rebound presentation, or undefined for basic rendering.
 */
export function readCoursePresentation(value: unknown, source: string): CoursePresentation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  const row = value as Record<string, unknown>
  if (
    row.schemaVersion !== 1 ||
    row.profile !== 'semantic-v1' ||
    (row.kind !== 'lesson' && row.kind !== 'cards') ||
    typeof row.signature !== 'string' ||
    !Array.isArray(row.decisions)
  )
    return
  const blocks = presentationBlocks(source)
  if (row.signature !== presentationSignature(blocks)) return
  const decisions: PresentationDecision[] = []
  for (const item of row.decisions as readonly unknown[]) {
    if (
      !object(item) ||
      typeof item.unit !== 'string' ||
      (item.status !== 'passed' && item.status !== 'basic') ||
      typeof item.reason !== 'string'
    )
      return
    decisions.push({ unit: item.unit, status: item.status, reason: item.reason })
  }
  const units = new Set(blocks.map(block => block.unit))
  if (
    decisions.length !== units.size ||
    decisions.some(item => !units.has(item.unit)) ||
    new Set(decisions.map(item => item.unit)).size !== decisions.length
  )
    return
  try {
    const annotations = validatePresentationAnnotations(row.annotations, blocks, row.kind)
    if (
      annotations.some(
        item =>
          !decisions.some(
            decision =>
              decision.status === 'passed' &&
              blocks.some(block => block.id === item.block && block.unit === decision.unit),
          ),
      )
    )
      return
    return {
      schemaVersion: 1,
      profile: 'semantic-v1',
      kind: row.kind,
      signature: row.signature,
      ...(typeof row.evidenceHash === 'string' && /^[a-f0-9]{64}$/u.test(row.evidenceHash) ? { evidenceHash: row.evidenceHash } : {}),
      annotations,
      decisions,
    }
  } catch (_error) {
    // Metadata is optional. A rejected binding never changes or hides source content.
    return undefined
  }
}
/**
 * Bind teaching text without derived relation offsets. Host additionally retains SHA-256 source evidence.
 * @param blocks - Complete ordered source projection.
 * @returns Deterministic projection identity.
 */
export function presentationSignature(blocks: readonly PresentationBlock[]): string {
  return key(JSON.stringify(blocks.filter(block => !block.metadata).map(({ id, text, protected: guarded }) => [id, text, guarded])))
}
