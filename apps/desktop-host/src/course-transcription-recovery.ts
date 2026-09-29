/** Reconcile stopped DSH attempts before resuming an interrupted transcription. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MaterialsCommand } from './course-transcription-batch.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface RecoveryResult {
  readonly recovered: readonly string[]
  readonly released: readonly string[]
}

/** A missing child ID is a stopped child only within this Host's process-owned DSH roster. */
export async function recoverStoppedCourseAttempts(
  course: string, liveChildIds: ReadonlySet<string>, batchActive: boolean, command: MaterialsCommand,
): Promise<RecoveryResult> {
  if (batchActive) throw new Error('course recovery: an in-process batch is still active')
  let raw: unknown
  try { raw = JSON.parse(await readFile(join(course, '_工作区', '转写任务.json'), 'utf8')) }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') return { recovered: [], released: [] }
    throw error
  }
  if (!record(raw) || !Array.isArray(raw.attempts)) throw new Error('course recovery: invalid attempt ledger')
  const active = raw.attempts.filter((item: unknown) => record(item)
    && ['reserved', 'running', 'produced'].includes(String(item.state))) as Record<string, unknown>[]
  for (const attempt of active) {
    if (typeof attempt.id !== 'string' || attempt.host !== 'dsh'
      || (attempt.state !== 'reserved' && typeof attempt.host_agent_id !== 'string')) {
      throw new Error('course recovery: unsupported active attempt; inspect it before resuming')
    }
    if (typeof attempt.host_agent_id === 'string' && liveChildIds.has(attempt.host_agent_id)) {
      throw new Error(`course recovery: child ${attempt.host_agent_id} is still active`)
    }
  }
  const recovered: string[] = []
  const released: string[] = []
  for (const attempt of active) {
    const id = attempt.id as string
    if (attempt.state === 'reserved') {
      await command(course, ['fail-attempt', '--attempt', id, '--kind', 'SPAWN_FAILURE'])
      released.push(id)
    } else {
      await command(course, ['recover', '--attempt', id, '--stopped-agent-id', attempt.host_agent_id as string])
      recovered.push(id)
    }
  }
  return { recovered, released }
}
