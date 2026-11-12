/** Request-scoped file admission for derived graph reads; never reused by mutations. */
import { lstat, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'

/** File information captured while admitting a course-local path. */
export interface CourseBatchFile {
  readonly target: string
  readonly info: Stats
}
/** Reuse verified directory prefixes and file stats within one graph operation only. */
export class CourseReadBatch {
  readonly directories = new Set<string>()
  readonly files = new Map<string, CourseBatchFile>()
  readonly metrics = { paths: 0, stats: 0, realpaths: 0, directoryHits: 0 }
  private constructor(
    readonly root: string,
    private readonly identity: Stats,
  ) {
    this.directories.add(root)
  }
  /** Capture root identity. @param root - Already admitted course root. @returns One request-scoped read batch. */
  static async create(root: string): Promise<CourseReadBatch> {
    const info = await lstat(root)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid graph course root')
    return new CourseReadBatch(root, info)
  }
  /** Reject a replaced root before publishing derived data or reading a changed source. */
  async verify(): Promise<void> {
    const info = await lstat(this.root)
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.dev !== this.identity.dev ||
      info.ino !== this.identity.ino ||
      (await realpath(this.root)) !== this.root
    )
      throw new Error('Course root changed during graph reading')
  }
}
