import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CourseVisionProbeService } from '../src/course-vision-probe.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('native vision probe', () => {
  it('passes only the prompt to a fresh child and verifies its stopped ID', async () => {
    const course = await mkdtemp(join(tmpdir(), 'bls-probe-'))
    directories.push(course)
    await mkdir(join(course, '_工作区'), { recursive: true })
    await writeFile(join(course, '_工作区', 'prompt.txt'), 'read only the challenge image', 'utf8')
    const commands: string[][] = []
    let childPrompt = ''
    let disposed = false
    const service = new CourseVisionProbeService(
      async (_course, args) => {
        commands.push([...args])
        return args[0] === 'probe-start' ? { prompt: '_工作区/prompt.txt' } : { probe: 'passed' }
      },
      async (_parent, prompt) => {
        childPrompt = prompt
        return { childId: 'real-child-id', result: Promise.resolve({ stopReason: 'completed' }),
          dispose: async () => { disposed = true } } as never
      },
    )
    const result = await service.run(course, 'vision-model', { id: 'parent' } as never, new AbortController().signal)
    expect(result.probe).toBe('passed')
    expect(childPrompt).toBe('read only the challenge image')
    expect(disposed).toBe(true)
    expect(commands).toEqual([
      ['probe-start', '--host', 'dsh', '--model', 'vision-model'],
      ['probe', '--member', 'real-child-id', '--host', 'dsh', '--model', 'vision-model'],
    ])
  })
})
