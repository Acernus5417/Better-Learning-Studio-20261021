import { describe, expect, it } from 'vitest'
import { CourseTranscriptionBatchService } from '../src/course-transcription-batch.ts'

describe('native visual batch', () => {
  it('starts a whole batch, then collects each child only after its real terminal result', async () => {
    const commands: string[][] = []
    const resolvers = [Promise.withResolvers<{ stopReason: 'completed' }>(), Promise.withResolvers<{ stopReason: 'completed' }>()]
    const ended = Promise.withResolvers<undefined>()
    const bootstraps: string[] = []
    const disposed: string[] = []
    const parent = { id: 'parent' }
    const service = new CourseTranscriptionBatchService(
      async (_course, args) => {
        commands.push([...args])
        if (args[0] === 'pump') return { batch_no: 1, batch_open: false, blocked: null, tickets: [
          { attempt: 'A-1', bootstrap: 'read task one' }, { attempt: 'A-2', bootstrap: 'read task two' },
        ] }
        return args[0] === 'collect' ? { state: 'committed' } : { state: 'running' }
      },
      async (_parent, bootstrap) => {
        const index = bootstraps.push(bootstrap) - 1
        return { id: `child-${index + 1}`, result: resolvers[index]!.promise,
          dispose: async () => { disposed.push(`child-${index + 1}`) } } as never
      },
      (_parent, _course, outcomes) => {
        expect(outcomes).toEqual([{ attempt: 'A-1', outcome: 'complete' }, { attempt: 'A-2', outcome: 'complete' }])
        ended.resolve(undefined)
      },
    )
    const started = await service.start('/course', 'multimodal-model', parent as never, new AbortController().signal)
    expect(started.started).toHaveLength(2)
    expect(bootstraps).toEqual(['read task one', 'read task two'])
    expect(commands.filter(args => args[0] === 'collect')).toEqual([])
    resolvers[0]!.resolve({ stopReason: 'completed' })
    resolvers[1]!.resolve({ stopReason: 'completed' })
    await ended.promise
    expect(disposed).toHaveLength(2)
    expect(commands.filter(args => args[0] === 'collect')).toEqual([
      ['collect', '--attempt', 'A-1', '--stopped-agent-id', 'child-1'],
      ['collect', '--attempt', 'A-2', '--stopped-agent-id', 'child-2'],
    ])
    await service.stop()
  })

  it('releases a reservation only when member creation definitively failed', async () => {
    const commands: string[][] = []
    const service = new CourseTranscriptionBatchService(
      async (_course, args) => {
        commands.push([...args])
        return args[0] === 'pump'
          ? { batch_no: 1, batch_open: false, blocked: null, tickets: [{ attempt: 'A-1', bootstrap: 'task' }] }
          : { state: 'failed' }
      },
      async () => { throw new Error('provider rejected before publication') },
      () => { throw new Error('no child should settle') },
    )
    const result = await service.start('/course', 'model', { id: 'parent' } as never, new AbortController().signal)
    expect(result.failedToStart).toHaveLength(1)
    expect(commands.at(-1)).toEqual(['fail-attempt', '--attempt', 'A-1', '--kind', 'SPAWN_FAILURE'])
  })

  it('waits for startup and settlement when stopped during member creation', async () => {
    const childStarting = Promise.withResolvers<undefined>()
    const publish = Promise.withResolvers<never>()
    const commands: string[][] = []
    let notifications = 0
    const service = new CourseTranscriptionBatchService(
      async (_course, args) => {
        commands.push([...args])
        return args[0] === 'pump'
          ? { batch_no: 1, batch_open: false, blocked: null, tickets: [{ attempt: 'A-1', bootstrap: 'task' }] }
          : { state: 'committed' }
      },
      async () => { childStarting.resolve(undefined); return publish.promise },
      () => { notifications += 1 },
    )
    const start = service.start('/course', 'model', { id: 'parent' } as never, new AbortController().signal)
    await childStarting.promise
    const stop = service.stopCourse('/course')
    expect(service.hasActive('/course')).toBe(true)
    publish.resolve({ id: 'child', result: Promise.resolve({ stopReason: 'completed' }),
      dispose: async () => undefined } as never)
    await Promise.all([start, stop])
    expect(service.hasActive('/course')).toBe(false)
    expect(notifications).toBe(0)
    expect(commands.some(args => args[0] === 'mark-running')).toBe(true)
    expect(commands.some(args => args[0] === 'collect')).toBe(true)
  })
})
