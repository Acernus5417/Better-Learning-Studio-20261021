/** Prepare a branded Windows Electron runtime for the unpackaged development app. */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'

// app-builder-lib already owns the PE resource editor used during Windows packaging.
const require = createRequire(import.meta.url)
const ResEdit = createRequire(require.resolve('app-builder-lib'))('resedit')

const PRODUCT_NAME = 'Better Learning Studio'
// Electron recognizes an unpackaged development app by this executable name.
// Its embedded icon and version resource carry the studio identity.
const PRODUCT_EXECUTABLE = 'electron.exe'

function mirrorRuntime(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      mirrorRuntime(from, to)
    } else if (!existsSync(to)) {
      // Hard links keep the large Electron runtime local without copying it on each development launch.
      try { linkSync(from, to) } catch { copyFileSync(from, to) }
    }
  }
}

/**
 * Create a cached copy of Electron with the studio icon embedded in its executable.
 * The source installation is never modified; each icon or Electron revision gets a new cache directory.
 */
export function prepareDevelopmentElectron(electron: string, iconPath: string, developmentRoot: string): string {
  const source = dirname(electron)
  const sourceStat = statSync(electron)
  const icon = readFileSync(iconPath)
  const key = createHash('sha256').update('studio-electron-v1\0').update(electron).update('\0')
    .update(String(sourceStat.size)).update('\0').update(String(sourceStat.mtimeMs)).update('\0').update(icon)
    .digest('hex').slice(0, 16)
  const directory = join(developmentRoot, 'branded-electron', key)
  const executable = join(directory, PRODUCT_EXECUTABLE)
  const stamp = join(directory, 'studio-icon.json')
  if (existsSync(executable) && existsSync(stamp) && readFileSync(stamp, 'utf8') === key) return executable

  mkdirSync(directory, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === basename(electron)) continue
    const from = join(source, entry.name)
    const to = join(directory, entry.name)
    if (entry.isDirectory()) mirrorRuntime(from, to)
    else if (!existsSync(to)) {
      try { linkSync(from, to) } catch { copyFileSync(from, to) }
    }
  }

  const image = ResEdit.NtExecutable.from(readFileSync(electron), { ignoreCert: true })
  const resources = ResEdit.NtExecutableResource.from(image)
  const icons = ResEdit.Data.IconFile.from(icon).icons.map(item => item.data)
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  for (const group of groups.length === 0 ? [{ id: 1, lang: 1033 }] : groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  }
  for (const info of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
    const languages = info.getAllLanguagesForStringValues()
    for (const language of languages.length === 0 ? [{ lang: 1033, codepage: 1200 }] : languages) {
      info.setStringValues(language, {
        ...info.getStringValues(language),
        FileDescription: PRODUCT_NAME,
        ProductName: PRODUCT_NAME,
        InternalName: PRODUCT_NAME,
        OriginalFilename: PRODUCT_EXECUTABLE,
      })
    }
    info.outputToResourceEntries(resources.entries)
  }
  resources.outputResource(image)
  const temporary = join(directory, `${PRODUCT_EXECUTABLE}.pending`)
  writeFileSync(temporary, Buffer.from(image.generate()))
  renameSync(temporary, executable)
  writeFileSync(stamp, key)
  return executable
}
