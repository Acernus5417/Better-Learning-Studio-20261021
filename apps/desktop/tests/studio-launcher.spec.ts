import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.skipIf(process.platform !== 'win32').each([false, true])('starts Studio through the project pnpm lifecycle with isolated settings (skipBuild=%s)', async (skipBuild) => {
  const root = await mkdtemp(join(tmpdir(), 'bls launcher lifecycle '))
  try {
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'apps/desktop/node_modules/pnpm/bin'), { recursive: true })
    await copyFile(join(process.cwd(), 'start-studio.ps1'), join(root, 'start-studio.ps1'))
    await copyFile(join(process.cwd(), 'scripts/user-info-fallback.cjs'), join(root, 'scripts/user-info-fallback.cjs'))
    await writeFile(join(root, 'scripts/ensure-electron.mjs'), 'process.exit(0)\n')
    const trace = join(root, 'launcher-run.json')
    await writeFile(join(root, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  home: process.env.DSH_HOME, studio: process.env.BLS_STUDIO,
  workflow: process.env.BLS_WORKFLOW_ROOT, profile: process.env.DSH_CLIENT_BUILD_PROFILE,
  title: process.env.DSH_CLIENT_TITLE, devtools: process.env.DSH_DESKTOP_OPEN_DEVTOOLS,
}))
`)
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)))
    await execute(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'start-studio.ps1'), ...(skipBuild ? ['-SkipBuild'] : []),
    ], { env: { ...environment, APPDATA: root }, windowsHide: true })
    expect(JSON.parse(await readFile(trace, 'utf8'))).toEqual({
      args: ['run', skipBuild ? 'start:desktop' : 'dev:desktop'], cwd: root,
      home: join(root, 'BetterLearningStudio-DSH', 'dsh'), studio: '1',
      workflow: join(root, 'apps/desktop/resources/workflows/better-learning'), profile: 'better-learning',
      title: 'Better Learning Studio', devtools: '0',
    })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

it.skipIf(process.platform !== 'win32')('returns a failure and a sanitized log when a hidden startup command fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bls launcher '))
  try {
    await mkdir(join(root, 'scripts'))
    await copyFile(join(process.cwd(), 'start-studio.ps1'), join(root, 'start-studio.ps1'))
    await copyFile(join(process.cwd(), 'scripts/user-info-fallback.cjs'), join(root, 'scripts/user-info-fallback.cjs'))
    await writeFile(join(root, 'scripts/ensure-electron.mjs'),
      'console.error("https://example.invalid/?token=synthetic-secret"); process.exit(17)\n')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu.test(name)))
    await expect(execute(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'start-studio.ps1'), '-SkipBuild',
    ], { env: { ...environment, APPDATA: root }, windowsHide: true })).rejects.toMatchObject({ code: 1 })
    const logs = await readdir(join(root, '.desktop-cache'))
    expect(logs).toHaveLength(1)
    const log = await readFile(join(root, '.desktop-cache', logs[0]!), 'utf8')
    expect(log).toContain('code 17')
    expect(log).toContain('[URL REDACTED]')
    expect(log).not.toContain('synthetic-secret')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
