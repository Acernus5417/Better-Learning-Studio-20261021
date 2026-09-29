import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectCourseAttempts } from '../src/course-watchdog-service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('course attempt health', () => {
  it('joins durable attempt ids with actual live and settled child ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-watchdog-ledger-'))
    roots.push(root)
    await mkdir(join(root, '_工作区'))
    await writeFile(join(root, '_工作区', '转写任务.json'), JSON.stringify({
      max_attempts: 3,
      attempts: [
        { id: 'A-1', state: 'running', host_agent_id: 'child-live', started_at: '2026-09-29T00:00:00Z' },
        { id: 'A-2', state: 'produced', host_agent_id: 'child-ended', started_at: '2026-09-29T00:00:00Z' },
        { id: 'A-3', state: 'reserved', host_agent_id: null, reserved_at: '2026-09-29T00:00:00Z' },
      ],
      sources: [{ units: [
        { processing_route: 'vision', status: 'failed', attempt_count: 1 },
        { processing_route: 'deterministic_text', status: 'pending', attempt_count: 0 },
        { processing_route: 'vision', status: 'failed', attempt_count: 3 },
      ] }],
    }))
    const status = await inspectCourseAttempts(root, new Set(['child-live']), new Set(['child-ended']))
    expect(status.readyUnits).toBe(1)
    expect(status.active.map(item => [item.attemptId, item.hostState])).toEqual([
      ['A-1', 'running'], ['A-2', 'stopped'], ['A-3', 'unknown'],
    ])
  })
})
