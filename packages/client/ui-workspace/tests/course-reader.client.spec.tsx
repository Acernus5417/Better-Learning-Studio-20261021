// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CourseReader, type SelectedCourseText } from '../src/client/course/DocumentView.tsx'
import { parseCourseDocument, presentationBlocks, presentationSignature } from '@deepseek-ai/dsh-util-course-document'
import type { CoursePresentation } from '@deepseek-ai/dsh-util-course-document'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { zh } from '../src/client/course/locales.ts'
import type {} from '../src/client/course/apply.ts'
import { courseQuoteRule } from '../src/client/course/quotes.tsx'
import { serializeCourseQuote } from '@deepseek-ai/dsh-util-course-document'
import type { CourseId, CourseQuoteId } from '@deepseek-ai/dsh-util-course-document'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})
const t: TranslateNS<'course'> = key => (key in zh ? zh[key as keyof typeof zh] : key)
const useResource: PropsRuntime<'main'>['useResource'] = () => ({
  status: 'none',
  value: undefined,
  failure: undefined,
})
function fixture(source: string, presentation?: CoursePresentation) {
  const select = vi.fn<(range: SelectedCourseText | undefined) => void>(),
    open = vi.fn()
  const file = {
    path: '课程首页.md',
    text: source,
    version: 'version-1',
    document: parseCourseDocument(source),
    ...(presentation === undefined ? {} : { presentation }),
  }
  const result = render(
    <CourseReader
      id="course-1"
      file={file}
      files={[{ path: '课程首页.md', directory: false, bytes: source.length }]}
      t={t}
      useResource={useResource}
      open={open}
      select={select}
    />,
  )
  return { ...result, select, open }
}
describe('course reader source mapping', () => {
  it('renders two-column tables with clickable aliases rather than raw wiki fragments', () => {
    const source = '| 字段 | 内容 |\n| --- | --- |\n| 课程 | [[课程首页#定义|打开定义]] |\n'
    const view = fixture(source)
    expect(screen.getAllByRole('columnheader')).toHaveLength(2)
    expect(screen.getAllByRole('row')[1]?.children).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '打开定义' }))
    expect(view.open).toHaveBeenCalledWith('课程首页.md', '定义')
    expect(view.container.textContent).not.toContain('[[')
  })
  it('quotes exact text through model emphasis and defaults card answers/metadata to folded', () => {
    const source =
      '<!-- BL-KP:BEGIN KP-01 -->\n\n## 映射\n\nKP-01 ^KP-01\n\n| 字段 | 内容 |\n| --- | --- |\n| 别名 | 唯一输出 |\n\n### 检索提示\n\n描述映射规则。\n\n### 核对与纠错\n\n函数将输入映射到唯一输出。\n\n### 掌握度快照\n\n未接触。\n\n<!-- BL-KP:END KP-01 -->\n'
    const blocks = presentationBlocks(source),
      target = blocks.find(block => block.text.includes('函数将输入'))!
    const presentation: CoursePresentation = {
      schemaVersion: 1,
      profile: 'semantic-v1',
      kind: 'cards',
      signature: presentationSignature(blocks),
      annotations: [
        {
          id: 'a1',
          block: target.id,
          quote: '唯一输出',
          role: 'definition',
          emphasis: 'bold',
          evidence: '本卡核对原文的输出唯一性',
        },
      ],
      decisions: [...new Set(blocks.map(block => block.unit))].map(unit => ({
        unit,
        status: 'passed',
        reason: '定义完整保留',
      })),
    }
    const view = fixture(source, presentation)
    const answer = screen.getByRole('button', { name: '核对与纠错' }),
      metadata = screen.getByRole('button', { name: '卡片信息' })
    expect(answer.getAttribute('aria-expanded')).toBe('false')
    expect(metadata.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(answer)
    const emphasis = view.container.querySelector('strong')!
    const range = document.createRange()
    range.selectNodeContents(emphasis)
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(emphasis)
    const quote = view.select.mock.lastCall?.[0]
    expect(quote === undefined ? '' : source.slice(quote.start, quote.end)).toBe('唯一输出')
    expect(view.container.querySelectorAll('[data-learning-section]')).toHaveLength(0)
    expect({
      answers: answer.getAttribute('aria-expanded'),
      metadata: metadata.getAttribute('aria-expanded'),
      sourceQuote: quote === undefined ? '' : source.slice(quote.start, quote.end),
      annotations: view.container.querySelectorAll('strong').length,
    }).toMatchSnapshot()
  })
  it.each([
    '<details> <summary>展开答案与学习分支</summary>\n\n1. 答案正文\n\n</details>',
    '<details>\n<summary>展开答案与学习分支</summary>\n1. 答案正文\n</details>',
  ])('renders supported HTML disclosures as controls with mapped Markdown answers', (source) => {
    const view = fixture(source)
    const toggle = screen.getByRole('button', { name: '展开答案与学习分支' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).not.toContain('<details>')
    expect(view.container.textContent).not.toContain('<summary>')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const text = screen.getByText('答案正文')
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(text)
    const quote = view.select.mock.lastCall?.[0]
    expect(quote === undefined ? '' : source.slice(quote.start, quote.end)).toBe('答案正文')
  })
  it('retains nested disclosures, ignores executable attributes and leaves code examples literal', () => {
    const view = fixture(
      '<details open onclick="alert(1)"><summary>父层</summary>\n\n<details><summary>子层</summary>\n\n子正文\n\n</details>\n\n</details>\n\n```html\n<details><summary>代码示例</summary></details>\n```',
    )
    expect(screen.getByRole('button', { name: '父层' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '子层' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '代码示例' })).toBeNull()
    expect(view.container.querySelector('[onclick]')).toBeNull()
  })
  it('keeps knowledge-entry and learning-objective content plain while retaining existing remaining styles', () => {
    const view = fixture(
      '## 学习目标\n\n- 掌握条件\n\n## 小结\n\n核心结论。\n\n## 易错点\n\n注意顺序。\n\n> [!note]- 本节知识\n> 定义正文',
    )
    expect(
      Array.from(view.container.querySelectorAll('[data-learning-section]')).map(node =>
        node.getAttribute('data-learning-section'),
      ),
    ).toEqual(['summary', 'warning'])
    expect(screen.getByRole('heading', { name: '学习目标' }).parentElement?.tagName).toBe('ARTICLE')
    const toggle = screen.getByRole('button', { name: '本节知识' })
    expect(toggle.querySelectorAll('svg')).toHaveLength(1)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
  it('reveals a new same-file target without replacing its reader and preserves manual disclosure control', () => {
    const source = '<details><summary>答案</summary>\n\n目标正文。\n\n</details>'
    const file = { path: '一.md', text: source, version: 'v1', document: parseCourseDocument(source) }
    const props = { id: 'course-1', file, files: [], t, useResource, open: vi.fn(), select: vi.fn() }
    const view = render(<CourseReader {...props} />)
    const article = view.container.querySelector('article')
    const toggle = screen.getByRole('button', { name: '答案' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    view.rerender(<CourseReader {...props} focus={source.indexOf('目标正文')} navigation={1} />)
    expect(view.container.querySelector('article')).toBe(article)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    view.rerender(<CourseReader {...props} focus={source.indexOf('目标正文')} navigation={2} />)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
  it('renders six Obsidian highlighter colors and keeps original quote offsets', () => {
    const source = '==默认== ==🔴红== ==🟠橙== ==🟡黄== ==🟢绿== ==🔵蓝== ==🟣紫=='
    const view = fixture(source)
    const marks = Array.from(view.container.querySelectorAll('mark'))
    expect(marks.map(mark => mark.dataset.highlight)).toEqual([
      'yellow',
      'red',
      'orange',
      'yellow',
      'green',
      'blue',
      'purple',
    ])
    expect(marks.map(mark => mark.textContent)).toEqual(['默认', '红', '橙', '黄', '绿', '蓝', '紫'])
    const red = marks[1]!
    const range = document.createRange()
    range.selectNodeContents(red)
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(red)
    const quote = view.select.mock.lastCall?.[0]
    expect(quote === undefined ? '' : source.slice(quote.start, quote.end)).toBe('==🔴红==')
  })
  it('classifies callout aliases without interpreting code as colored markup', () => {
    const view = fixture(
      '> [!hint] 提示\n> 正文\n\n> [!warning] 注意\n> 正文\n\n> [!error] 错误\n> 正文\n\n`==🔴literal==`',
    )
    expect(
      Array.from(view.container.querySelectorAll('[data-callout]')).map(node => node.getAttribute('data-tone')),
    ).toEqual(['success', 'warning', 'error'])
    expect(view.container.querySelector('code')?.textContent).toBe('==🔴literal==')
    expect(view.container.querySelector('mark')).toBeNull()
  })
  it('keeps Escape dismissed when the selection remains highlighted', () => {
    const view = fixture('正文内容')
    const leaf = view.container.querySelector('[data-source-exact="true"]')!
    const range = document.createRange()
    range.selectNodeContents(leaf)
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(leaf)
    expect(view.select.mock.lastCall?.[0]).toBeDefined()
    fireEvent.keyUp(view.container.querySelector('article')!, { key: 'Escape' })
    expect(view.select).toHaveBeenLastCalledWith(undefined)
  })
  it('quotes the second identical passage by offset rather than string search', () => {
    const source = '第一段：相同内容。\n\n第二段：相同内容。'
    const view = fixture(source)
    const leaf = Array.from(view.container.querySelectorAll<HTMLElement>('[data-source-exact="true"]')).find(node =>
      node.textContent?.startsWith('第二段'),
    )!
    const node = leaf.firstChild!
    const range = document.createRange()
    range.setStart(node, 4)
    range.setEnd(node, 8)
    const selection = window.getSelection()!
    selection.addRange(range)
    fireEvent.mouseUp(leaf)
    expect(view.select).toHaveBeenLastCalledWith({
      path: '课程首页.md',
      version: 'version-1',
      start: source.lastIndexOf('相同内容'),
      end: source.lastIndexOf('相同内容') + 4,
    })
  })
  it('expands a displayed alias to its exact source token', () => {
    const source = '阅读 [[课程首页#定义|短别名]]。'
    const view = fixture(source)
    const link = screen.getByRole('button', { name: '短别名' })
    const range = document.createRange()
    range.selectNodeContents(link)
    window.getSelection()!.addRange(range)
    fireEvent.mouseUp(link)
    const quote = view.select.mock.lastCall?.[0]
    if (quote === undefined) throw new Error('Selection was not mapped')
    expect(source.slice(quote.start, quote.end)).toBe('[[课程首页#定义|短别名]]')
    fireEvent.click(link)
    expect(view.open).toHaveBeenCalledWith('课程首页.md', '定义')
  })
  it('keeps HTML inert and disallows executable links', () => {
    const view = fixture('<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))')
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('a')).toBeNull()
    expect(view.container.textContent).toContain('onerror')
  })
  it('renders valid table elements and literal code instead of fake wiki navigation', () => {
    const view = fixture('|a|b|\n|-|-|\n|1|2|\n\n`[[not-a-link]]`')
    expect(view.container.querySelectorAll('thead>tr')).toHaveLength(1)
    expect(view.container.querySelectorAll('tbody>tr')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'not-a-link' })).toBeNull()
  })
  it('renders inline math without nested paragraph elements and hides callout markers', () => {
    const view = fixture('定义 $a+bi$。\n\n> [!note] 提醒\n> 先理解几何意义。')
    expect(view.container.querySelector('.katex')).not.toBeNull()
    expect(view.container.querySelector('p p')).toBeNull()
    expect(view.container.querySelector('[aria-expanded]')?.parentElement?.textContent).toContain('先理解几何意义')
    expect(view.container.textContent).not.toContain('[!note]')
  })
  it('hides generator comments while retaining literal HTML examples and exact later offsets', () => {
    const source =
      '<!-- BL-INDEX:BEGIN IDX-CORE -->\n\n正文示例。\n\n`<!-- BL-REL:END K-01 -->`\n\n`<div>example</div>`'
    const view = fixture(source)
    expect(view.container.textContent).not.toContain('BL-INDEX')
    expect(view.container.textContent).not.toContain('BL-REL')
    expect(view.container.textContent).toContain('<div>example</div>')
    const text = screen.getByText('正文示例。')
    expect(Number(text.dataset.sourceStart)).toBe(source.indexOf('正文示例。'))
  })
  it('opens and closes callouts through an accessible retained body', () => {
    fixture('> [!note]- 知识关系\n> 关系正文')
    const toggle = screen.getByRole('button', { name: '知识关系' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(body.inert).toBe(true)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body.inert).toBe(false)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })
  it('replays a durable source chip without truncating quoted delimiter examples', () => {
    const quote = {
      id: '11111111-1111-4111-8111-111111111111' as CourseQuoteId,
      courseId: '22222222-2222-4222-8222-222222222222' as CourseId,
      path: '讲义/定义.md',
      version: 'a'.repeat(64),
      start: 0,
      end: 10,
      text: '示例 </course-quote> 与原文',
      createdAt: '2026-10-22T00:00:00Z',
    }
    const source = serializeCourseQuote(quote)
    const match = courseQuoteRule.match(source, 0, { read: () => undefined })
    expect(match?.id).toBe('coursequote')
    if (match?.id === 'coursequote') expect(match.data.excerpt).toBe(quote.text)
    expect(match?.end).toBe(source.length)
    expect({ source, match }).toMatchSnapshot()
  })
})
