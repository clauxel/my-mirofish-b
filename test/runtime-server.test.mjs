import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  getRuntimeConfig,
  assertScopedGraphAccess,
  normalizeInstanceId,
  patchInstanceTemplate,
  parseEnvFile,
  renderInstanceEnv,
  workspaceNameFor,
  zepScopeForInstanceName,
} from '../runtime-server/server.mjs'

test('parseEnvFile handles comments and quoted values', () => {
  assert.deepEqual(parseEnvFile('A=1\n# nope\nB=\"two words\"\nC=three\n'), {
    A: '1',
    B: 'two words',
    C: 'three',
  })
})

test('normalizeInstanceId strips unsafe characters and mf prefix', () => {
  assert.equal(normalizeInstanceId('mf-ABC_123!!'), 'abc_123')
  assert.equal(workspaceNameFor('ABC123'), 'mf-abc123')
})

test('getRuntimeConfig resolves defaults', () => {
  const config = getRuntimeConfig({
    RUNTIME_API_TOKEN: 'token',
  })
  assert.equal(config.port, 31750)
  assert.equal(config.templatePath, '/data/mirofish/prod/templates/mirofish-template-current.tar.gz')
  assert.equal(config.zepBaseUrl, 'https://api.getzep.com/api/v2')
})

test('renderInstanceEnv gives instances proxy tokens instead of platform secrets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mirofish-runtime-'))
  try {
    await renderInstanceEnv({
      appDir: dir,
      instanceId: 'abc123',
      backendPort: 25002,
      config: {
        port: 31750,
        platformLlmApiKey: 'platform-llm-secret',
        platformZepApiKey: 'platform-zep-secret',
        llmBaseUrl: 'https://llm.example/v1',
        zepBaseUrl: 'https://api.getzep.com/api/v2',
        llmModelName: 'qwen-plus',
        allowPlaceholderKeys: false,
      },
    })
    const env = parseEnvFile(await readFile(path.join(dir, '.env'), 'utf8'))
    assert.equal(env.LLM_API_KEY, env.INSTANCE_TOKEN)
    assert.equal(env.ZEP_API_KEY, env.INSTANCE_TOKEN)
    assert.equal(env.LLM_BASE_URL, 'http://127.0.0.1:31750/v1')
    assert.equal(env.ZEP_BASE_URL, 'http://127.0.0.1:31750/zep')
    assert.equal(env.ZEP_GRAPH_PREFIX, 'mf_abc123')
    const raw = await readFile(path.join(dir, '.env'), 'utf8')
    assert.equal(raw.includes('platform-llm-secret'), false)
    assert.equal(raw.includes('platform-zep-secret'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('patchInstanceTemplate makes frontend same-origin and Zep SDK proxy-aware', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mirofish-template-'))
  try {
    await mkdir(path.join(dir, 'frontend', 'src', 'api'), { recursive: true })
    await mkdir(path.join(dir, 'backend', 'app', 'services'), { recursive: true })
    await mkdir(path.join(dir, 'backend', 'app'), { recursive: true })
    await writeFile(
      path.join(dir, 'frontend', 'src', 'api', 'index.js'),
      "const service = axios.create({\n  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:5001',\n})\n",
      'utf8'
    )
    await writeFile(path.join(dir, 'frontend', '.env.development'), 'VITE_API_BASE_URL=http://localhost:5001\n', 'utf8')
    await writeFile(
      path.join(dir, 'backend', 'app', 'config.py'),
      "class Config:\n    ZEP_API_KEY = os.environ.get('ZEP_API_KEY')\n",
      'utf8'
    )
    await writeFile(
      path.join(dir, 'backend', 'app', 'services', 'graph_builder.py'),
      'from ..config import Config\nself.client = Zep(api_key=self.api_key)\ngraph_id = f"mirofish_{uuid.uuid4().hex[:16]}"\n',
      'utf8'
    )

    await patchInstanceTemplate({ appDir: dir })

    const apiIndex = await readFile(path.join(dir, 'frontend', 'src', 'api', 'index.js'), 'utf8')
    assert.match(apiIndex, /baseURL: import\.meta\.env\.VITE_API_BASE_URL \|\| '\/'/)
    const frontendEnv = await readFile(path.join(dir, 'frontend', '.env.development'), 'utf8')
    assert.equal(frontendEnv.trim(), 'VITE_API_BASE_URL=/')
    const config = await readFile(path.join(dir, 'backend', 'app', 'config.py'), 'utf8')
    assert.match(config, /ZEP_BASE_URL = os\.environ\.get\('ZEP_BASE_URL'\)/)
    assert.match(config, /ZEP_GRAPH_PREFIX = os\.environ\.get\('ZEP_GRAPH_PREFIX'\)/)
    const graphBuilder = await readFile(path.join(dir, 'backend', 'app', 'services', 'graph_builder.py'), 'utf8')
    assert.match(graphBuilder, /Zep\(api_key=self\.api_key, base_url=Config\.ZEP_BASE_URL\)/)
    assert.match(graphBuilder, /Config\.ZEP_GRAPH_PREFIX/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('zepScopeForInstanceName is stable and safe', () => {
  assert.equal(zepScopeForInstanceName('mf-ABC-123'), 'mf_abc_123')
})

test('assertScopedGraphAccess blocks cross-instance graph ids and graph listing', () => {
  assert.doesNotThrow(() => assertScopedGraphAccess({
    requestUrl: '/zep/graph/create',
    body: Buffer.from(JSON.stringify({ graph_id: 'mf_abc123_mirofish_a1' })),
    contentType: 'application/json',
    scope: 'mf_abc123',
  }))
  assert.throws(() => assertScopedGraphAccess({
    requestUrl: '/zep/graph/mf_other_mirofish_a1',
    body: Buffer.alloc(0),
    contentType: 'application/json',
    scope: 'mf_abc123',
  }), /outside this instance scope/)
  assert.throws(() => assertScopedGraphAccess({
    requestUrl: '/zep/graph/list-all',
    body: Buffer.alloc(0),
    contentType: 'application/json',
    scope: 'mf_abc123',
  }), /Graph list access/)
})
