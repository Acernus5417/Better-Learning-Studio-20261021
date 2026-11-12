import { describe, it, expect } from 'vitest'
import {
  parseCourseDocument,
  coursePlainText,
  presentationBlocks,
  presentationSignature,
  validatePresentationAnnotations,
  readCoursePresentation,
} from '../src/index.ts'

describe('course tables and semantic presentation', () => {
  it('keeps wiki-looking code and private Unicode literal inside table cells', () => {
    const source = '| a | b |\n| --- | --- |\n| x | `\uE000 [[literal|alias]]` |\n\n\uE000\n'
    const doc = parseCourseDocument(source)
    expect(doc.links).toEqual([])
    expect(doc.nodes[0]?.children?.[1]?.children).toHaveLength(2)
    expect(JSON.stringify(doc.nodes)).toContain('\uE000 [[literal|alias]]')
    expect(JSON.stringify(doc.nodes)).not.toContain('literal\uE000alias')
    expect(coursePlainText(parseCourseDocument('before %% [[hidden|alias]] %% after').nodes[0]!)).toBe('before  after')
  })
  it('keeps wiki aliases inside their original table cells with exact source targets', () => {
    const source =
      '| 字段 | 内容 |\n| --- | --- |\n| ID | KP-01 / [[课程文档/知识内容#^K-000001|七元素与反应触发条件]] |\n| 课程 | [[学习文档/01-元素反应地图#^L-001|元素反应地图]] |\n'
    const doc = parseCourseDocument(source),
      table = doc.nodes[0]!
    expect(table.type).toBe('table')
    expect(table.children?.map(row => row.children?.length)).toEqual([2, 2, 2])
    expect(coursePlainText(table)).toContain('七元素与反应触发条件')
    expect(doc.links.map(link => [link.target, link.anchor])).toEqual([
      ['课程文档/知识内容', '^K-000001'],
      ['学习文档/01-元素反应地图', '^L-001'],
    ])
    for (const link of doc.links) expect(source.slice(link.start, link.end)).toBe(link.target)
  })
  it('retains escaped table aliases and leaves literal code/comments inert', () => {
    const source = '| a | b |\n| - | - |\n| x | [[文档\\|别名]] |\n\n`[[literal|code]]`\n\n%% [[hidden|alias]] %%\n'
    const doc = parseCourseDocument(source)
    expect(doc.links.map(link => link.target)).toEqual(['文档'])
    expect(JSON.stringify(doc.nodes)).toContain('[[literal|code]]')
    expect(doc.nodes[0]?.children?.[1]?.children).toHaveLength(2)
  })
  it('rejects source edits, navigation decoration, condition clipping and excess color', () => {
    const source = '# 定义\n\n只有满足条件，规则才成立。\n\n## 知识入口\n\n打开学习文档。\n'
    const blocks = presentationBlocks(source),
      target = blocks.find(block => !block.protected)!
    const annotation = {
      id: 'a1',
      block: target.id,
      quote: '规则才成立',
      role: 'conclusion',
      emphasis: 'bold',
      evidence: '本节条件判断',
    }
    expect(() => validatePresentationAnnotations([annotation], blocks, 'lesson')).toThrow('conditional')
    expect(() => validatePresentationAnnotations([{ ...annotation, quote: '改写原文' }], blocks, 'lesson')).toThrow(
      'quote',
    )
    const navigation = blocks.find(block => block.section === '知识入口')!
    expect(() =>
      validatePresentationAnnotations(
        [{ ...annotation, block: navigation.id, quote: navigation.text }],
        blocks,
        'lesson',
      ),
    ).toThrow('protected')
    expect(() =>
      validatePresentationAnnotations([{ ...annotation, quote: target.text, emphasis: 'highlight' }], blocks, 'lesson'),
    ).toThrow('budget')
  })
  it('rebinds through derived relation changes but invalidates edited teaching text', () => {
    const base = '# 定义\n\n边界是必要条件。\n\n<!-- BL-REL:BEGIN K-000001 -->\n旧关系\n<!-- BL-REL:END K-000001 -->\n'
    const blocks = presentationBlocks(base),
      target = blocks[0]!
    const plan = {
      schemaVersion: 1,
      profile: 'semantic-v1',
      kind: 'lesson',
      signature: presentationSignature(blocks),
      annotations: [
        {
          id: 'a1',
          block: target.id,
          quote: '必要条件',
          role: 'condition',
          emphasis: 'bold',
          evidence: '本节规则的适用边界',
        },
      ],
      decisions: [{ unit: target.unit, status: 'passed', reason: '原文完整保留' }],
    }
    expect(readCoursePresentation(plan, base.replace('旧关系', '新关系，改变了源偏移'))).toBeDefined()
    expect(readCoursePresentation(plan, base.replace('必要条件', '充分条件'))).toBeUndefined()
    expect(base).not.toContain('**')
  })
})
