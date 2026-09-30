import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopWebPort } from '../src/desktop-web-port.ts'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

describe('desktop Web listener port', () => {
  it('selects a free loopback port while another local service is running', async () => {
    const occupied = createServer()
    servers.push(occupied)
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    expect(address).not.toBeNull()
    if (address === null || typeof address === 'string') throw new Error('expected TCP listener')
    const selected = await desktopWebPort()
    expect(selected).toBeGreaterThan(0)
    expect(selected).not.toBe(address.port)
    const next = createServer()
    servers.push(next)
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject)
      next.listen(selected, '127.0.0.1', resolve)
    })
  })

  it('keeps an explicit test port and rejects invalid overrides', async () => {
    expect(await desktopWebPort('19388')).toBe(19388)
    await expect(desktopWebPort('0')).rejects.toThrow('BLS_WEB_PORT')
    await expect(desktopWebPort('65536')).rejects.toThrow('BLS_WEB_PORT')
    await expect(desktopWebPort('not-a-port')).rejects.toThrow('BLS_WEB_PORT')
  })
})
