/** Download and verify the Electron development binary before launching the studio. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = join(root, 'apps', 'desktop', 'node_modules', 'electron')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const filename = `electron-v${manifest.version}-win32-x64.zip`
const checksums = JSON.parse(readFileSync(join(packageRoot, 'checksums.json'), 'utf8'))
const expected = checksums[filename]
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Better Learning Studio development launcher requires Windows x64')
if (typeof expected !== 'string') throw new Error(`Missing Electron checksum for ${filename}`)
if (existsSync(join(packageRoot, 'dist', 'electron.exe'))) process.exit(0)

const url = new URL(`https://github.com/electron/electron/releases/download/v${manifest.version}/${filename}`)
// The official release response can stall on Windows proxies. The mirror bytes
// are accepted only when they match Electron's package-pinned official checksum.
const downloadUrl = `https://npmmirror.com/mirrors/electron/${manifest.version}/${filename}`
const cacheUrl = new URL(url)
cacheUrl.pathname = posix.dirname(cacheUrl.pathname)
const key = createHash('sha256').update(cacheUrl.toString()).digest('hex')
const cacheRoot = process.env.electron_config_cache ?? join(root, '.desktop-cache', 'electron')
const destination = join(cacheRoot, key, filename)
mkdirSync(dirname(destination), { recursive: true })
const digest = async path => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
if (!existsSync(destination) || await digest(destination) !== expected) {
  const staging = `${destination}.partial`
  rmSync(staging, { force: true })
  try {
    console.log(`Downloading verified Electron ${manifest.version} for Better Learning Studio...`)
    const response = await fetch(downloadUrl)
    if (!response.ok || response.body === null) throw new Error(`Electron download failed: HTTP ${response.status}`)
    await pipeline(response.body, createWriteStream(staging))
    if (await digest(staging) !== expected) throw new Error('Electron checksum mismatch')
    renameSync(staging, destination)
  } finally {
    rmSync(staging, { force: true })
  }
}
console.log('Extracting verified Electron...')
const result = spawnSync(process.execPath, [join(packageRoot, 'install.js')], {
  env: { ...process.env, electron_config_cache: cacheRoot }, stdio: 'inherit',
})
if (result.status !== 0) throw new Error(`Electron extraction failed: ${String(result.status ?? result.error)}`)
if (!existsSync(join(packageRoot, 'dist', 'electron.exe'))) throw new Error('Electron executable is still missing')
