import { describe, expect, it } from 'vitest'
import { parseCourseDocument } from '@deepseek-ai/dsh-util-course-document'
import { resolveTutorFile, courseAnchorOffset } from '../src/client/course/chat-links.ts'

const files = ['学习文档/第一讲.md', '学习文档/第二讲.md', '资料/概览.md', '笔记/概览.md']
describe('tutor course file destinations', () => {
  it.each([
    '第二讲.md',
    './第二讲.md',
    '学习文档/第二讲.md',
    '../学习文档/第二讲.md',
    'C:\\Courses\\one\\学习文档\\第二讲.md',
    'c:/courses/one/学习文档/第二讲.md',
  ])('resolves %s inside the current course', (path) => {
    expect(resolveTutorFile(path, 'C:/Courses/one', files[0] ?? '', files).path).toBe(files[1])
  })
  it('rejects outside roots and ambiguous basenames instead of opening another preview', () => {
    expect(
      resolveTutorFile('C:/Courses/two/学习文档/第二讲.md', 'C:/Courses/one', files[0] ?? '', files).path,
    ).toBeUndefined()
    expect(resolveTutorFile('../../../private.md', 'C:/Courses/one', files[0] ?? '', files).path).toBeUndefined()
    expect(resolveTutorFile('概览', 'C:/Courses/one', files[0] ?? '', files).ambiguous).toHaveLength(2)
    expect(
      resolveTutorFile('运行记录.md', 'C:/Courses/one', files[0] ?? '', ['_工作区/运行记录.md']).path,
    ).toBeUndefined()
  })
  it('locates named headings, ordinary slugs and block identifiers at original offsets', () => {
    const source = '# Course heading\n\n## 学习目标\n\n正文。 ^block-1'
    const document = parseCourseDocument(source)
    expect(courseAnchorOffset(document, 'course-heading')).toBe(0)
    expect(courseAnchorOffset(document, '学习目标')).toBe(source.indexOf('##'))
    expect(courseAnchorOffset(document, '^block-1')).toBe(source.indexOf('正文'))
    expect(courseAnchorOffset(document, '@20')).toBe(20)
    expect(courseAnchorOffset(document, '@NaN')).toBeUndefined()
  })
})
