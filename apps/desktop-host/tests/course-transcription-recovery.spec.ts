import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverStoppedCourseAttempts } from '../src/course-transcription-recovery.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function courseWithAttempts(attempts: unknown[]): Promise<string> {
  const course = await mkdtemp(join(tmpdir(), 'bls-recovery-'))
  directories.push(course)
  await mkdir(join(course, '_工作区'), { recursive: true })
  await writeFile(join(course, '_工作区', '转写任务.json'), JSON.stringify({ attempts }), 'utf8')
  return course
}

describe('stopped attempt recovery', () => {
  it('recovers stopped registered children and releases unregistered reservations', async () => {
    const course = await courseWithAttempts([
      { id: 'A-1', host: 'dsh', state: 'running', host_agent_id: 'ended-child' },
      { id: 'A-2', host: 'dsh', state: 'reserved', host_agent_id: null },
    ])
    const commands: string[][] = []
    const result = await recoverStoppedCourseAttempts(course, new Set(), false, async (_course, args) => {
      commands.push([...args]); return {}
    })
    expect(result).toEqual({ recovered: ['A-1'], released: ['A-2'] })
    expect(commands).toEqual([
      ['recover', '--attempt', 'A-1', '--stopped-agent-id', 'ended-child'],
      ['fail-attempt', '--attempt', 'A-2', '--kind', 'SPAWN_FAILURE'],
    ])
  })

  it('refuses every mutation while any registered child remains live', async () => {
    const course = await courseWithAttempts([
      { id: 'A-1', host: 'dsh', state: 'running', host_agent_id: 'ended-child' },
      { id: 'A-2', host: 'dsh', state: 'running', host_agent_id: 'live-child' },
    ])
    const commands: string[][] = []
    await expect(recoverStoppedCourseAttempts(course, new Set(['live-child']), false, async (_course, args) => {
      commands.push([...args]); return {}
    })).rejects.toThrow('still active')
    expect(commands).toEqual([])
  })
})
