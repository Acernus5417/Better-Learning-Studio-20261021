import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CourseLibrary } from '../src/course-library.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bls-course-'))
  roots.push(root)
  let workspace = 0,
    session = 0
  const calls: { path: string; name: string }[] = []
  const workspaces = new Map<string, WorkspaceId>(),
    sessions = new Set<SessionId>()
  const library = new CourseLibrary(join(root, 'course'), {
    workspace: async (path, name) => {
      const existing = workspaces.get(path)
      if (existing !== undefined) return existing
      calls.push({ path, name })
      const id = `workspace-${++workspace}` as WorkspaceId
      workspaces.set(path, id)
      return id
    },
    session: async () => {
      const id = `session-${++session}` as SessionId
      sessions.add(id)
      return id
    },
    sessionValid: async id => sessions.has(id),
  })
  return { root, library, calls }
}
describe('managed course library', () => {
  it('projects only the selected course with resolved aliases, tags and optional attachments', async () => {
    const { root, library } = await fixture(),
      course = await library.create('图谱课程'),
      other = await library.create('其他课程')
    await library.createFile(course.id, '学习文档/A.md', false)
    await library.createFile(course.id, '学习文档/B.md', false)
    await library.createFile(other.id, 'foreign-secret.md', false)
    await mkdir(join(root, 'course', course.id, '附件'), { recursive: true })
    await writeFile(join(root, 'course', course.id, '附件', '图.png'), 'fixture')
    await writeFile(join(root, 'course', course.id, '_工作区', 'prompt.md'), 'PRIVATE_PROMPT')
    const file = await library.read(course.id, '学习文档/A.md')
    await library.save(
      course.id,
      file.path,
      '---\ntags: [Physics]\n---\n\n# A\n\n[[B|下一讲]] [[不存在]] ![[附件/图.png]] [[_工作区/prompt]] #review',
      file.version,
    )
    const graph = await library.graph(course.id),
      a = graph.notes.find(note => note.path === '学习文档/A.md')
    expect([...(a?.tags ?? [])].sort()).toEqual(['Physics', 'review'])
    expect(a?.links).toEqual(
      expect.arrayContaining([
        { target: '学习文档/B.md', resolved: true },
        { target: '不存在', resolved: false },
        { target: '附件/图.png', resolved: true },
      ]),
    )
    expect(graph.notes.find(note => note.path === '附件/图.png')?.isAttachment).toBe(true)
    expect(a?.links.some(link => link.target.includes('_工作区'))).toBe(false)
    expect(
      graph.notes.some(
        note => note.path.includes('foreign') || note.path.includes('_工作区') || note.path.startsWith('.'),
      ),
    ).toBe(false)
    expect(JSON.stringify(graph)).not.toContain('PRIVATE_PROMPT')
  })
  it('copies arbitrary course layouts, keeps the source intact and creates independent identities', async () => {
    const { root, library } = await fixture()
    const source = join(root, '任意课程')
    await mkdir(join(source, '讲义/任意层级'), { recursive: true })
    await mkdir(join(source, '.studio'), { recursive: true })
    await mkdir(join(source, '_工作区'), { recursive: true })
    await mkdir(join(source, '.assets'), { recursive: true })
    await writeFile(join(source, '.assets/picture.png'), 'image-bytes')
    await writeFile(join(source, '_工作区/生成进度.json'), JSON.stringify({ session: 'foreign-session' }))
    await writeFile(
      join(source, '.studio/course.json'),
      JSON.stringify({ id: 'foreign', learningSessionId: 'foreign-session' }),
    )
    await writeFile(join(source, '讲义/任意层级/介绍.MD'), '# Imported course\n\n[[另一篇]]')
    const preview = await library.inspectImport(source)
    expect(preview).toMatchObject({ name: '任意课程', markdown: 1 })
    const first = await library.importCourse(source),
      second = await library.importCourse(source)
    expect(first.imported).toBe(true)
    expect(first.id).not.toBe(second.id)
    expect(first.workspaceId).not.toBe(second.workspaceId)
    expect(first.learningSessionId).toBeUndefined()
    await expect(library.read(first.id, '.STUDIO/learning/private.md')).rejects.toThrow('Invalid course-relative path')
    expect(await readFile(join(library.root, first.id, '.studio/imported-workspace/生成进度.json'), 'utf8')).toContain(
      'foreign-session',
    )
    expect(await readdir(join(library.root, first.id, '_工作区'))).toEqual([])
    expect(Buffer.from((await library.asset(first.id, '.assets/picture.png')).data).toString()).toBe('image-bytes')
    expect((await library.overview(first.id)).files.some(file => file.path === '.assets/picture.png')).toBe(true)
    await expect(library.read(first.id, '.studio/course.json')).rejects.toThrow('Invalid course-relative path')
    expect((await library.overview(first.id)).files.some(file => file.path === '讲义/任意层级/介绍.MD')).toBe(true)
    const imported = await library.read(first.id, '讲义/任意层级/介绍.MD')
    await library.save(first.id, imported.path, '# Independent copy', imported.version)
    expect(await readFile(join(source, '讲义/任意层级/介绍.MD'), 'utf8')).toContain('# Imported course')
    expect((await library.read(second.id, imported.path)).text).toContain('# Imported course')
  })
  it('rejects empty folders and importing the library into itself without publishing a course', async () => {
    const { root, library } = await fixture()
    const empty = join(root, 'empty')
    await mkdir(empty)
    await expect(library.importCourse(empty)).rejects.toMatchObject({ code: 'IMPORT_MARKDOWN' })
    await expect(library.importCourse(root)).rejects.toMatchObject({ code: 'IMPORT_DIRECTORY' })
    expect(await library.list()).toEqual([])
  })
  it('rejects directory junctions instead of copying files outside the chosen folder', async () => {
    const { root, library } = await fixture()
    const source = join(root, 'source'),
      other = join(root, 'outside')
    await mkdir(source)
    await mkdir(other)
    await writeFile(join(source, 'intro.md'), '# intro')
    await symlink(other, join(source, 'external'), 'junction')
    await expect(library.importCourse(source)).rejects.toMatchObject({ code: 'IMPORT_LINK' })
    expect(await library.list()).toEqual([])
  })
  it('creates no starter note, appends per document, and makes retries idempotent', async () => {
    const { library } = await fixture()
    const course = await library.create('Notes')
    expect((await library.overview(course.id)).files.filter(file => file.path.startsWith('笔记/'))).toEqual([])
    await library.createFile(course.id, '学习文档/01-复数.md', false)
    const first = await library.appendNote(
      course.id,
      '学习文档/01-复数.md',
      '首条笔记',
      '11111111-1111-4111-8111-111111111111',
      ['answer-1'],
    )
    expect(first).toEqual({ path: '笔记/01-复数-笔记.md', created: true })
    await library.appendNote(course.id, '学习文档/01-复数.md', '后续笔记', '22222222-2222-4222-8222-222222222222', [
      'answer-2',
    ])
    await library.appendNote(course.id, '学习文档/01-复数.md', '后续笔记', '22222222-2222-4222-8222-222222222222', [
      'answer-2',
    ])
    const text = (await library.read(course.id, first.path)).text
    expect(text).toContain('首条笔记')
    expect(text.match(/后续笔记/gu)).toHaveLength(1)
    await library.createFile(course.id, '其他/01-复数.md', false)
    const other = await library.appendNote(
      course.id,
      '其他/01-复数.md',
      '另一讲',
      '33333333-3333-4333-8333-333333333333',
      ['answer-3'],
    )
    expect(other.path).not.toBe(first.path)
    expect((await library.read(course.id, first.path)).text).not.toContain('另一讲')
  })
  it('creates independent Workspaces even for duplicate names and keeps roles separate', async () => {
    const { library, calls } = await fixture()
    const a = await library.create('复变函数'),
      b = await library.create('复变函数')
    expect(a.id).not.toBe(b.id)
    expect(a.workspaceId).not.toBe(b.workspaceId)
    expect(calls.map(c => c.path)).toEqual([join(library.root, a.id), join(library.root, b.id)])
    const generate = await library.session(a.id, 'generation'),
      learn = await library.session(a.id, 'learning')
    expect(generate.sessionId).not.toBe(learn.sessionId)
    expect(await library.session(a.id, 'learning')).toEqual(learn)
    expect((await library.list()).length).toBe(2)
    expect((await library.overview(a.id)).files.some(f => f.path.startsWith('.studio'))).toBe(false)
  })
  it('guards stale saves and retains before-images', async () => {
    const { library } = await fixture()
    const course = await library.create('分析')
    const before = await library.read(course.id, '课程首页.md')
    const after = await library.save(course.id, before.path, '# 新讲义\n\n复变函数', before.version)
    expect(after.version).not.toBe(before.version)
    await expect(library.save(course.id, before.path, 'wrong', before.version)).rejects.toThrow('changed on disk')
    expect(await readFile(join(library.root, course.id, '.studio', 'revisions', before.version + '.md'), 'utf8')).toBe(
      before.text,
    )
  })
  it('rechecks the course role before reusing a Session and retains the previous binding', async () => {
    const { library } = await fixture()
    const course = await library.create('固定角色')
    const previous = await library.session(course.id, 'generation')
    const seen: string[] = []
    const fixed = new CourseLibrary(library.root, {
      workspace: async () => course.workspaceId,
      session: async (_workspace, role) => {
        seen.push('create:' + role)
        return 'fixed-generation' as SessionId
      },
      sessionValid: async (_session, _workspace, role) => {
        seen.push('check:' + role)
        return false
      },
    })
    const current = await fixed.session(course.id, 'generation')
    expect(current.sessionId).not.toBe(previous.sessionId)
    expect(seen).toEqual(['check:generation', 'create:generation'])
    const history = join(library.root, course.id, '.studio/learning/session-history')
    const records = await readdir(history)
    expect(records).toHaveLength(1)
    expect(await readFile(join(history, records[0] ?? ''), 'utf8')).toContain(previous.sessionId)
  })
  it('rebinds copied course files without reusing an unavailable Session from another profile', async () => {
    const { library } = await fixture()
    const course = await library.create('可移植课程')
    const previous = await library.session(course.id, 'generation')
    const rebound = new CourseLibrary(library.root, {
      workspace: async () => 'new-workspace' as WorkspaceId,
      session: async () => 'new-session' as SessionId,
      sessionValid: async () => false,
    })
    const current = await rebound.session(course.id, 'learning')
    expect(current.sessionId).not.toBe(previous.sessionId)
    const manifest = (await rebound.list())[0]!
    expect(manifest.workspaceId).toBe('new-workspace')
    expect(manifest.generationSessionId).toBeUndefined()
    expect((await rebound.read(course.id, '课程首页.md')).text).toContain('可移植课程')
    const ledger = join(library.root, course.id, '.studio', 'learning', 'session-history')
    expect(await readdir(ledger)).toHaveLength(1)
  })
  it('finds one-, two- and three-character Chinese queries literally', async () => {
    const { library } = await fixture()
    const course = await library.create('数学')
    const before = await library.read(course.id, '课程首页.md')
    await library.save(course.id, before.path, '# 复变函数\n\n研究复数乘法以及 100% 置信。', before.version)
    for (const query of ['变', '变函', '复变函', '100%'])
      expect((await library.search(course.id, query)).map(r => r.path)).toContain('课程首页.md')
    expect(await library.search(course.id, '不存在')).toEqual([])
  })
  it('persists versioned selections and rejects stale or out-of-range quotes', async () => {
    const { library } = await fixture()
    const course = await library.create('引用')
    const doc = await library.read(course.id, '课程首页.md')
    const quote = await library.quote(course.id, doc.path, doc.version, 2, 4)
    expect(quote.text).toBe(doc.text.slice(2, 4))
    expect(
      JSON.parse(
        await readFile(join(library.root, course.id, '.studio', 'learning', 'quotes', quote.id + '.json'), 'utf8'),
      ),
    ).toEqual(quote)
    expect((await library.savedQuote(course.id, quote.id)).current).toBe(true)
    await library.save(course.id, doc.path, 'changed', doc.version)
    const historical = await library.savedQuote(course.id, quote.id)
    expect(historical.current).toBe(false)
    expect(historical.snapshot).toBe(doc.text)
    expect(historical.quote).toEqual(quote)
    await expect(library.quote(course.id, doc.path, doc.version, 0, 1)).rejects.toThrow('stale')
    await expect(
      library.quote(course.id, doc.path, (await library.read(course.id, doc.path)).version, 0, 999),
    ).rejects.toThrow('Invalid')
    expect(
      await readFile(join(library.root, course.id, '.studio', 'learning', 'sources', doc.version + '.md'), 'utf8'),
    ).toBe(doc.text)
  })
  it('previews rename effects, rejects stale plans and updates links without touching code examples', async () => {
    const { library } = await fixture()
    const course = await library.create('链接')
    await library.createFile(course.id, '讲义/定义.md', false)
    const page = await library.read(course.id, '课程首页.md')
    await library.save(course.id, page.path, '# 首页\n\n[[讲义/定义#概念|定义]]\n\n`[[讲义/定义]]`\n', page.version)
    const plan = await library.renameFile(course.id, '讲义/定义.md', '讲义/新定义.md', false)
    expect(plan.affected).toEqual(['课程首页.md'])
    await expect(library.renameFile(course.id, '讲义/定义.md', '讲义/新定义.md', true, 'stale')).rejects.toThrow(
      'stale',
    )
    await library.renameFile(course.id, '讲义/定义.md', '讲义/新定义.md', true, plan.token)
    const after = await library.read(course.id, page.path)
    expect(after.text).toContain('[[讲义/新定义#概念|定义]]')
    expect(after.text).toContain('`[[讲义/定义]]`')
    expect((await library.links(course.id)).find(l => l.target === '讲义/新定义')?.path).toBe('讲义/新定义.md')
  })
  it('repairs outbound relative links when moving a document', async () => {
    const { library } = await fixture()
    const course = await library.create('移动')
    await library.createFile(course.id, '讲义/第一章.md', false)
    await library.createFile(course.id, '讲义/定义.md', false)
    const doc = await library.read(course.id, '讲义/第一章.md')
    await library.save(course.id, doc.path, '[定义](定义.md)', doc.version)
    const plan = await library.renameFile(course.id, doc.path, '笔记/第一章.md', false)
    await library.renameFile(course.id, doc.path, '笔记/第一章.md', true, plan.token)
    expect((await library.read(course.id, '笔记/第一章.md')).text).toBe(
      '[定义](../%E8%AE%B2%E4%B9%89/%E5%AE%9A%E4%B9%89.md)',
    )
  })
  it('rejects cross-course paths, hidden metadata and directory junctions', async () => {
    const { root, library } = await fixture()
    const course = await library.create('边界')
    for (const path of [
      '../escape.md',
      '.studio/course.json',
      'C:/secret.md',
      '讲义/../../secret.md',
      'x\\y.md',
      'CON.md',
    ])
      await expect(library.read(course.id, path)).rejects.toThrow()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(outside, join(library.root, course.id, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(library.read(course.id, 'junction/secret.md')).rejects.toThrow('Symbolic')
    expect((await library.overview(course.id)).files.some(f => f.path.includes('secret'))).toBe(false)
  })
  it('moves deletions into recoverable local trash', async () => {
    const { library } = await fixture()
    const course = await library.create('回收')
    const before = await library.read(course.id, '课程首页.md')
    await library.trash(course.id, before.path)
    await expect(library.read(course.id, before.path)).rejects.toThrow()
    const trash = join(library.root, course.id, '.studio', 'trash')
    const entries = await readdir(trash)
    expect(await readFile(join(trash, entries[0]!, 'content'), 'utf8')).toBe(before.text)
  })
})
