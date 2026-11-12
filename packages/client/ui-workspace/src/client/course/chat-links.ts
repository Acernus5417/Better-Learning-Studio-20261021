/** Course-bound resolution for the tutor's local Markdown citations. */
import type { CourseDocument } from '@deepseek-ai/dsh-util-course-document'
function normalize(value: string): string | undefined {
  const parts: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}
/**
 * Resolve only an existing current-course file, including Windows paths and relative citations.
 * @param path - Decoded link path.
 * @param cwd - Tutor workspace root.
 * @param from - Currently studied course-relative file.
 * @param files - Current course's regular-file inventory.
 * @returns One path, ambiguous candidates, or no match; outside absolute paths stay unresolved.
 */
export function resolveTutorFile(
  path: string,
  cwd: string | undefined,
  from: string,
  files: readonly string[],
): { path?: string; ambiguous: readonly string[] } {
  const windows = /^[a-z]:[/\\]/iu.test(cwd ?? '')
  const key = (value: string): string => (windows ? value.toLowerCase() : value)
  const available = files.filter(file => !/^(?:\.studio|\.git|\.obsidian|_工作区)(?:\/|$)/iu.test(file))
  let target = path.replaceAll('\\', '/')
  const absolute = /^(?:[a-z]:\/|\/)/iu.test(target)
  if (absolute) {
    const root = normalize(cwd ?? '')
    const resolved = normalize(target)
    if (root === undefined || root === '' || resolved === undefined || !key(resolved).startsWith(key(root) + '/'))
      return { ambiguous: [] }
    target = resolved.slice(root.length + 1)
  }
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
  for (const value of absolute ? [target] : [base + target, target]) {
    const candidate = normalize(value)
    if (candidate === undefined || /^(?:\.studio|\.git|\.obsidian|_工作区)(?:\/|$)/iu.test(candidate)) continue
    const matches = available.filter(file => key(file) === key(candidate) || key(file) === key(candidate + '.md'))
    if (matches.length === 1 && matches[0] !== undefined) return { path: matches[0], ambiguous: [] }
  }
  if (absolute || target.includes('/') || target === '' || target === '..') return { ambiguous: [] }
  const matches = available.filter((file) => {
    const name = file.split('/').at(-1) ?? ''
    return key(name) === key(target) || key(name) === key(target + '.md')
  })
  return matches.length === 1 && matches[0] !== undefined ? { path: matches[0], ambiguous: [] } : { ambiguous: matches }
}
/**
 * Locate a reader heading, block or source offset without changing Markdown.
 * @param document - Original indexed document.
 * @param anchor - Decoded heading, block identifier or internal @offset.
 * @returns The original UTF-16 source position when present.
 */
export function courseAnchorOffset(document: CourseDocument, anchor: string): number | undefined {
  if (anchor.startsWith('@')) {
    const offset = Number(anchor.slice(1))
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined
  }
  if (anchor.startsWith('^')) return document.blocks.find(block => block.id === anchor.slice(1))?.start
  const slug = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/gu, '-')
  return document.headings.find(heading => heading.text === anchor || slug(heading.text) === anchor)?.start
}
