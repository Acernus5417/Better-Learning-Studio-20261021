import { describe, expect, it } from 'vitest'
import { isCourseStudyAction } from '../src/index.ts'

describe('course learning action wire values', () => {
  it.each(['explain', 'example', 'summarize', 'quiz', 'discuss'])('recognizes the %s action identifier', (value) => {
    expect(isCourseStudyAction(value)).toBe(true)
  })
  it.each([undefined, null, '', 'delete', 'EXPLAIN', {}, ['quiz']])('rejects unsupported action %j', (value) => {
    expect(isCourseStudyAction(value)).toBe(false)
  })
})
