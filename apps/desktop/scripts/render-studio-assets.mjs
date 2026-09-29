/** Render the Better Learning Studio tile and installer artwork from one SVG. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const path = relative => fileURLToPath(new URL(relative, import.meta.url))
const source = await readFile(path('../resources/icon-windows.svg'))

for (const target of ['icon-macos.svg', 'icon.svg']) {
  await writeFile(path(`../resources/${target}`), source)
}

for (const target of ['icon-windows.png', 'icon-macos.png', 'icon.png']) {
  await sharp(source).resize(1024, 1024).png().toFile(path(`../resources/${target}`))
}

for (const scale of [1, 2]) {
  const width = 600 * scale
  const height = 196 * scale
  const icon = await sharp(source).resize(132 * scale, 132 * scale).png().toBuffer()
  for (const [suffix, ink] of [['', '#111111'], ['-dark', '#F6F6F6']]) {
    const wordmark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 600 196">
      <text x="184" y="88" fill="${ink}" font-family="Segoe UI, Arial, sans-serif" font-size="37" font-weight="700" letter-spacing="-.8">Better Learning</text>
      <text x="186" y="124" fill="${ink}" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600" letter-spacing="6">STUDIO</text>
    </svg>`)
    await sharp({ create: { width, height, channels: 4, background: '#00000000' } })
      .composite([
        { input: icon, left: 24 * scale, top: 32 * scale },
        { input: await sharp(wordmark).png().toBuffer(), left: 0, top: 0 },
      ])
      .png()
      .toFile(path(`../installer/assets/brand${suffix}${scale === 2 ? '-2x' : ''}.png`))
  }
}

console.info('Better Learning Studio icons and installer artwork rendered')
