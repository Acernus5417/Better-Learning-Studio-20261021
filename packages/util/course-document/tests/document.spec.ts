import { describe, expect, it } from 'vitest'
import { parseCourseDocument, resolveCourseLink } from '../src/index.ts'

describe('course Markdown semantics', () => {
  it('indexes wiki links with aliases, anchors and exact target offsets', () => {
    const source = '# 复变函数\n\n读 [[讲义/复数#定义|复数概念]] 和 ![[图片.png]]。\n'
    const doc = parseCourseDocument(source)
    expect(doc.links.map(l => [l.target, l.anchor, l.embed])).toEqual([
      ['讲义/复数', '定义', false],
      ['图片.png', '', true],
    ])
    for (const link of doc.links) expect(source.slice(link.start, link.end)).toBe(link.target)
    expect(doc.headings).toEqual([{ text: '复变函数', depth: 1, start: 0, end: 6 }])
  })
  it('ignores fenced code, inline code, escaped brackets and comments', () => {
    const doc = parseCourseDocument(
      '`[[inline]]`\n\n```md\n[[code]]\n```\n\n\\[[escaped]] %%[[hidden]]%% [[visible]]\n',
    )
    expect(doc.links.map(l => l.target)).toEqual(['visible'])
  })
  it('retains frontmatter, blocks, GFM tables and math positions', () => {
    const source =
      '---\naliases: [复数, complex]\nunknown:\n  x: 2\n---\n\n# 数\n\n定义 $a+bi$。 ^def\n\n|a|b|\n|-|-|\n|1|2|\n'
    const doc = parseCourseDocument(source)
    expect(doc.properties).toMatchObject({ aliases: ['复数', 'complex'], unknown: { x: 2 } })
    expect(doc.blocks.map(b => b.id)).toEqual(['def'])
    expect(doc.nodes.some(n => n.type === 'table')).toBe(true)
    expect(source.slice(doc.blocks[0]!.start, doc.blocks[0]!.end)).toContain('^def')
  })
  it('hides multiline comments without indexing links across paragraphs', () => {
    const source = 'Before %% secret\n\n[[hidden]]\n\nsecret %% [[shown]]\n\n`%%literal%%`'
    const doc = parseCourseDocument(source)
    expect(doc.links.map(l => l.target)).toEqual(['shown'])
    expect(JSON.stringify(doc.nodes)).not.toContain('[[hidden]]')
    expect(JSON.stringify(doc.nodes)).toContain('%%literal%%')
  })
  it('keeps UTF-16 offsets through astral characters and comment masks', () => {
    const source = '😀 %%🦊 hidden%% [[定义]]'
    const link = parseCourseDocument(source).links[0]!
    expect(source.slice(link.start, link.end)).toBe('定义')
  })
  it('reports malformed YAML without modifying the source', () => {
    const doc = parseCourseDocument('---\na: [broken\n---\n\nBody')
    expect(doc.propertyError).toBeDefined()
  })
  it('extracts standard Markdown destinations without treating external URLs as local links', () => {
    const source = '[章节](../讲义/复数.md#定义) [网站](https://example.com/a)'
    const links = parseCourseDocument(source).links
    expect(links).toHaveLength(1)
    expect(source.slice(links[0]!.start, links[0]!.end)).toBe('../讲义/复数.md')
  })
  it('resolves current-note anchors, root paths and unambiguous basenames', () => {
    const paths = ['讲义/复数.md', '笔记/练习.md']
    expect(resolveCourseLink('笔记/练习.md', '复数', paths).path).toBe('讲义/复数.md')
    expect(resolveCourseLink('笔记/练习.md', '../讲义/复数.md', paths).path).toBe('讲义/复数.md')
    expect(resolveCourseLink('笔记/练习.md', '', paths).path).toBe('笔记/练习.md')
  })
  it('refuses traversal and exposes duplicate basename ambiguity', () => {
    const paths = ['a/定义.md', 'b/定义.md']
    expect(resolveCourseLink('首页.md', '定义', paths)).toEqual({ ambiguous: paths })
    expect(resolveCourseLink('首页.md', '../../other.md', paths).path).toBeUndefined()
    expect(resolveCourseLink('首页.md', 'javascript:alert(1)', paths).path).toBeUndefined()
  })
})
