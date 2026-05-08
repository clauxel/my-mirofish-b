import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outputDir = join(root, 'dist-pages')

const entries = [
  '404.html',
  'assets',
  'auth',
  'checkout',
  'console',
  'dashboard',
  'difference-between-microfiche-and-microfilm',
  'favicon.svg',
  'gpt-5-5-instant',
  'index.html',
  'is-microfiche-still-used-today',
  'microfiche-definition',
  'microfiche-library',
  'microfiche-records',
  'mirofish-ai',
  'mirofish-demo',
  'mirofish-english',
  'mirofish-founder',
  'mirofish-github',
  'mirofish-how-to-use',
  'mirofish-offline',
  'mirofish-polymarket',
  'mirofish-trading',
  'privacy',
  'robots.txt',
  'sitemap.xml',
  'terms',
  'what-does-microfiche-look-like',
  'what-does-microfiche-mean',
  'when-did-microfiche-come-out',
]

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

for (const entry of entries) {
  const source = join(root, entry)
  if (!(await exists(source))) continue

  const destination = join(outputDir, entry)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

console.log(`Built Cloudflare Pages static output at ${outputDir}`)
