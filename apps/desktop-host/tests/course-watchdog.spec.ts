import { afterEach, describe, expect, it, vi } from 'vitest'
import { CourseWatchdog, type CourseWatchdogStatus } from '../src/course-watchdog.ts'

afterEach(() => { vi.useRealTimers() })

describe('Host course watchdog', () => {
  it('checks on child settlement immediately and flags silence without changing attempts', async () => {
    vi.useFakeTimers()
    const published: CourseWatchdogStatus[] = []
    const attempts = [{ attemptId: 'A-1', childId: 'child-1', hostState: 'running' as const, lastActivityAt: 0 }]
    const inspect = vi.fn(async () => ({ active: attempts, readyUnits: 2 }))
    const watchdog = new CourseWatchdog(inspect, status => { published.push(status) }, 90_000, 900_000, () => Date.now())
    try {
      expect((await watchdog.start()).activeCount).toBe(1)
      await vi.advanceTimersByTimeAsync(990_001)
      expect(published.at(-1)?.silentAttemptIds).toEqual(['A-1'])
      attempts[0].lastActivityAt = Date.now()
      expect((await watchdog.memberSettled()).silentAttemptIds).toEqual([])
      expect(attempts).toEqual([{ attemptId: 'A-1', childId: 'child-1', hostState: 'running', lastActivityAt: Date.now() }])
    } finally { await watchdog.stop() }
  })

  it('separates confirmed stopped children from unknown host state', async () => {
    const watchdog = new CourseWatchdog(async () => ({ active: [
      { attemptId: 'A-1', childId: 'child-1', hostState: 'stopped', lastActivityAt: 0 },
      { attemptId: 'A-2', childId: null, hostState: 'unknown', lastActivityAt: 0 },
    ], readyUnits: 0 }), () => undefined, 90_000, 900_000, () => 1_000_000)
    expect(await watchdog.check()).toMatchObject({ stoppedAttemptIds: ['A-1'], unknownAttemptIds: ['A-2'], silentAttemptIds: [] })
  })

  it('does not overlap a slow inspector and releases its timer on stop', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const inspect = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { active: [], readyUnits: 0 }
    })
    const watchdog = new CourseWatchdog(inspect, () => undefined, 100, 900_000)
    const first = watchdog.start()
    await vi.advanceTimersByTimeAsync(300)
    expect(inspect).toHaveBeenCalledTimes(1)
    release?.()
    await first
    await watchdog.stop()
    await vi.advanceTimersByTimeAsync(300)
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})
