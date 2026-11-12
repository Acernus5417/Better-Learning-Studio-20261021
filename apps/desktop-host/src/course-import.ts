/** Course folders are copied as data; no scripts or plugins are executed. */
import { lstat, readdir, realpath, copyFile, mkdir } from 'node:fs/promises'
import { resolve, relative, join, isAbsolute, basename, dirname, sep } from 'node:path'

/** Metadata-only import preview, independent of the source's folder layout. */
export interface CourseImportPlan {
  readonly source: string
  readonly name: string
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly mtime: number }[]
  readonly directories: readonly string[]
  readonly markdown: number
  readonly bytes: number
}
/** Rejected imports leave the source and existing courses untouched. */
export class CourseImportError extends Error {
  constructor(
    readonly code: 'IMPORT_DIRECTORY' | 'IMPORT_MARKDOWN' | 'IMPORT_LINK' | 'IMPORT_CHANGED' | 'IMPORT_LIMIT',
    message: string,
  ) {
    super(message)
  }
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
/**
 * Inspect a chosen directory without reading file contents or following links.
 * @param path - Absolute user-chosen source directory.
 * @param libraryRoot - Program-owned destination root, never allowed inside the source.
 * @returns Safe source metadata and its Markdown count.
 */
export async function inspectCourseImport(path: string, libraryRoot: string): Promise<CourseImportPlan> {
  if (!isAbsolute(path)) throw new CourseImportError('IMPORT_DIRECTORY', 'Choose a course directory')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CourseImportError('IMPORT_DIRECTORY', 'Choose a regular directory')
  const source = await realpath(path)
  const target = await realpath(libraryRoot)
  if (within(source, target))
    throw new CourseImportError('IMPORT_DIRECTORY', 'The library cannot be imported into itself')
  const files: { path: string; bytes: number; mtime: number }[] = [],
    directories: string[] = []
  let markdown = 0,
    bytes = 0
  const visit = async (folder: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 40) throw new CourseImportError('IMPORT_LIMIT', 'The directory nesting is too deep')
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (prefix === '' && entry.name.toLowerCase() === '.studio') continue
      const path = prefix + entry.name,
        location = join(folder, entry.name),
        stat = await lstat(location)
      if (stat.isSymbolicLink())
        throw new CourseImportError('IMPORT_LINK', 'Symbolic links and junctions cannot be imported')
      if (stat.isDirectory()) {
        directories.push(path)
        await visit(location, path + '/', depth + 1)
      } else if (stat.isFile()) {
        files.push({ path, bytes: stat.size, mtime: stat.mtimeMs })
        bytes += stat.size
        if (/\.md$/iu.test(entry.name)) markdown++
      } else throw new CourseImportError('IMPORT_LINK', 'Only regular files and directories can be imported')
      if (files.length + directories.length > 20_000)
        throw new CourseImportError('IMPORT_LIMIT', 'The course contains more than 20000 entries')
    }
  }
  await visit(source, '', 0)
  if (markdown === 0)
    throw new CourseImportError('IMPORT_MARKDOWN', 'The directory must contain at least one Markdown file')
  return { source, name: basename(source), files, directories, markdown, bytes }
}
/**
 * Copy a verified source into a newly allocated, hidden staging directory.
 * @param plan - Source inventory captured immediately before copying.
 * @param destination - Empty, program-owned staging directory.
 */
export async function copyCourseImport(plan: CourseImportPlan, destination: string): Promise<void> {
  const copiedPath = (path: string): string =>
    path === '_工作区' || path.startsWith('_工作区/')
      ? join(destination, '.studio', 'imported-workspace', path.slice('_工作区'.length + 1))
      : join(destination, path)
  for (const path of plan.directories) await mkdir(copiedPath(path), { recursive: true })
  for (const item of plan.files) {
    const path = resolve(plan.source, item.path)
    if (!within(plan.source, path) || (await realpath(path)) !== path)
      throw new CourseImportError('IMPORT_LINK', 'A source entry changed to a link')
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== item.bytes || before.mtimeMs !== item.mtime)
      throw new CourseImportError('IMPORT_CHANGED', 'The source changed during import')
    const target = copiedPath(item.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(path, target)
    const after = await lstat(path),
      copied = await lstat(target)
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      copied.size !== item.bytes
    )
      throw new CourseImportError('IMPORT_CHANGED', 'The source changed during import')
  }
}
