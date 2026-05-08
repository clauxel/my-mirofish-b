import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

function parseEnvValue(rawValue) {
  const value = rawValue.trim()
  if (!value) return ''

  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const inner = value.slice(1, -1)
    return quote === '"'
      ? inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      : inner.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  }

  return value.replace(/\s+#.*$/, '').trim()
}

function parseEnvContent(content) {
  const entries = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line
    const separatorIndex = normalizedLine.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = normalizedLine.slice(0, separatorIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    entries.push([key, parseEnvValue(normalizedLine.slice(separatorIndex + 1))])
  }

  return entries
}

export function loadLocalEnvironment({
  projectRoot,
  runtimeMode = 'production',
  environment = process.env,
  explicitEnvPath = environment.MIROFISH_ENV_PATH ?? '',
}) {
  const protectedKeys = new Set(Object.keys(environment))
  const automaticPath = String(runtimeMode).toLowerCase() === 'development'
    ? join(projectRoot, '.env.development')
    : join(projectRoot, '.env.production')
  const explicitPaths = explicitEnvPath
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(projectRoot, item))
  const loadedFiles = []

  for (const filePath of [automaticPath, ...explicitPaths]) {
    if (!existsSync(filePath)) continue

    const entries = parseEnvContent(readFileSync(filePath, 'utf8'))
    for (const [key, value] of entries) {
      if (!protectedKeys.has(key)) {
        environment[key] = value
      }
    }
    loadedFiles.push(filePath)
  }

  return loadedFiles
}
