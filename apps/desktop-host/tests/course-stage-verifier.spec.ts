import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCourseStageVerifier, inspectCoursePlan, runCourseInventory } from '../src/course-stage-verifier.ts'

const roots: string[] = []
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
