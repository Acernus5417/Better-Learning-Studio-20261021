import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CourseWatchdogService, inspectCourseAttempts } from '../src/course-watchdog-service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('course attempt health', () => {
  it('wakes the parent once for an unchanged silent visual attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-watchdog-ledger-'))
    roots.push(root)
    await mkdir(join(root, '_工作区'))
    await writeFile(join(root, '_工作区', '转写任务.json'), JSON.stringify({
      attempts: [{ id: 'A-1', state: 'running', host_agent_id: 'child-live', started_at: '2020-01-01T00:00:00Z' }],
      sources: [],
    }))
    const notices: unknown[] = []
    const parent = { id: 'parent', followup: (message: unknown) => { notices.push(message) } }
    const ctx = {
      agents: { list: () => [{ id: 'child-live' }, parent], get: (id: string) => id === 'parent' ? parent : undefined },
      on: () => () => undefined,
      effect: () => undefined,
    }
    const service = new CourseWatchdogService(ctx as never, { intervalMs: 60_000, silentMs: 1 })
    try {
      expect((await service.start(root, parent as never)).silentAttemptIds).toEqual(['A-1'])
      expect(notices).toHaveLength(1)
      await service.check(root)
      expect(notices).toHaveLength(1)
      expect(JSON.stringify(notices[0])).toContain('A-1')
    } finally { await service.stop(root) }
  })

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

  it('notifies once about an unclosed stopped attempt after its owner batch ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-watchdog-ledger-'))
    roots.push(root)
    await mkdir(join(root, '_工作区'))
    await writeFile(join(root, '_工作区', '转写任务.json'), JSON.stringify({
      attempts: [{ id: 'A-9', state: 'produced', host_agent_id: 'child-ended', started_at: '2026-09-29T00:00:00Z' }],
      sources: [],
    }))
    const notices: unknown[] = []
    const parent = { id: 'parent', followup: (message: unknown) => { notices.push(message) } }
    let settled: ((event: { id: string }) => void) | undefined
    let batchActive = true
    const ctx = {
      agents: { list: () => [parent], get: (id: string) => id === 'parent' ? parent : undefined },
      on: (_name: string, listener: (event: { id: string }) => void) => { settled = listener; return () => undefined },
      effect: () => undefined,
    }
    const service = new CourseWatchdogService(ctx as never, { intervalMs: 60_000, silentMs: 900_000 },
      () => batchActive)
    try {
      await service.start(root, parent as never)
      settled?.({ id: 'child-ended' })
      await service.check(root)
      expect(notices).toHaveLength(0)
      batchActive = false
      await service.check(root)
      await service.check(root)
      expect(notices).toHaveLength(1)
      expect(JSON.stringify(notices[0])).toContain('stopped:A-9')
    } finally { await service.stop(root) }
  })
})
