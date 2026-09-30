/** Pick a loopback port for this desktop instance without colliding with DSH. */

import { createServer } from 'node:net'

export async function desktopWebPort(configured?: string): Promise<number> {
  if (configured !== undefined) {
    const value = Number(configured)
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      throw new Error('BLS_WEB_PORT must be an integer from 1 through 65535')
    }
    return value
  }
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('desktop web port: loopback listener has no TCP port'))
        return
      }
      server.close((error) => {
        if (error === undefined) resolve(address.port)
        else reject(error)
      })
    })
  })
}
