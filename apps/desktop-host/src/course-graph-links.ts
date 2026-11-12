/** Graph-only property relationships; canonical source offsets and rename links stay unchanged. */
import type { CourseDocument } from '@deepseek-ai/dsh-util-course-document'

/**
 * Extract graph relations without inventing source offsets.
 * @param properties - Parsed, bounded YAML property values.
 * @returns Decoded WikiLink destinations for graph projection only.
 */
export function graphPropertyLinks(properties: CourseDocument['properties']): { target: string; wiki: true }[] {
  const result: { target: string; wiki: true }[] = [],
    seen = new WeakSet<object>()
  let count = 0
  const visit = (value: unknown, depth: number): void => {
    if (++count > 20000) throw new Error('Course graph property limit exceeded')
    if (typeof value === 'string') {
      for (const match of value.matchAll(/!?\[\[([^\]\n]+)\]\]/gu)) {
        let slashes = 0,
          index = match.index
        while (index > 0 && value[--index] === '\\') slashes++
        if (slashes % 2 !== 0) continue
        const target = match[1]?.split('|')[0]?.split('#')[0]?.trim()
        if (target) result.push({ target, wiki: true })
        if (result.length > 50000) throw new Error('Course graph property link limit exceeded')
      }
    } else if (value !== null && typeof value === 'object' && depth < 8 && !seen.has(value)) {
      seen.add(value)
      for (const child of Object.values(value)) visit(child, depth + 1)
    }
  }
  visit(properties, 0)
  return result
}
/** Read aliases. @param properties - Parsed YAML properties. @returns Nonempty aliases with original spelling. */
export function graphAliases(properties: CourseDocument['properties']): string[] {
  const value = properties.aliases
  return (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
    .filter((name: unknown): name is string => typeof name === 'string' && name.trim() !== '' && name.length <= 1000)
    .map(name => name.trim())
}
/** Normalize unresolved names. @param target - Raw link destination. @returns A display key, never a disk admission. */
export function graphMissingName(target: string): string {
  let name = target
  try {
    name = decodeURIComponent(name)
  } catch {
    /* retain malformed literal names */
  }
  return (name.replaceAll('\\', '/').split('#')[0] ?? '').replace(/^(?:\.\/)+/u, '').replace(/\.md$/iu, '')
}
