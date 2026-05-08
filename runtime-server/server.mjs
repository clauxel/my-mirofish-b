import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'

const defaultBaseDir = '/data/mirofish/prod'

function parseEnvFile(text) {
  const values = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

async function loadEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return
  const values = parseEnvFile(await readFile(filePath, 'utf8'))
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] == null) process.env[key] = value
  }
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!body.trim()) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

function boolFromEnv(value, fallback = false) {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getRuntimeConfig(env = process.env) {
  const baseDir = env.MIROFISH_BASE_DIR || defaultBaseDir
  return {
    host: env.RUNTIME_HOST || '0.0.0.0',
    port: intFromEnv(env.RUNTIME_PORT, 31750),
    token: env.RUNTIME_API_TOKEN || env.MIROFISH_RUNTIME_API_TOKEN || '',
    baseDir,
    templatesDir: env.MIROFISH_TEMPLATES_DIR || path.join(baseDir, 'templates'),
    instancesDir: env.MIROFISH_INSTANCES_DIR || path.join(baseDir, 'instances'),
    templatePath: env.MIROFISH_TEMPLATE_PATH || path.join(baseDir, 'templates', 'mirofish-template-current.tar.gz'),
    instanceDomain: env.MIROFISH_INSTANCE_DOMAIN || 'mirofish.best',
    nginxConfigDir: env.MIROFISH_NGINX_CONFIG_DIR || '/etc/nginx/mirofish.d',
    backendPortStart: intFromEnv(env.MIROFISH_BACKEND_PORT_START, 25001),
    backendPortEnd: intFromEnv(env.MIROFISH_BACKEND_PORT_END, 25999),
    frontendPortStart: intFromEnv(env.MIROFISH_FRONTEND_PORT_START, 23000),
    frontendPortEnd: intFromEnv(env.MIROFISH_FRONTEND_PORT_END, 23999),
    deployTimeoutMs: intFromEnv(env.MIROFISH_DEPLOY_TIMEOUT_MS, 120000),
    platformLlmApiKey: env.PLATFORM_LLM_API_KEY || env.LLM_API_KEY || '',
    platformZepApiKey: env.PLATFORM_ZEP_API_KEY || env.ZEP_API_KEY || '',
    llmBaseUrl: env.PLATFORM_LLM_BASE_URL || env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zepBaseUrl: env.PLATFORM_ZEP_BASE_URL || env.ZEP_BASE_URL || 'https://api.getzep.com/api/v2',
    llmModelName: env.PLATFORM_LLM_MODEL_NAME || env.LLM_MODEL_NAME || 'qwen-plus',
    testLlmModelName: env.MIROFISH_TEST_LLM_MODEL_NAME || 'qwen-turbo',
    allowPlaceholderKeys: boolFromEnv(env.MIROFISH_ALLOW_PLACEHOLDER_KEYS, false),
  }
}

function normalizeInstanceId(value) {
  const raw = String(value || randomUUID().replace(/-/g, '')).trim()
  const withoutPrefix = raw.replace(/^mf-/i, '')
  const normalized = withoutPrefix.toLowerCase().replace(/[^a-z0-9_-]+/g, '')
  if (!normalized || normalized.length > 80) {
    throw new Error('Instance id must contain 1-80 safe characters.')
  }
  return normalized
}

function workspaceNameFor(instanceId) {
  return `mf-${normalizeInstanceId(instanceId)}`
}

function ensureInside(parent, child) {
  const parentPath = path.resolve(parent)
  const childPath = path.resolve(child)
  if (childPath !== parentPath && !childPath.startsWith(`${parentPath}${path.sep}`)) {
    throw new Error(`Unsafe path outside ${parentPath}: ${childPath}`)
  }
  return childPath
}

let _tokenCache = null
let _tokenCacheTime = 0

function zepScopeForInstanceName(instanceName) {
  const instanceId = normalizeInstanceId(String(instanceName || '').replace(/^mf-/i, ''))
  return `mf_${instanceId.replace(/[^a-z0-9]+/g, '_')}`
}

const PLAN_MONTHLY_LIMITS = { starter: 5, pro: 15, enterprise: 20 }

function getPlanMonthlyLimit(planId) {
  const base = String(planId || '').split(':')[0].toLowerCase()
  return PLAN_MONTHLY_LIMITS[base] ?? null
}

function currentYearMonth() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function checkAndRecordAnalysis(instancesDir, instanceName, graphId) {
  const workspacePath = path.join(instancesDir, instanceName)
  const metadata = await readJson(path.join(workspacePath, 'metadata.json'))
  if (!metadata) return { ok: true }
  const limit = metadata.monthly_analysis_limit ?? getPlanMonthlyLimit(metadata.plan_id)
  if (!limit) return { ok: true }
  const month = currentYearMonth()
  const usagePath = path.join(workspacePath, 'usage.json')
  const usage = await readJson(usagePath, { known_graphs: [] })
  if (usage.known_graphs.includes(graphId)) return { ok: true, used: usage[month] ?? 0, limit }
  const currentCount = usage[month] ?? 0
  if (currentCount >= limit) return { ok: false, used: currentCount, limit }
  usage.known_graphs.push(graphId)
  usage[month] = currentCount + 1
  await writeJson(usagePath, usage)
  return { ok: true, used: currentCount + 1, limit }
}

async function resolveInstanceByToken(token, config) {
  if (!token || !existsSync(config.instancesDir)) return null
  const now = Date.now()
  if (!_tokenCache || now - _tokenCacheTime > 30000) {
    _tokenCache = new Map()
    _tokenCacheTime = now
    const entries = await readdir(config.instancesDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const envPath = path.join(config.instancesDir, entry.name, 'app', '.env')
      try {
        const envValues = parseEnvFile(await readFile(envPath, 'utf8'))
        if (envValues.INSTANCE_TOKEN) _tokenCache.set(envValues.INSTANCE_TOKEN, entry.name)
      } catch {}
    }
  }
  return _tokenCache.get(token) || null
}

function extractInstanceToken(request) {
  const auth = request.headers.authorization || ''
  return auth.match(/^(?:Bearer|Api-Key)\s+(.+)$/i)?.[1] || ''
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function buildUpstreamUrl(baseUrl, prefix, requestUrl) {
  const url = new URL(requestUrl, 'http://localhost')
  const upstreamPath = url.pathname.replace(prefix, '') || '/'
  const normalizedBase = String(baseUrl).replace(/\/+$/, '')
  const normalizedPath = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`
  return `${normalizedBase}${normalizedPath}${url.search}`
}

function collectGraphIds(value, ids = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectGraphIds(item, ids)
    return ids
  }
  if (!value || typeof value !== 'object') return ids
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'graph_id' || key === 'graph_ids') && child != null) {
      if (Array.isArray(child)) ids.push(...child.map(String))
      else ids.push(String(child))
    } else {
      collectGraphIds(child, ids)
    }
  }
  return ids
}

function assertScopedGraphAccess({ requestUrl, body, contentType, scope }) {
  const url = new URL(requestUrl, 'http://localhost')
  if (url.pathname === '/zep/graph/list-all') {
    const error = new Error('Graph list access is not available through the instance proxy.')
    error.statusCode = 403
    throw error
  }
  const pathGraphIds = decodeURIComponent(url.pathname)
    .split('/')
    .filter((segment) => /^mirofish_|^mf_[a-z0-9_]+_mirofish_/.test(segment))
  let bodyGraphIds = []
  if (body.length > 0 && String(contentType || '').includes('application/json')) {
    try {
      bodyGraphIds = collectGraphIds(JSON.parse(body.toString('utf8')))
    } catch {
      // Let Zep return the parse error; this guard only scopes valid JSON bodies.
    }
  }
  const graphIds = [...pathGraphIds, ...bodyGraphIds].filter(Boolean)
  const forbidden = graphIds.find((graphId) => !graphId.startsWith(`${scope}_`))
  if (forbidden) {
    const error = new Error('Graph id is outside this instance scope.')
    error.statusCode = 403
    throw error
  }
}

async function handleLlmProxy(request, response, config) {
  if (!config.platformLlmApiKey) {
    return jsonResponse(response, 503, { error: { message: 'LLM API key not configured on this server.', type: 'server_error' } })
  }
  const token = extractInstanceToken(request)
  const instanceName = await resolveInstanceByToken(token, config)
  if (!instanceName) {
    return jsonResponse(response, 401, { error: { message: 'Invalid instance token.', type: 'invalid_request_error' } })
  }
  const upstreamUrl = buildUpstreamUrl(config.llmBaseUrl, /^\/v1/, request.url)
  const body = await readRequestBody(request)
  const upstreamRes = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      'content-type': request.headers['content-type'] || 'application/json',
      'authorization': `Bearer ${config.platformLlmApiKey}`,
    },
    body: body.length > 0 ? body : undefined,
  })
  const contentType = upstreamRes.headers.get('content-type') || 'application/json'
  response.writeHead(upstreamRes.status, { 'content-type': contentType, 'cache-control': 'no-store' })
  if (upstreamRes.body) {
    for await (const chunk of upstreamRes.body) response.write(chunk)
  }
  response.end()
}

async function handleZepProxy(request, response, config) {
  if (!config.platformZepApiKey) {
    return jsonResponse(response, 503, { error: { message: 'Zep API key not configured on this server.', type: 'server_error' } })
  }
  const token = extractInstanceToken(request)
  const instanceName = await resolveInstanceByToken(token, config)
  if (!instanceName) {
    return jsonResponse(response, 401, { error: { message: 'Invalid instance token.', type: 'invalid_request_error' } })
  }

  const body = await readRequestBody(request)
  const contentType = request.headers['content-type'] || 'application/json'
  try {
    assertScopedGraphAccess({
      requestUrl: request.url,
      body,
      contentType,
      scope: zepScopeForInstanceName(instanceName),
    })
  } catch (error) {
    return jsonResponse(response, error.statusCode || 403, {
      error: { message: error.message, type: 'permission_error' },
    })
  }

  if (['POST', 'PUT', 'PATCH'].includes(request.method) && body.length > 0 && contentType.includes('application/json')) {
    let parsedBody
    try { parsedBody = JSON.parse(body.toString('utf8')) } catch {}
    if (parsedBody) {
      for (const graphId of collectGraphIds(parsedBody)) {
        const result = await checkAndRecordAnalysis(config.instancesDir, instanceName, graphId)
        if (!result.ok) {
          return jsonResponse(response, 429, {
            error: {
              message: `Monthly analysis limit reached (${result.used}/${result.limit}). Upgrade your plan for more analyses.`,
              type: 'rate_limit_error',
            },
          })
        }
      }
    }
  }

  const upstreamUrl = buildUpstreamUrl(config.zepBaseUrl, /^\/zep/, request.url)
  const headers = {
    accept: request.headers.accept || 'application/json',
    'content-type': contentType,
    authorization: `Api-Key ${config.platformZepApiKey}`,
  }
  const upstreamRes = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) || body.length === 0 ? undefined : body,
  })
  response.writeHead(upstreamRes.status, {
    'content-type': upstreamRes.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store',
  })
  if (upstreamRes.body) {
    for await (const chunk of upstreamRes.body) response.write(chunk)
  }
  response.end()
}

function redact(value) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 3)}...${text.slice(-3)}`
}

function run(command, args, { cwd, env, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      const message = stderr.trim() || stdout.trim() || `${command} exited with code ${code}`
      reject(new Error(message))
    })
  })
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '0.0.0.0')
  })
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function listInstanceMetadata(instancesDir) {
  if (!existsSync(instancesDir)) return []
  const entries = await readdir(instancesDir, { withFileTypes: true })
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metadata = await readJson(path.join(instancesDir, entry.name, 'metadata.json'))
    if (metadata) rows.push(metadata)
  }
  return rows
}

async function allocatePort(start, end, used) {
  for (let port = start; port <= end; port += 1) {
    if (used.has(port)) continue
    if (await canListen(port)) return port
  }
  throw new Error(`No available port in range ${start}-${end}.`)
}

async function allocatePorts(config) {
  const metadata = await listInstanceMetadata(config.instancesDir)
  const usedBackendPorts = new Set(metadata.map((row) => Number(row.backend_port)).filter(Boolean))
  const usedFrontendPorts = new Set(metadata.map((row) => Number(row.frontend_port)).filter(Boolean))
  return {
    backendPort: await allocatePort(config.backendPortStart, config.backendPortEnd, usedBackendPorts),
    frontendPort: await allocatePort(config.frontendPortStart, config.frontendPortEnd, usedFrontendPorts),
  }
}

async function replaceInFile(filePath, replacements) {
  let text = await readFile(filePath, 'utf8')
  for (const [from, to] of replacements) {
    text = text.replaceAll(from, to)
  }
  await writeFile(filePath, text, 'utf8')
}

function envLine(key, value) {
  const escaped = String(value ?? '').replace(/\n/g, '\\n')
  return `${key}=${escaped}`
}

async function renderInstanceEnv({ appDir, instanceId, backendPort, config, testMode = false }) {
  const instanceToken = randomBytes(24).toString('hex')
  const proxyMode = Boolean(config.platformLlmApiKey)
  const llmApiKey = proxyMode ? instanceToken : (config.allowPlaceholderKeys ? `placeholder-llm-${instanceId}` : '')
  const llmBaseUrl = proxyMode ? `http://127.0.0.1:${config.port}/v1` : config.llmBaseUrl
  const zepProxyMode = Boolean(config.platformZepApiKey)
  const zepKey = zepProxyMode ? instanceToken : (config.allowPlaceholderKeys ? `placeholder-zep-${instanceId}` : '')
  const zepBaseUrl = zepProxyMode ? `http://127.0.0.1:${config.port}/zep` : config.zepBaseUrl
  if (!proxyMode && !llmApiKey) {
    throw new Error('PLATFORM_LLM_API_KEY must be configured on the runtime server.')
  }
  if (!zepProxyMode && !zepKey) {
    throw new Error('PLATFORM_ZEP_API_KEY must be configured on the runtime server.')
  }
  const lines = [
    envLine('LLM_API_KEY', llmApiKey),
    envLine('LLM_BASE_URL', llmBaseUrl),
    envLine('LLM_MODEL_NAME', testMode ? config.testLlmModelName : config.llmModelName),
    envLine('ZEP_API_KEY', zepKey),
    envLine('ZEP_BASE_URL', zepBaseUrl),
    envLine('ZEP_GRAPH_PREFIX', zepScopeForInstanceName(workspaceNameFor(instanceId))),
    envLine('SECRET_KEY', randomBytes(24).toString('hex')),
    envLine('INSTANCE_ID', instanceId),
    envLine('INSTANCE_TOKEN', instanceToken),
    envLine('FLASK_DEBUG', 'False'),
    envLine('FLASK_PORT', backendPort),
    envLine('OASIS_DEFAULT_MAX_ROUNDS', testMode ? '3' : '10'),
  ]
  await writeFile(path.join(appDir, '.env'), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function patchFrontendApiBaseUrl(appDir) {
  const apiIndex = path.join(appDir, 'frontend', 'src', 'api', 'index.js')
  if (existsSync(apiIndex)) {
    await replaceInFile(apiIndex, [
      ["baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:5001'", "baseURL: import.meta.env.VITE_API_BASE_URL || '/'"],
      ['baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5001"', 'baseURL: import.meta.env.VITE_API_BASE_URL || "/"'],
    ])
  }
  for (const envName of ['.env', '.env.development', '.env.production']) {
    const envPath = path.join(appDir, 'frontend', envName)
    if (!existsSync(envPath)) continue
    let text = await readFile(envPath, 'utf8')
    text = text.replace(/^VITE_API_BASE_URL=.*$/gm, 'VITE_API_BASE_URL=/')
    await writeFile(envPath, text, 'utf8')
  }
}

async function patchBackendZepProxy(appDir) {
  const configPath = path.join(appDir, 'backend', 'app', 'config.py')
  if (existsSync(configPath)) {
    let text = await readFile(configPath, 'utf8')
    if (!text.includes('ZEP_BASE_URL')) {
      text = text.replace(
        "ZEP_API_KEY = os.environ.get('ZEP_API_KEY')",
        "ZEP_API_KEY = os.environ.get('ZEP_API_KEY')\n    ZEP_BASE_URL = os.environ.get('ZEP_BASE_URL')\n    ZEP_GRAPH_PREFIX = os.environ.get('ZEP_GRAPH_PREFIX')"
      )
      await writeFile(configPath, text, 'utf8')
    }
  }

  const servicesDir = path.join(appDir, 'backend', 'app', 'services')
  if (existsSync(servicesDir)) {
    const entries = await readdir(servicesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue
      const filePath = path.join(servicesDir, entry.name)
      let text = await readFile(filePath, 'utf8')
      const next = text
        .replaceAll('Zep(api_key=self.api_key)', 'Zep(api_key=self.api_key, base_url=Config.ZEP_BASE_URL)')
        .replaceAll('Zep(api_key=self.zep_api_key)', 'Zep(api_key=self.zep_api_key, base_url=Config.ZEP_BASE_URL)')
        .replace(
          'graph_id = f"mirofish_{uuid.uuid4().hex[:16]}"',
          'graph_id = f"{Config.ZEP_GRAPH_PREFIX}_mirofish_{uuid.uuid4().hex[:16]}" if getattr(Config, "ZEP_GRAPH_PREFIX", None) else f"mirofish_{uuid.uuid4().hex[:16]}"'
        )
      if (next !== text) await writeFile(filePath, next, 'utf8')
    }
  }
}

async function patchInstanceTemplate({ appDir }) {
  await patchFrontendApiBaseUrl(appDir)
  await patchBackendZepProxy(appDir)
}

async function safeSymlink(target, linkPath) {
  await rm(linkPath, { recursive: true, force: true })
  await symlink(target, linkPath)
}

async function prepareWorkspace({ config, instanceId, backendPort, frontendPort, testMode = false }) {
  const workspaceName = workspaceNameFor(instanceId)
  const workspacePath = ensureInside(config.instancesDir, path.join(config.instancesDir, workspaceName))
  const appDir = path.join(workspacePath, 'app')
  if (existsSync(workspacePath)) {
    throw new Error(`Workspace already exists: ${workspaceName}`)
  }
  await mkdir(workspacePath, { recursive: true })
  await mkdir(appDir, { recursive: true })
  await mkdir(path.join(workspacePath, 'data', 'uploads'), { recursive: true })
  await mkdir(path.join(workspacePath, 'memory'), { recursive: true })
  await mkdir(path.join(workspacePath, 'tasks'), { recursive: true })
  await mkdir(path.join(workspacePath, 'logs'), { recursive: true })
  await mkdir(path.join(workspacePath, 'config'), { recursive: true })

  await run('tar', ['-xzf', config.templatePath, '-C', appDir], { timeoutMs: config.deployTimeoutMs })
  await safeSymlink('../logs', path.join(appDir, 'logs'))
  await safeSymlink('../../data/uploads', path.join(appDir, 'backend', 'uploads'))
  await renderInstanceEnv({ appDir, instanceId, backendPort, config, testMode })
  await patchInstanceTemplate({ appDir })

  const viteConfig = path.join(appDir, 'frontend', 'vite.config.js')
  if (existsSync(viteConfig)) {
    await replaceInFile(viteConfig, [
      ["target: 'http://localhost:5001'", `target: 'http://127.0.0.1:${backendPort}'`],
      ['port: 3000', `port: ${frontendPort}`],
      ['open: true', 'open: false,\n    allowedHosts: true'],
    ])
  }

  for (const script of ['start.sh', 'stop.sh', 'healthcheck.sh', 'smoke-test.sh']) {
    const scriptPath = path.join(appDir, 'scripts', script)
    if (existsSync(scriptPath)) await chmod(scriptPath, 0o755)
  }

  return { workspaceName, workspacePath, appDir }
}

async function waitForScript({ appDir, script, args, timeoutMs }) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      await run('bash', [path.join('scripts', script), ...args.map(String)], {
        cwd: appDir,
        timeoutMs: 10000,
      })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw new Error(`${script} failed: ${lastError?.message || 'timed out'}`)
}

async function startInstance({ appDir, backendPort, frontendPort, config }) {
  await run('bash', [path.join('scripts', 'start.sh')], {
    cwd: appDir,
    env: { FRONTEND_PORT: String(frontendPort) },
    timeoutMs: 30000,
  })
  await waitForScript({
    appDir,
    script: 'healthcheck.sh',
    args: [backendPort],
    timeoutMs: config.deployTimeoutMs,
  })
}

function buildConsoleUrl(config, instanceId) {
  return `https://mf-${instanceId}.${config.instanceDomain}/`
}

async function writeNginxConfig(instanceId, frontendPort, config) {
  const configPath = path.join(config.nginxConfigDir, `mf-${instanceId}.conf`)
  const content = `server {
    listen 80;
    listen [::]:80;
    server_name mf-${instanceId}.${config.instanceDomain};
    location / {
        proxy_pass http://127.0.0.1:${frontendPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
`
  await mkdir(config.nginxConfigDir, { recursive: true })
  await writeFile(configPath, content, 'utf8')
  await run('nginx', ['-s', 'reload'], { timeoutMs: 10000 }).catch(() => null)
}

async function removeNginxConfig(instanceId, config) {
  const configPath = path.join(config.nginxConfigDir, `mf-${instanceId}.conf`)
  await rm(configPath, { force: true })
  await run('nginx', ['-s', 'reload'], { timeoutMs: 10000 }).catch(() => null)
}

async function stopInstanceByMetadata(metadata, config) {
  if (!metadata?.workspace_path) return
  const appDir = path.join(metadata.workspace_path, 'app')
  if (existsSync(path.join(appDir, 'scripts', 'stop.sh'))) {
    await run('bash', [path.join('scripts', 'stop.sh')], { cwd: appDir, timeoutMs: 30000 }).catch(() => null)
  }
  if (config && metadata.id) await removeNginxConfig(metadata.id, config)
}

async function deployInstance(input, config) {
  const instanceId = normalizeInstanceId(input.instanceId || input.id)
  await mkdir(config.instancesDir, { recursive: true })
  if (!existsSync(config.templatePath)) {
    throw new Error(`Template package not found: ${config.templatePath}`)
  }

  const existingPath = path.join(config.instancesDir, workspaceNameFor(instanceId), 'metadata.json')
  const existing = await readJson(existingPath)
  if (existing?.status === 'running') {
    return { ...existing, idempotent: true }
  }
  if (existing && !input.force) {
    throw new Error(`Instance already exists with status ${existing.status || 'unknown'}.`)
  }
  if (existing && input.force) {
    await stopInstanceByMetadata(existing, config)
    await rm(path.dirname(existingPath), { recursive: true, force: true })
  }

  const testMode = Boolean(input.testMode)
  const { backendPort, frontendPort } = await allocatePorts(config)
  const { workspaceName, workspacePath, appDir } = await prepareWorkspace({
    config,
    instanceId,
    backendPort,
    frontendPort,
    testMode,
  })

  const now = new Date().toISOString()
  const metadata = {
    id: instanceId,
    order_id: input.orderId || null,
    plan_id: input.planId || null,
    monthly_analysis_limit: testMode ? 2 : getPlanMonthlyLimit(input.planId || null),
    status: 'creating',
    env: input.env || 'prod',
    host: config.instanceDomain,
    backend_port: backendPort,
    frontend_port: frontendPort,
    service_name: `mirofish-${input.env || 'prod'}-${instanceId}`,
    workspace_path: workspacePath,
    console_url: buildConsoleUrl(config, instanceId),
    created_at: now,
    updated_at: now,
    secrets: {
      llm_api_key: redact(config.platformLlmApiKey),
      zep_api_key: redact(config.platformZepApiKey),
      placeholders: !config.platformLlmApiKey || !config.platformZepApiKey,
    },
  }
  await writeJson(path.join(workspacePath, 'metadata.json'), metadata)

  try {
    await startInstance({ appDir, backendPort, frontendPort, config })
    await waitForScript({
      appDir,
      script: 'smoke-test.sh',
      args: [frontendPort],
      timeoutMs: config.deployTimeoutMs,
    })
    metadata.status = 'running'
    metadata.updated_at = new Date().toISOString()
    await writeJson(path.join(workspacePath, 'metadata.json'), metadata)
    await writeNginxConfig(instanceId, frontendPort, config)
    return metadata
  } catch (error) {
    await stopInstanceByMetadata(metadata, config)
    metadata.status = 'failed'
    metadata.error_message = error instanceof Error ? error.message : String(error)
    metadata.updated_at = new Date().toISOString()
    await writeJson(path.join(workspacePath, 'metadata.json'), metadata)
    throw error
  }
}

async function readInstance(config, instanceId) {
  const metadataPath = path.join(config.instancesDir, workspaceNameFor(instanceId), 'metadata.json')
  return readJson(metadataPath)
}

function isAuthorized(request, config) {
  if (!config.token) return false
  const header = request.headers.authorization || ''
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1]
  const token = bearer || request.headers['x-runtime-token']
  return token === config.token
}

async function handleRequest(request, response, config) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname.startsWith('/v1/')) {
    return handleLlmProxy(request, response, config)
  }
  if (url.pathname.startsWith('/zep/')) {
    return handleZepProxy(request, response, config)
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse(response, 200, {
      ok: true,
      service: 'mirofish-runtime-server',
      template_exists: existsSync(config.templatePath),
    })
  }

  if (!isAuthorized(request, config)) {
    return jsonResponse(response, 401, { message: 'Unauthorized.' })
  }

  if (request.method === 'POST' && url.pathname === '/instances') {
    const body = await readRequestJson(request)
    const instance = await deployInstance(body, config)
    return jsonResponse(response, 200, { instance })
  }

  const instanceMatch = url.pathname.match(/^\/instances\/([^/]+)$/)
  if (request.method === 'GET' && instanceMatch) {
    const instance = await readInstance(config, instanceMatch[1])
    if (!instance) return jsonResponse(response, 404, { message: 'Instance not found.' })
    return jsonResponse(response, 200, { instance })
  }

  if (request.method === 'DELETE' && instanceMatch) {
    const instance = await readInstance(config, instanceMatch[1])
    if (!instance) return jsonResponse(response, 404, { message: 'Instance not found.' })
    await stopInstanceByMetadata(instance, config)
    await rm(path.dirname(path.join(instance.workspace_path, 'metadata.json')), { recursive: true, force: true })
    return jsonResponse(response, 200, { deleted: true, id: instance.id })
  }

  const restartMatch = url.pathname.match(/^\/instances\/([^/]+)\/restart$/)
  if (request.method === 'POST' && restartMatch) {
    const instance = await readInstance(config, restartMatch[1])
    if (!instance) return jsonResponse(response, 404, { message: 'Instance not found.' })
    await stopInstanceByMetadata(instance, config)
    const appDir = path.join(instance.workspace_path, 'app')
    await startInstance({
      appDir,
      backendPort: instance.backend_port,
      frontendPort: instance.frontend_port,
      config,
    })
    instance.status = 'running'
    instance.updated_at = new Date().toISOString()
    await writeJson(path.join(instance.workspace_path, 'metadata.json'), instance)
    return jsonResponse(response, 200, { instance })
  }

  return jsonResponse(response, 404, { message: 'Not found.' })
}

async function main() {
  const envFile = process.env.RUNTIME_ENV_FILE || path.join(process.cwd(), 'runtime.env')
  await loadEnvFile(envFile)
  const config = getRuntimeConfig()
  if (!config.token) {
    console.error('RUNTIME_API_TOKEN is required.')
    process.exit(1)
  }
  await mkdir(config.instancesDir, { recursive: true })
  const server = createServer((request, response) => {
    handleRequest(request, response, config).catch((error) => {
      console.error(error)
      jsonResponse(response, 500, { message: error instanceof Error ? error.message : String(error) })
    })
  })
  server.listen(config.port, config.host, () => {
    console.log(`MiroFish Runtime Server listening on ${config.host}:${config.port}`)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

export {
  allocatePorts,
  assertScopedGraphAccess,
  getRuntimeConfig,
  normalizeInstanceId,
  patchInstanceTemplate,
  parseEnvFile,
  renderInstanceEnv,
  workspaceNameFor,
  zepScopeForInstanceName,
}
