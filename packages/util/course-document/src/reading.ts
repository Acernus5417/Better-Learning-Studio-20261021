/** Source-preserving presentation for ordinary course Markdown and safe disclosures. */
import { parseCourseDocument, coursePlainText } from './index.ts'
import type { CourseNode, CoursePresentation } from './index.ts'

/** Reading-only metadata; never written to the course or its semantic index. */
export interface ReadingNode extends Omit<CourseNode, 'children'> {
  readonly children?: readonly ReadingNode[]
  readonly initialOpen?: boolean
  readonly cardMetadata?: boolean
  readonly cardDisclosure?: boolean
  readonly learningRole?: 'summary' | 'practice' | 'warning'
}
function shift(node: CourseNode, offset: number): ReadingNode {
  return {
    ...node,
    start: node.start + offset,
    end: node.end + offset,
    ...(node.children === undefined ? {} : { children: node.children.map(child => shift(child, offset)) }),
  }
}
function learningSections(nodes: readonly ReadingNode[]): readonly ReadingNode[] {
  const result: ReadingNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node === undefined) continue
    const title = node.type === 'heading' ? coursePlainText(node).trim() : ''
    const role: ReadingNode['learningRole'] =
      /^(?:本[章节课]\s*)?(?:总结|小结|核心要点|知识要点|Summary|Key (?:points|takeaways))/iu.test(title)
        ? 'summary'
        : /^(?:易错|常见误区|注意|Warnings?|Pitfalls?)/iu.test(title)
          ? 'warning'
          : /^(?:入门诊断|诊断答案|练习|自测|测验|章末综合|Exercises?|Quiz|Practice)/iu.test(title)
            ? 'practice'
            : undefined
    if (role === undefined) {
      result.push(node)
      continue
    }
    let end = i + 1
    while (end < nodes.length) {
      const next = nodes[end]
      if (next?.type === 'heading' && (next.depth ?? 1) <= (node.depth ?? 1)) break
      end++
    }
    const children = nodes.slice(i, end)
    result.push({
      type: 'learningSection',
      start: node.start,
      end: children.at(-1)?.end ?? node.end,
      children,
      learningRole: role,
    })
    i = end - 1
  }
  return result
}
/**
 * Project complete details/summary containers and educational sections without changing source offsets.
 * @param source - Unmodified course Markdown.
 * @param nodes - Its indexed parser nodes; literal code is never interpreted as HTML.
 * @returns A React-renderable reading tree with inert arbitrary HTML.
 */
export function courseReadingTree(
  source: string,
  nodes: readonly CourseNode[],
  presentation?: CoursePresentation,
): readonly ReadingNode[] {
  const sections = (items: readonly ReadingNode[]): readonly ReadingNode[] =>
    presentation === undefined ? learningSections(items) : items
  const project = (input: readonly ReadingNode[], depth: number): readonly ReadingNode[] => {
    if (depth >= 24) return input
    const stack: { start: number; end: number; open: boolean }[] = []
    const regions: { start: number; end: number; bodyStart: number; bodyEnd: number; title: string; open: boolean }[] =
      []
    for (const node of input) {
      if (node.type !== 'html' || /^\s*<!--/u.test(node.value ?? '')) continue
      const html = source.slice(node.start, node.end)
      for (const match of html.matchAll(/<\/?details\b[^<>]*>/giu)) {
        const start = node.start + match.index,
          end = start + match[0].length
        if (!/^<\//u.test(match[0])) {
          stack.push({ start, end, open: /^<details\s+[^>]*\bopen(?:\s|=|>)/iu.test(match[0]) })
        } else {
          const begin = stack.pop()
          if (begin === undefined || stack.length !== 0) continue
          const summary = /^\s*<summary\b[^<>]*>([\s\S]*?)<\/summary\s*>/iu.exec(source.slice(begin.end, start))
          if (summary === null) continue
          const title = parseCourseDocument(summary[1]?.replace(/<[^>]*>/gu, '') ?? '')
            .nodes.map(coursePlainText)
            .join(' ')
            .trim()
          regions.push({
            start: begin.start,
            end,
            bodyStart: begin.end + summary[0].length,
            bodyEnd: start,
            title,
            open: begin.open,
          })
        }
      }
    }
    const parse = (start: number, end: number): readonly ReadingNode[] =>
      project(
        parseCourseDocument(source.slice(start, end)).nodes.map(node => shift(node, start)),
        depth + 1,
      )
    if (regions.length === 0)
      return sections(
        input.map(node =>
          node.children === undefined ? node : { ...node, children: project(node.children, depth + 1) },
        ),
      )
    const result: ReadingNode[] = []
    let cursor = input[0]?.start ?? 0
    for (const region of regions) {
      if (region.start > cursor) result.push(...parse(cursor, region.start))
      result.push({
        type: 'details',
        start: region.start,
        end: region.end,
        title: region.title,
        initialOpen: region.open,
        children: parse(region.bodyStart, region.bodyEnd),
      })
      cursor = region.end
    }
    const end = input.at(-1)?.end ?? cursor
    if (cursor < end) result.push(...parse(cursor, end))
    return sections(result)
  }
  const projected = project(nodes, 0)
  if (presentation?.kind !== 'cards') return projected
  const result: ReadingNode[] = []
  for (let i = 0; i < projected.length; i++) {
    const node = projected[i]
    if (node === undefined) continue
    if (node.type === 'details') {
      result.push({ ...node, cardDisclosure: true })
      continue
    }
    if (node.type === 'table' && /字段.*内容/u.test(coursePlainText(node.children?.[0] ?? node))) {
      result.push({
        type: 'details',
        start: node.start,
        end: node.end,
        cardMetadata: true,
        cardDisclosure: true,
        children: [node],
        initialOpen: false,
      })
      continue
    }
    // Only existing answer/metadata sections fold; prompts and identity anchors retain source order.
    if (
      node.type !== 'heading' ||
      !/^(?:核对(?:与纠错)?|答案(?:与解析)?|元信息|来源和其他元信息)$/u.test(coursePlainText(node).trim())
    ) {
      result.push(node)
      continue
    }
    let end = i + 1
    while (end < projected.length) {
      const next = projected[end]
      if (next?.type === 'heading' && (next.depth ?? 1) <= (node.depth ?? 1)) break
      if (next?.type === 'html' && /<!-- BL-KP:END/u.test(next.value ?? '')) break
      end++
    }
    const body = projected.slice(i + 1, end)
    if (
      body.some(
        child =>
          child.type === 'details' ||
          (child.type === 'blockquote' && /\[![^\]]+\]-/u.test(source.slice(child.start, child.end))),
      )
    ) {
      result.push(node)
      continue
    }
    result.push({
      type: 'details',
      start: node.start,
      end: body.at(-1)?.end ?? node.end,
      title: coursePlainText(node),
      cardDisclosure: true,
      children: body,
      initialOpen: false,
    })
    i = end - 1
  }
  return result
}
