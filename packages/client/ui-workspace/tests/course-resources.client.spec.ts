import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { courseResourceOwner, courseAddress } from '../src/client/course/resources.ts'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('checks the revision before reusing a cached resource and ends the stream on release', async () => {
  const value = { courses: [] },
    calls: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected a serialized course request')
      const body: unknown = JSON.parse(init.body)
      calls.push(body as Record<string, unknown>)
      return Response.json(calls.length === 1 ? { revision: 'one', value } : { revision: 'one' })
    }),
  )
  const owner = courseResourceOwner(new Context()),
    first = new AbortController()
  const stream = owner.data.open(courseAddress('list'), { signal: first.signal })[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ ok: true, value })
  first.abort()
  await stream.return?.()
  const second = new AbortController(),
    again = owner.data.open(courseAddress('list'), { signal: second.signal })[Symbol.asyncIterator]()
  expect((await again.next()).value).toEqual({ ok: true, value })
  expect(calls[1]?.known).toBe('one')
  const finished = again.next()
  second.abort()
  expect((await finished).done).toBe(true)
})
it('keeps hidden reference addresses inactive without contacting the Host', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const owner = courseResourceOwner(new Context()),
    controller = new AbortController()
  const stream = owner.data.open(courseAddress('links', ''), { signal: controller.signal })[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ ok: true, value: {} })
  await stream.return?.()
  expect(fetch).not.toHaveBeenCalled()
})

it('shows a provisional graph and immediately requests its verified replacement', async () => {
  vi.useFakeTimers()
  const first = { graph: { notes: [] }, graphPending: true, graphRevision: 'one' },
    second = { graph: { notes: [] }, graphRevision: 'two' }
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ revision: 'pending:one', value: first }))
    .mockResolvedValueOnce(Response.json({ revision: 'two', value: second }))
  vi.stubGlobal('fetch', fetch)
  const owner = courseResourceOwner(new Context()),
    controller = new AbortController()
  const stream = owner.data
    .open(courseAddress('graph', 'course-id'), { signal: controller.signal })
    [Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ ok: true, value: first })
  expect((await stream.next()).value).toEqual({ ok: true, value: second })
  expect(fetch).toHaveBeenCalledTimes(2)
  controller.abort()
  await stream.return?.()
})
