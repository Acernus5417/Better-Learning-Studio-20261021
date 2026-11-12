/** Course-local resolved relationships; source bodies never enter the graph projection. */
import { createCourseLinkResolver } from '@deepseek-ai/dsh-util-course-document'
import type { CourseFileContent, CourseGraphNote } from '@deepseek-ai/dsh-util-course-document'
import { graphAliases, graphPropertyLinks, graphMissingName } from './course-graph-links.ts'

type Projection = Pick<CourseGraphNote, 'links' | 'tags'>
const basename = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/iu, '').toLocaleLowerCase()
/** Reuse unchanged relationships and invalidate only sources referring to changed file names. */
export class CourseGraphIndex {
  private paths = new Set<string>()
  private resolve = createCourseLinkResolver([])
  private rows = new Map<string, { version: string; names: Set<string>; value: Projection }>()
  private references = new Map<string, Set<string>>()
  private aliases = new Map<string, string[]>()
  readonly metrics = { resolutions: 0 }

  /** Replace an admitted inventory; additions and deletions invalidate possible ambiguous destinations. */
  updateInventory(paths: readonly string[], documents: readonly CourseFileContent[] = []): void {
    const next = new Set(paths),
      names = new Set<string>()
    for (const path of this.paths) if (!next.has(path)) names.add(basename(path))
    for (const path of next) if (!this.paths.has(path)) names.add(basename(path))
    const aliases = new Map<string, string[]>()
    for (const file of documents)
      for (const alias of graphAliases(file.document.properties)) {
        const key = alias.toLocaleLowerCase(),
          targets = aliases.get(key)
        if (targets === undefined) aliases.set(key, [file.path])
        else if (!targets.includes(file.path)) targets.push(file.path)
      }
    for (const key of new Set([...this.aliases.keys(), ...aliases.keys()]))
      if ((this.aliases.get(key) ?? []).join('\0') !== (aliases.get(key) ?? []).join('\0')) names.add(key)
    if (names.size === 0) return
    const affected = new Set<string>()
    for (const name of names) for (const from of this.references.get(name) ?? []) affected.add(from)
    for (const path of this.rows.keys()) if (!next.has(path)) affected.add(path)
    for (const path of affected) this.drop(path)
    this.paths = next
    this.aliases = aliases
    this.resolve = createCourseLinkResolver(paths)
  }
  private rank(from: string, candidates: readonly string[]): string | undefined {
    const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    return [...candidates].sort(
      (a, b) =>
        Number(!a.startsWith(directory)) - Number(!b.startsWith(directory)) ||
        a.length - b.length ||
        (a < b ? -1 : a > b ? 1 : 0),
    )[0]
  }

  private drop(path: string): void {
    const row = this.rows.get(path)
    for (const name of row?.names ?? []) {
      const sources = this.references.get(name)
      sources?.delete(path)
      if (sources?.size === 0) this.references.delete(name)
    }
    this.rows.delete(path)
  }

  /** Resolve only new or content-changed metadata, retaining unresolved and ambiguous link behavior. */
  project(file: CourseFileContent): Projection {
    const existing = this.rows.get(file.path)
    if (existing?.version === file.version) return existing.value
    this.drop(file.path)
    const names = new Set<string>(),
      links = new Map<string, CourseGraphNote['links'][number]>()
    for (const link of [...file.document.links, ...graphPropertyLinks(file.document.properties)]) {
      if (link.target === '') continue
      try {
        const decoded = decodeURIComponent(link.target).replaceAll('\\', '/')
        names.add(basename(decoded))
        names.add(decoded.toLocaleLowerCase())
      } catch {
        /* invalid links remain unresolved */
      }
      const resolved = this.resolve(file.path, link.target, link.wiki)
      let target = resolved.path
      if (target === undefined && link.wiki) {
        target = this.rank(file.path, resolved.ambiguous)
        if (target === undefined) {
          let key = link.target
          try {
            key = decodeURIComponent(key)
          } catch {
            /* use the literal alias */
          }
          target = this.rank(
            file.path,
            this.aliases.get(key.toLocaleLowerCase()) ??
              this.aliases.get(graphMissingName(key).toLocaleLowerCase()) ??
              [],
          )
        }
      }
      this.metrics.resolutions++
      if (
        link.target
          .split(/[\\/]/u)
          .some(part => part === '..' || (part !== '.' && part.startsWith('.')) || part === '_工作区') &&
        target === undefined
      )
        continue
      const entry = { target: target ?? graphMissingName(link.target), resolved: target !== undefined }
      links.set(`${entry.resolved}:${entry.target}`, entry)
    }
    const tags = new Map(file.document.tags.map(tag => [tag.toLocaleLowerCase(), tag]))
    const metadataTags = file.document.properties.tags
    for (const tag of typeof metadataTags === 'string'
      ? metadataTags.split(/[,\s]+/u)
      : Array.isArray(metadataTags)
        ? metadataTags
        : [])
      if (typeof tag === 'string' && tag.replace(/^#/u, '').trim() !== '')
        if (!tags.has(tag.replace(/^#/u, '').trim().toLocaleLowerCase()))
          tags.set(tag.replace(/^#/u, '').trim().toLocaleLowerCase(), tag.replace(/^#/u, '').trim())
    const value = { links: [...links.values()], tags: [...tags.values()] }
    this.rows.set(file.path, { version: file.version, names, value })
    for (const name of names) {
      const sources = this.references.get(name)
      if (sources === undefined) this.references.set(name, new Set([file.path]))
      else sources.add(file.path)
    }
    return value
  }
}
