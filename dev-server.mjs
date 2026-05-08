import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import launchCheckoutHandler from './api/launch-checkout.js'

const root = fileURLToPath(new URL('.', import.meta.url))
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8080)

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

function sendText(response, statusCode, message, contentType = 'text/plain; charset=utf-8') {
  response.statusCode = statusCode
  response.setHeader('Content-Type', contentType)
  response.end(message)
}

function safeStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname)
  const cleanPath = decodedPath.replace(/^\/+/, '')
  const candidate = normalize(join(root, cleanPath))
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || rel === '..') {
    return null
  }
  return candidate
}

async function resolveStaticFile(pathname) {
  let target = safeStaticPath(pathname)
  if (!target) return null

  try {
    const targetStat = await stat(target)
    if (targetStat.isDirectory()) {
      target = join(target, 'index.html')
    }
  } catch {
    if (!extname(target)) {
      target = join(target, 'index.html')
    }
  }

  try {
    const fileStat = await stat(target)
    if (!fileStat.isFile()) return null
    return target
  } catch {
    return null
  }
}

async function serveStatic(request, response, url) {
  const filePath = await resolveStaticFile(url.pathname === '/' ? '/index.html' : url.pathname)
  if (!filePath) {
    sendText(response, 404, 'Not found')
    return
  }

  response.statusCode = 200
  response.setHeader('Content-Type', contentTypes[extname(filePath)] || 'application/octet-stream')
  createReadStream(filePath).pipe(response)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`)

    if (url.pathname === '/api/launch-checkout') {
      await launchCheckoutHandler(request, response)
      return
    }

    await serveStatic(request, response, url)
  } catch (error) {
    console.error(error)
    if (!response.headersSent) {
      sendText(response, 500, 'Internal server error')
    } else {
      response.end()
    }
  }
})

server.listen(port, host, () => {
  console.log(`MiroFish dev server running at http://${host}:${port}/`)
})
