import * as claimLink from '../functions/api/admin/claim-link.js'
import * as analyticsEvents from '../functions/api/analytics/events.js'
import * as authLogin from '../functions/api/auth/login.js'
import * as authLogout from '../functions/api/auth/logout.js'
import * as authMe from '../functions/api/auth/me.js'
import * as authRegister from '../functions/api/auth/register.js'
import * as authStart from '../functions/api/auth/start.js'
import * as authVerify from '../functions/api/auth/verify.js'
import * as checkoutConfirm from '../functions/api/checkout/creem-confirm.js'
import * as consoleData from '../functions/api/console-data.js'
import * as dashboardData from '../functions/api/dashboard-data.js'
import * as launchCheckout from '../functions/api/launch-checkout.js'
import * as bindAccount from '../functions/api/orders/bind-account.js'
import * as orderInstance from '../functions/api/orders/[orderId]/instance.js'
import * as creemWebhook from '../functions/api/webhooks/creem.js'

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function redirectWwwToApex(request) {
  const url = new URL(request.url)
  if (url.hostname !== 'www.mirofish.best') return null
  if (url.pathname.startsWith('/api/')) return null
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) return null

  url.hostname = 'mirofish.best'
  return Response.redirect(url.toString(), 301)
}

function runtimeResponse(request, env) {
  return json({
    ok: true,
    platform: 'cloudflare-workers',
    project: 'my-mirofish-b',
    publicAppOrigin: env.APP_ORIGIN || new URL(request.url).origin,
    paymentProvider: 'creem',
    creemEnv: env.CREEM_ENV || 'live',
    db: Boolean(env.DB),
    timestamp: new Date().toISOString(),
  })
}

function routeHandler(pathname) {
  const routes = [
    ['POST', '/api/admin/claim-link', claimLink],
    ['POST', '/api/analytics/events', analyticsEvents],
    ['POST', '/api/auth/login', authLogin],
    ['POST', '/api/auth/logout', authLogout],
    ['GET', '/api/auth/me', authMe],
    ['POST', '/api/auth/register', authRegister],
    ['POST', '/api/auth/start', authStart],
    ['POST', '/api/auth/verify', authVerify],
    ['POST', '/api/checkout/creem-confirm', checkoutConfirm],
    ['GET', '/api/console-data', consoleData],
    ['GET', '/api/dashboard-data', dashboardData],
    ['POST', '/api/launch-checkout', launchCheckout],
    ['POST', '/api/orders/bind-account', bindAccount],
    ['POST', '/api/webhooks/creem', creemWebhook],
  ]

  return routes.find(([, path]) => path === pathname)
}

async function dispatch(request, env, ctx) {
  const url = new URL(request.url)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  const wwwRedirect = redirectWwwToApex(request)
  if (wwwRedirect) return wwwRedirect

  if (pathname === '/api/runtime') return runtimeResponse(request, env)

  const instanceMatch = pathname.match(/^\/api\/orders\/([a-f0-9]{32})\/instance$/)
  if (instanceMatch) {
    return orderInstance.onRequest({
      request,
      env,
      ctx,
      params: { orderId: instanceMatch[1] },
    })
  }

  const match = routeHandler(pathname)
  if (!match) return json({ message: 'API route not found.' }, 404)

  const [method, , module] = match
  const requestMethod = request.method.toUpperCase()
  if (requestMethod !== method && requestMethod !== 'OPTIONS') {
    return json({ message: 'Method not allowed.' }, 405, { Allow: method })
  }

  return module.onRequest({ request, env, ctx, params: {} })
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await dispatch(request, env, ctx)
    } catch (error) {
      return json({
        message: error instanceof Error ? error.message : 'Unexpected Worker error.',
      }, 500)
    }
  },
}
