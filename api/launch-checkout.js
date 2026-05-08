import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvironment } from '../server-lib/env-loader.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const bodyLimitBytes = 1024 * 1024
const annualDiscountMultiplier = 0.5
const creemProductCache = globalThis.__mirofishCreemProductCache ?? new Map()
globalThis.__mirofishCreemProductCache = creemProductCache

let checkoutEnvironmentLoaded = false

const planCatalog = {
  starter: {
    id: 'starter',
    name: 'Starter',
    currency: 'USD',
    monthlyAmountCents: 900,
    mode: 'checkout',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    currency: 'USD',
    monthlyAmountCents: 2900,
    annualDiscountMultiplier,
    mode: 'checkout',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    currency: 'USD',
    monthlyAmountCents: 5900,
    mode: 'checkout',
  },
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

function formatMoney(amountCents, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
  }).format(amountCents / 100)
}

function loadCheckoutEnvironment() {
  if (checkoutEnvironmentLoaded) {
    return
  }

  const runtimeMode = process.env.NODE_ENV === 'production' || process.env.VERCEL ? 'production' : 'development'
  loadLocalEnvironment({
    projectRoot,
    runtimeMode,
    environment: process.env,
  })
  checkoutEnvironmentLoaded = true
}

function normalizeKey(value) {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function getHeader(request, name) {
  const value = request.headers?.[name.toLowerCase()] ?? request.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

function getConfiguredOrigin() {
  return String(process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .find(Boolean)
}

function getRequestOrigin(request) {
  const configuredOrigin = getConfiguredOrigin()
  if (configuredOrigin) {
    return configuredOrigin
  }

  const forwardedProto = String(getHeader(request, 'x-forwarded-proto') ?? '').split(',')[0].trim()
  const proto = forwardedProto || (request.socket?.encrypted ? 'https' : 'http')
  const host = String(getHeader(request, 'x-forwarded-host') ?? getHeader(request, 'host') ?? 'localhost')
    .split(',')[0]
    .trim()
    .replace(/^127\.0\.0\.1(?=$|:)/, 'localhost')
    .replace(/^\[::1\](?=$|:)/, 'localhost')

  return `${proto}://${host}`.replace(/\/+$/, '')
}

function getDefaultSuccessUrl(request) {
  const configuredSuccessUrl = String(process.env.CREEM_DEFAULT_SUCCESS_URL ?? '').trim()
  if (configuredSuccessUrl) {
    return configuredSuccessUrl
  }

  return `${getRequestOrigin(request)}/`
}

function buildCheckoutSuccessUrl({ request, order, planSelection }) {
  const successUrl = new URL(getDefaultSuccessUrl(request))
  successUrl.searchParams.set('checkout', 'success')
  successUrl.searchParams.set('order', order.id)
  successUrl.searchParams.set('plan', planSelection.selectionId)
  successUrl.searchParams.set('provider', 'creem')
  return successUrl
}

function getCreemSettings() {
  const environmentSetting = String(process.env.CREEM_ENV ?? process.env.CREEM_MODE ?? '').trim().toLowerCase()
  const testApiKey = process.env.API_TEST_KEY ?? process.env.CREEM_TEST_KEY ?? process.env.creem_test_key ?? ''
  const liveApiKey = process.env.API_PROD_KEY ?? process.env.CREEM_API_KEY ?? process.env.CREEM_KEY ?? ''
  const isTestMode =
    environmentSetting === 'test'
      ? true
      : environmentSetting === 'live' || environmentSetting === 'production'
        ? false
        : process.env.NODE_ENV !== 'production' && Boolean(testApiKey)
  const apiKey = isTestMode ? testApiKey : liveApiKey || (process.env.NODE_ENV !== 'production' ? testApiKey : '')
  const baseUrl = process.env.CREEM_BASE_URL ?? (isTestMode ? 'https://test-api.creem.io' : 'https://api.creem.io')

  return {
    apiKey,
    baseUrl,
    isTestMode,
  }
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
    return request.body
  }

  if (typeof request.body === 'string') {
    try {
      return JSON.parse(request.body || '{}')
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON.')
    }
  }

  const chunks = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length

    if (size > bodyLimitBytes) {
      throw new HttpError(413, 'Request body is too large.')
    }

    chunks.push(buffer)
  }

  if (chunks.length === 0) {
    return {}
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.')
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  if (typeof response.status === 'function' && typeof response.json === 'function') {
    response.status(statusCode).json(payload)
    return
  }

  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.end(body)
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const normalizedHeaders = { ...headers }
  const hasContentType = Object.keys(normalizedHeaders).some((key) => key.toLowerCase() === 'content-type')
  if (!hasContentType) {
    normalizedHeaders['Content-Type'] = 'application/json'
  }

  const response = await fetch(url, {
    method,
    headers: normalizedHeaders,
    body: body ? JSON.stringify(body) : undefined,
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      payload?.message ??
      payload?.error ??
      payload?.error_description ??
      payload?.details?.[0]?.description ??
      `Payment request failed with status ${response.status}.`
    throw new HttpError(502, message)
  }

  return payload
}

function getCheckoutUrl(payload) {
  const candidates = [payload?.checkout_url, payload?.checkoutUrl, payload?.url]

  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate).trim()
    }
  }

  const links = Array.isArray(payload?.links) ? payload.links : []
  const checkoutLink = links.find((link) => {
    const rel = String(link?.rel ?? '').toLowerCase()
    return rel === 'checkout' || rel === 'payment' || rel === 'payer-action' || rel === 'approve'
  })

  return typeof checkoutLink?.href === 'string' && checkoutLink.href.trim() ? checkoutLink.href.trim() : null
}

function getCheckoutId(payload) {
  const candidates = [payload?.id, payload?.checkout_id, payload?.checkoutId]

  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate).trim()
    }
  }

  return null
}

function resolvePlanSelection(planSelectionId) {
  const [rawPlanId, rawBillingCycle] = String(planSelectionId || 'pro:annual').trim().split(':')
  const plan = planCatalog[rawPlanId]
  if (!plan) {
    throw new HttpError(400, 'Unknown plan selection.')
  }

  const billingCycle = rawBillingCycle === 'monthly' ? 'monthly' : 'annual'
  if (plan.mode === 'free') {
    return {
      plan,
      planId: plan.id,
      billingCycle,
      selectionId: plan.id,
      amountCents: 0,
      amountLabel: '$0',
      currency: plan.currency,
    }
  }

  if (plan.mode === 'contact') {
    throw new HttpError(400, 'This plan is not available for hosted checkout.')
  }

  const amountCents =
    billingCycle === 'annual'
      ? Math.round(plan.monthlyAmountCents * 12 * (plan.annualDiscountMultiplier || 1))
      : plan.monthlyAmountCents

  return {
    plan,
    planId: plan.id,
    billingCycle,
    selectionId: `${plan.id}:${billingCycle}`,
    amountCents,
    amountLabel: formatMoney(amountCents, plan.currency),
    currency: plan.currency,
  }
}

function getConfiguredCreemProductId(planSelection) {
  const keys = [
    `CREEM_PRODUCT_ID_MIROFISH_${normalizeKey(planSelection.selectionId)}`,
    `CREEM_PRODUCT_ID_MIROFISH_${normalizeKey(planSelection.planId)}`,
    `CREEM_PRODUCT_ID_${normalizeKey(planSelection.selectionId)}`,
    `CREEM_PRODUCT_ID_${normalizeKey(planSelection.planId)}`,
    'CREEM_PRODUCT_ID',
  ]

  for (const key of keys) {
    const value = String(process.env[key] ?? '').trim()
    if (value) {
      return value
    }
  }

  return null
}

async function createCreemCheckout({ order, planSelection, source, request }) {
  const { apiKey, baseUrl, isTestMode } = getCreemSettings()
  const cacheKey = `${isTestMode ? 'test' : 'live'}:${planSelection.selectionId}:${order.amountCents}:${order.currency}`
  const successUrl = buildCheckoutSuccessUrl({ request, order, planSelection })

  if (!apiKey) {
    throw new HttpError(503, 'Creem payment is not configured on this deployment.')
  }

  let productId = getConfiguredCreemProductId(planSelection) ?? creemProductCache.get(cacheKey)

  const headers = {
    'x-api-key': apiKey,
  }

  if (!productId) {
    const defaultSuccessUrl = getDefaultSuccessUrl(request)
    const product = await requestJson(`${baseUrl}/v1/products`, {
      method: 'POST',
      headers,
      body: {
        name: `MiroFish ${planSelection.plan.name} ${planSelection.billingCycle === 'annual' ? 'Annual' : 'Monthly'}`,
        description: `${planSelection.plan.name} plan for MiroFish hosted prediction workflows`,
        price: order.amountCents,
        currency: order.currency,
        billing_type: 'onetime',
        tax_mode: 'inclusive',
        tax_category: 'saas',
        default_success_url: defaultSuccessUrl,
      },
    })

    productId = product.id
    if (!productId) {
      throw new HttpError(502, 'Creem product did not return an id.')
    }

    creemProductCache.set(cacheKey, productId)
  }

  const checkout = await requestJson(`${baseUrl}/v1/checkouts`, {
    method: 'POST',
    headers,
    body: {
      product_id: productId,
      request_id: order.id,
      success_url: successUrl.toString(),
      metadata: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        planId: planSelection.selectionId,
        source: source || 'site',
      },
    },
  })

  const checkoutUrl = getCheckoutUrl(checkout)
  if (!checkoutUrl) {
    throw new HttpError(502, 'Creem checkout did not return a hosted checkout URL.')
  }

  return {
    checkoutUrl,
    creemCheckoutId: getCheckoutId(checkout),
    paymentProvider: 'creem',
  }
}

export default async function handler(request, response) {
  loadCheckoutEnvironment()

  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }

  if (request.method !== 'POST') {
    sendJson(response, 405, { message: 'Method not allowed.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    const planSelection = resolvePlanSelection(body.planId)

    const orderId = randomBytes(16).toString('hex')
    const order = {
      id: orderId,
      orderNumber: `MF-${Date.now().toString(36).toUpperCase()}-${orderId.slice(0, 6).toUpperCase()}`,
      amountCents: planSelection.amountCents,
      amountLabel: planSelection.amountLabel,
      currency: planSelection.currency,
    }

    const checkout = await createCreemCheckout({
      order,
      planSelection,
      source: String(body.source ?? ''),
      request,
    })

    sendJson(response, 200, {
      message: 'Checkout is ready.',
      orderId: order.id,
      orderNumber: order.orderNumber,
      planId: planSelection.selectionId,
      amountCents: order.amountCents,
      amountLabel: order.amountLabel,
      currency: order.currency,
      checkoutUrl: checkout.checkoutUrl,
      paymentProvider: checkout.paymentProvider || 'creem',
      creemCheckoutId: checkout.creemCheckoutId ?? null,
    })
  } catch (error) {
    sendJson(response, error instanceof HttpError ? error.statusCode : 500, {
      message: error instanceof Error ? error.message : 'Checkout could not be started.',
    })
  }
}
