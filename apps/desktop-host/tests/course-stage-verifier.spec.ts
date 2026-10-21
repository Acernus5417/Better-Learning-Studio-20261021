import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createCourseStageVerifier, inspectCoursePlan, runCourseInventory, runCourseScript } from '../src/course-stage-verifier.ts'

const roots: string[] = []
const execute = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Host course stage verifier', () => {
  it('accepts material evidence only while every recorded source hash still matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-stage-gate-'))
    roots.push(root)
    const source = join(root, 'input.pdf')
    await writeFile(source, 'original bytes')
    const hash = createHash('sha256').update(await readFile(source)).digest('hex')
    await mkdir(join(root, '_工作区'))
    await writeFile(join(root, '_工作区', '资料索引.json'), JSON.stringify({ sources: [
      { id: 'SRC-001', path: source, sha256: hash },
    ] }))
    const verify = createCourseStageVerifier({ python: join(root, 'unused-python'), scripts: join(root, 'unused-scripts') })
    expect(await verify(root, 'materials', null)).toMatchObject({ summary: '已核对 1 份原始资料' })
    await writeFile(source, 'changed bytes')
    expect(await verify(root, 'materials', null)).toBeNull()
  })

  it('does not accept a missing material index as an empty course', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-stage-gate-'))
    roots.push(root)
    const verify = createCourseStageVerifier({ python: join(root, 'unused-python'), scripts: join(root, 'unused-scripts') })
    expect(await verify(root, 'materials', null)).toBeNull()
  })

  it.skipIf(!process.env.BLS_WORKFLOW_SMOKE_PYTHON)('runs the bundled inventory with UTF-8 paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-stage-gate-'))
    roots.push(root)
    const course = join(root, '课程')
    const materials = join(root, '资料')
    await mkdir(course)
    await mkdir(materials)
    await writeFile(join(materials, '讲义.txt'), '一个概念')
    const result = await runCourseInventory({
      python: process.env.BLS_WORKFLOW_SMOKE_PYTHON!,
      scripts: join(process.cwd(), 'apps', 'desktop', 'resources', 'workflows', 'better-learning', 'scripts'),
    }, course, [materials])
    expect(result.sources).toBe(1)
    const index = JSON.parse(await readFile(join(course, '_工作区', '资料索引.json'), 'utf8')) as {
      sources: { name: string }[]
    }
    expect(index.sources[0]?.name).toBe('讲义.txt')
  }, 120_000)

  it.skipIf(!process.env.BLS_WORKFLOW_SMOKE_PYTHON)('resolves actual templates and rejects unassigned knowledge through the Host script runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-teaching-gate-'))
    roots.push(root)
    await mkdir(join(root, '_工作区'))
    const runtime = { python: process.env.BLS_WORKFLOW_SMOKE_PYTHON!,
      scripts: join(process.cwd(), 'apps/desktop/resources/workflows/better-learning/scripts') }
    expect(await runCourseScript(runtime, root, 'studio_teaching_design.py', ['resolve']))
      .toMatchObject({ configured: false, lesson: { selection: { subject: 'generic' } } })
    await expect(runCourseScript(runtime, root, 'studio_teaching_design.py', ['validate', '--require-config']))
      .rejects.toThrow('教学设计.json')
    const config = { schema_version: 1, default: { subject: 'history', modules: ['text-evidence'] },
      lessons: { 'L-01': { knowledge_overrides: { 'K-01': { subject: 'philosophy' } } } } }
    await writeFile(join(root, '_工作区/教学设计.json'), JSON.stringify(config))
    await writeFile(join(root, '_工作区/章节索引.json'), JSON.stringify({ lessons: [{ id: 'L-01' }, { id: 'L-02' }] }))
    const index = join(root, '_工作区/知识索引.jsonl')
    await writeFile(index, JSON.stringify({ id: 'K-01', lesson_ids: ['L-02'], status: 'verified' }) + '\n')
    await expect(runCourseScript(runtime, root, 'studio_teaching_design.py', ['resolve']))
      .rejects.toThrow('not assigned')
    await writeFile(index, JSON.stringify({ id: 'K-01', lesson_ids: ['L-01'], status: 'verified' }) + '\n')
    const resolved = await runCourseScript(runtime, root, 'studio_teaching_design.py', ['resolve', '--lesson', 'L-01'])
    expect(resolved).toMatchObject({ configured: true, lesson: { selection: { subject: 'history' } },
      knowledge: { 'K-01': { selection: { subject: 'philosophy' } } } })
    expect(await runCourseScript(runtime, root, 'studio_teaching_design.py', ['validate', '--require-config']))
      .toMatchObject({ ok: true, configured: true, lessons: 2 })
  }, 120_000)

  it.skipIf(!process.env.BLS_WORKFLOW_SMOKE_PYTHON)('blocks native knowledge and path completion until teaching choices are valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-teaching-stage-'))
    roots.push(root)
    const runtime = { python: process.env.BLS_WORKFLOW_SMOKE_PYTHON!,
      scripts: join(process.cwd(), 'apps/desktop/resources/workflows/better-learning/scripts') }
    await execute(runtime.python, ['-X', 'utf8', '-c', [
      'import sys', 'from pathlib import Path',
      'sys.path[:0] = sys.argv[2:4]',
      'from course_fixture import V2Tests',
      'fixture = V2Tests(); fixture.root = Path(sys.argv[1]); fixture.course = fixture.root / "course"',
      'fixture.knowledge(1)',
    ].join('\n'), root, runtime.scripts, join(process.cwd(), 'apps/desktop-host/tests/python')], {
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
    })
    const course = join(root, 'course')
    const verify = createCourseStageVerifier(runtime)
    expect(await verify(course, 'knowledge', null)).toBeNull()
    const config = join(course, '_工作区/教学设计.json')
    await writeFile(config, JSON.stringify({ schema_version: 1, default: { subject: 'history' } }))
    expect(await verify(course, 'knowledge', null)).not.toBeNull()
    expect(await verify(course, 'path', null)).not.toBeNull()
    await writeFile(config, JSON.stringify({ schema_version: 1, default: { subject: 'history' },
      lessons: { 'L-01': { knowledge_overrides: { 'K-99': { mode: 'exam' } } } } }))
    expect(await verify(course, 'knowledge', null)).toBeNull()
    expect(await verify(course, 'path', null)).toBeNull()
  }, 120_000)

  it.skipIf(!process.env.BLS_WORKFLOW_SMOKE_PYTHON)('gates native paths on teaching units and keeps explicit legacy compatibility', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bls-unit-stage-'))
    roots.push(root)
    const runtime = { python: process.env.BLS_WORKFLOW_SMOKE_PYTHON!,
      scripts: join(process.cwd(), 'apps/desktop/resources/workflows/better-learning/scripts') }
    await execute(runtime.python, ['-X', 'utf8', '-c', [
      'import sys', 'from pathlib import Path', 'sys.path[:0] = sys.argv[2:4]',
      'from course_fixture import V2Tests',
      'fixture = V2Tests(); fixture.root = Path(sys.argv[1]); fixture.course = fixture.root / "course"',
      'fixture.knowledge(2)',
    ].join('\n'), root, runtime.scripts, join(process.cwd(), 'apps/desktop-host/tests/python')], {
      windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
    })
    const course = join(root, 'course')
    await writeFile(join(course, '_工作区/教学设计.json'), JSON.stringify({ schema_version: 1, default: { subject: 'history' } }))
    const verify = createCourseStageVerifier(runtime)
    expect(await runCourseScript(runtime, course, 'studio_teaching_units.py', ['validate']))
      .toMatchObject({ ok: true, legacy_lessons: ['L-01', 'L-02'] })
    expect(await verify(course, 'path', null)).not.toBeNull()
    const config = { schema_version: 1, lessons: Object.fromEntries(['01', '02'].map(id => [`L-${id}`, {
      units: [{ id: 'TU-01', title: 'Use and check', knowledge_ids: [`K-${id}`], depth: 'standard',
        reason: 'One goal', goals: ['Use knowledge'], success_criteria: ['Explain result'], stop_when: ['Steps complete'] }],
    }])) }
    await writeFile(join(course, '_工作区/教学单元.json'), JSON.stringify(config))
    expect(await verify(course, 'path', null)).not.toBeNull()
    expect(await runCourseScript(runtime, course, 'studio_teaching_units.py', ['resolve', '--lesson', 'L-01']))
      .toMatchObject({ configured: true, units: [{ knowledge_ids: ['K-01'] }] })
    config.lessons['L-02']!.units[0]!.knowledge_ids = ['K-01']
    await writeFile(join(course, '_工作区/教学单元.json'), JSON.stringify(config))
    await expect(runCourseScript(runtime, course, 'studio_teaching_units.py', ['resolve', '--lesson', 'L-01']))
      .rejects.toThrow('Foreign/duplicate')
    expect(await verify(course, 'knowledge', null)).not.toBeNull()
    expect(await verify(course, 'path', null)).toBeNull()
  }, 120_000)

  it.skipIf(!process.env.BLS_WORKFLOW_SMOKE_COURSE || !process.env.BLS_WORKFLOW_SMOKE_PYTHON
    || !process.env.BLS_WORKFLOW_SMOKE_SCRIPTS)('validates a copied completed course with the bundled Python', async () => {
    const verify = createCourseStageVerifier({
      python: process.env.BLS_WORKFLOW_SMOKE_PYTHON!, scripts: process.env.BLS_WORKFLOW_SMOKE_SCRIPTS!,
    })
    const course = process.env.BLS_WORKFLOW_SMOKE_COURSE!
    expect((await inspectCoursePlan({
      python: process.env.BLS_WORKFLOW_SMOKE_PYTHON!, scripts: process.env.BLS_WORKFLOW_SMOKE_SCRIPTS!,
    }, course)).mode).toBe('plan')
    expect(await verify(course, 'materials', null)).not.toBeNull()
    expect(await verify(course, 'delivery', null)).not.toBeNull()
  }, 120_000)
})
