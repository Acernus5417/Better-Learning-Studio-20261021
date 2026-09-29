/** Course ledger inspection connected to real DSH child lifecycle events. */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { CourseWatchdog, type CourseAttemptHealth, type CourseWatchdogInput, type CourseWatchdogStatus } from './course-watchdog.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(record) : []
}

async function lastActivity(course: string, attempt: Record<string, unknown>): Promise<number> {
  const start = typeof attempt.started_at === 'string' ? Date.parse(attempt.started_at)
    : typeof attempt.reserved_at === 'string' ? Date.parse(attempt.reserved_at) : Number.NaN
  let latest = Number.isFinite(start) ? start : 0
  if (typeof attempt.staging_dir === 'string') {
    const folder = resolve(course, attempt.staging_dir)
    if (folder === course || folder.startsWith(`${course}${sep}`)) {
      try {
        const pending = [folder]
        let inspected = 0
        while (pending.length > 0) {
          const directory = pending.pop()
          if (directory === undefined) break
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (++inspected > 10_000) throw new Error('course watchdog: staging directory has too many entries')
            const path = join(directory, entry.name)
            if (entry.isDirectory()) pending.push(path)
            else if (entry.isFile()) latest = Math.max(latest, (await stat(path)).mtimeMs)
          }
        }
      }
      catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error }
    }
  }
  return latest
}

/** Read the attempt ledger and join each child id with the current Host roster. */
export async function inspectCourseAttempts(
  course: string, liveIds: ReadonlySet<string>, settledIds: ReadonlySet<string>,
): Promise<CourseWatchdogInput> {
  let ledger: unknown
  try { ledger = JSON.parse(await readFile(join(course, '_工作区', '转写任务.json'), 'utf8')) }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return { active: [], readyUnits: 0 }
    throw error
  }
  if (!record(ledger)) throw new Error('course watchdog: invalid transcription ledger')
  const active: CourseAttemptHealth[] = []
  for (const attempt of rows(ledger.attempts)) {
    if (!['reserved', 'running', 'produced'].includes(String(attempt.state))) continue
    if (typeof attempt.id !== 'string') throw new Error('course watchdog: attempt has no id')
    const childId = typeof attempt.host_agent_id === 'string' ? attempt.host_agent_id : null
    active.push({
      attemptId: attempt.id, childId,
      hostState: childId === null ? 'unknown'
        : liveIds.has(childId) ? 'running' : settledIds.has(childId) ? 'stopped' : 'unknown',
      lastActivityAt: await lastActivity(course, attempt),
    })
  }
  const maximum = typeof ledger.max_attempts === 'number' ? ledger.max_attempts : 3
  const readyUnits = rows(ledger.sources).flatMap(source => rows(source.units)).filter(unit =>
    unit.processing_route === 'vision' && unit.blocked !== true
    && ['pending', 'failed', 'unresolved'].includes(String(unit.status))
    && (typeof unit.attempt_count === 'number' ? unit.attempt_count : 0) < maximum).length
  return { active, readyUnits }
}

async function persistStatus(course: string, status: CourseWatchdogStatus): Promise<void> {
  const directory = join(course, '_工作区')
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.内置看门狗-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(status, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, join(directory, '内置看门狗.json'))
  } finally { await rm(temporary, { force: true }) }
}

/** Deployment-configured health check timing. */
export interface CourseWatchdogPolicy {
  readonly intervalMs: number
  readonly silentMs: number
}

/** One Host-owned watchdog per active transcription course. */
export class CourseWatchdogService {
  private readonly active = new Map<string, CourseWatchdog>()
  private readonly settledIds = new Set<string>()

  constructor(private readonly ctx: Context, private readonly policy: CourseWatchdogPolicy) {
    ctx.on('subagent/end', ({ id }) => {
      if (this.active.size === 0) return
      this.settledIds.add(id)
      for (const watchdog of this.active.values()) {
        void watchdog.memberSettled().catch((error: unknown) => { console.error('course watchdog:', error) })
      }
    })
    ctx.effect(() => async () => { await Promise.all([...this.active.values()].map(item => item.stop())) })
  }

  /** Begin timed checks after a transcription stage starts. */
  start(course: string): Promise<CourseWatchdogStatus> {
    let watchdog = this.active.get(course)
    if (watchdog === undefined) {
      watchdog = new CourseWatchdog(
        () => inspectCourseAttempts(course, new Set(this.ctx.agents.list().map(agent => agent.id)), this.settledIds),
        status => persistStatus(course, status), this.policy.intervalMs, this.policy.silentMs,
      )
      this.active.set(course, watchdog)
    }
    return watchdog.start()
  }

  /** Stop timer checks once the stage is paused or validated. */
  async stop(course: string): Promise<void> {
    const watchdog = this.active.get(course)
    this.active.delete(course)
    await watchdog?.stop()
    if (this.active.size === 0) this.settledIds.clear()
  }

  /** Return a fresh health snapshot without mutating script leases. */
  check(course: string): Promise<CourseWatchdogStatus> {
    const watchdog = this.active.get(course)
    if (watchdog !== undefined) return watchdog.check()
    const temporary = new CourseWatchdog(
      () => inspectCourseAttempts(course, new Set(this.ctx.agents.list().map(agent => agent.id)), this.settledIds),
      status => persistStatus(course, status), this.policy.intervalMs, this.policy.silentMs,
    )
    return temporary.check()
  }
}
