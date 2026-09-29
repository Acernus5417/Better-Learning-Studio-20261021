import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverSavedCourses, resolveRegisteredCourse } from '../src/course-workflow-api.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('course API directory selection', () => {
  it('accepts an existing course inside a registered workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    await mkdir(join(root, 'Course'))
    expect(await resolveRegisteredCourse([{ id: 'workspace-1', path: root }], 'workspace-1', 'Course'))
      .toBe(join(root, 'Course'))
  })

  it('refuses parent traversal, unknown workspaces, and files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    const workspaces = [{ id: 'workspace-1', path: root }]
    await writeFile(join(root, 'notes.md'), 'content')
    await expect(resolveRegisteredCourse(workspaces, 'workspace-1', '../outside')).rejects.toThrow('invalid relative')
    await expect(resolveRegisteredCourse(workspaces, 'workspace-1', 'nested/course')).rejects.toThrow('invalid relative')
    await expect(resolveRegisteredCourse(workspaces, 'other', '.')).rejects.toThrow('not registered')
    await expect(resolveRegisteredCourse(workspaces, 'workspace-1', 'notes.md')).rejects.toThrow('not a directory')
  })

  it('finds persisted native courses at workspace root and direct children for startup recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-course-api-'))
    roots.push(root)
    await mkdir(join(root, '_工作区'))
    await mkdir(join(root, 'Course', '_工作区'), { recursive: true })
    await writeFile(join(root, '_工作区', '内置工作流.json'), '{}')
    await writeFile(join(root, 'Course', '_工作区', '内置工作流.json'), '{}')
    expect(await discoverSavedCourses([{ path: root }])).toEqual([root, join(root, 'Course')])
  })
})
