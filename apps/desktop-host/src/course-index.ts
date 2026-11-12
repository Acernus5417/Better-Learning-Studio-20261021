/** Rebuildable per-course metadata and FTS cache; no Session or source writes. */
import { DatabaseSync } from 'node:sqlite'
import { lstat } from 'node:fs/promises'
import { z } from 'zod'
import type { CourseFileContent } from '@deepseek-ai/dsh-util-course-document'

const range = { start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }
const metadata = z.object({
  nodes: z.tuple([]),
  links: z.array(z.object({ ...range, target: z.string(), anchor: z.string(), embed: z.boolean(), wiki: z.boolean() })),
  headings: z.array(z.object({ ...range, text: z.string(), depth: z.number().int() })),
  blocks: z.array(z.object({ ...range, id: z.string() })),
  tags: z.array(z.string()),
  properties: z.record(z.string(), z.unknown()),
  propertyError: z.string().optional(),
})
/** Open only a caller-admitted private regular file; incompatible caches are rebuildable. */
export async function openCourseIndex(target: string): Promise<DatabaseSync> {
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe course index path')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const db = new DatabaseSync(target)
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000')
  // This database contains derived data only; parser/schema upgrades rebuild it from admitted files.
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
    db.exec('BEGIN; DROP TABLE IF EXISTS search; DROP TABLE IF EXISTS documents; PRAGMA user_version=1; COMMIT')
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS documents(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, version TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT NOT NULL)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS documents_version ON documents(version)')
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(path UNINDEXED, body, tokenize='trigram')")
  return db
}
/** Validate a persisted derived row; invalid rows are reparsed from the admitted source. */
export function readIndexedDocument(
  db: DatabaseSync,
  path: string,
  stamp: string,
  metadataOnly = false,
): CourseFileContent | undefined {
  const row = db
    .prepare(`SELECT version,${metadataOnly ? "'' AS body" : 'body'},metadata FROM documents WHERE path=? AND stamp=?`)
    .get(path, stamp)
  if (
    row === undefined ||
    typeof row.version !== 'string' ||
    typeof row.body !== 'string' ||
    typeof row.metadata !== 'string'
  )
    return
  try {
    const parsed = metadata.safeParse(JSON.parse(row.metadata))
    if (parsed.success) {
      const { propertyError, ...document } = parsed.data
      return {
        path,
        text: row.body,
        version: row.version,
        document: { ...document, ...(propertyError === undefined ? {} : { propertyError }) },
      }
    }
  } catch (error) {
    console.warn(
      'course index: rebuilding an invalid metadata row',
      error instanceof Error ? error.name : 'invalid data',
    )
  }
  return undefined
}
/** Reuse content-identical metadata after touch, copy or rename without parsing the source again. */
export function readIndexedContent(
  db: DatabaseSync,
  version: string,
  path: string,
  text: string,
): CourseFileContent | undefined {
  const row = db.prepare('SELECT path,stamp FROM documents WHERE version=? LIMIT 1').get(version)
  if (typeof row?.path !== 'string' || typeof row.stamp !== 'string') return
  const cached = readIndexedDocument(db, row.path, row.stamp, true)
  return cached === undefined ? undefined : { ...cached, path, text, version }
}
/** Refresh one document and its search row in the same caller-owned transaction. */
export function writeIndexedDocument(db: DatabaseSync, stamp: string, file: CourseFileContent): void {
  db.prepare('INSERT OR REPLACE INTO documents(path,stamp,version,body,metadata) VALUES(?,?,?,?,?)').run(
    file.path,
    stamp,
    file.version,
    file.text,
    JSON.stringify({ ...file.document, nodes: [] }),
  )
  db.prepare('DELETE FROM search WHERE path=?').run(file.path)
  db.prepare('INSERT INTO search(path,body) VALUES(?,?)').run(file.path, file.text)
}
